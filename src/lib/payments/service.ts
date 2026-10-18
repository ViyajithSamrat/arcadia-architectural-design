import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PAYMENT_CUSTOMER_COLUMNS, type PaymentMethod, type PaymentStatus, type ProjectStatus } from "@/lib/db/schema";
import { getLatestQuote, getOwnedProject } from "@/lib/journeys/service";
import { minorToDecimal, toMinor } from "@/lib/journeys/money";
import { buildObjectPath, newObjectName, parseObjectPath, PROJECT_FILES_BUCKET } from "@/lib/storage/paths";
import { getPaymentDisplay, PAYMENT_NOT_CONFIGURED } from "./config";
import {
  checkEvidenceFile,
  limitedText,
  NOTE_MAX,
  parseAmountToMinor,
  parseEvidenceFields,
  REASON_MAX,
  type RawEvidenceFields,
} from "./evidence";

/**
 * Payment evidence and the administrator's decision. The rules, in order of importance:
 *
 *  - A submission is a CLAIM. It creates a PENDING_REVIEW payment and nothing else; the
 *    browser cannot send a status, a verified flag, an owner or an amount to trust.
 *  - Only an administrator's own session can verify or reject, through the database
 *    functions that re-check the role. The service role is never used for a decision.
 *  - Ownership and workflow state are re-checked here on every call; the database guards
 *    (supabase/migrations/..._workflow_guards.sql) remain the last line of defence.
 * Messages are written for people and never contain database details.
 */

export type ServiceResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

const fail = (message: string, fieldErrors?: Record<string, string>) => ({ ok: false as const, message, ...(fieldErrors ? { fieldErrors } : {}) });

const GENERIC = "Something went wrong. Please try again.";
const NOT_FOUND = "We could not find that project.";
const PAYMENT_NOT_FOUND = "We could not find that payment.";

type Client = SupabaseClient;
type DbError = { code?: string } | null | undefined;
const code = (error: DbError) => error?.code ?? "";

// ---------------------------------------------------------------------------
// Customer: reading
// ---------------------------------------------------------------------------

export type CustomerPayment = {
  id: string;
  quoteId: string;
  amountClaimed: number;
  currency: string;
  method: PaymentMethod;
  utrReference: string;
  transferDate: string;
  hasProof: boolean;
  status: PaymentStatus;
  rejectionReason: string | null;
  confirmedAmount: number | null;
  verifiedAt: string | null;
  createdAt: string;
};

function toCustomerPayment(row: Record<string, unknown>): CustomerPayment {
  return {
    id: String(row.id),
    quoteId: String(row.quote_id),
    amountClaimed: Number(row.amount_claimed),
    currency: String(row.currency),
    method: row.method as PaymentMethod,
    utrReference: String(row.utr_reference),
    transferDate: String(row.transfer_date),
    hasProof: typeof row.proof_storage_path === "string" && row.proof_storage_path.length > 0,
    status: row.status as PaymentStatus,
    rejectionReason: typeof row.rejection_reason === "string" ? row.rejection_reason : null,
    confirmedAmount: row.confirmed_amount === null || row.confirmed_amount === undefined ? null : Number(row.confirmed_amount),
    verifiedAt: typeof row.verified_at === "string" ? row.verified_at : null,
    createdAt: String(row.created_at),
  };
}

/** The customer's own payment claims for a project, newest first. Never selects admin-only columns. */
export async function listOwnPayments(supabase: Client, projectId: string): Promise<CustomerPayment[]> {
  const { data, error } = await supabase
    .from("payments")
    .select(PAYMENT_CUSTOMER_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error || !data) return [];
  return (data as unknown as Record<string, unknown>[]).map(toCustomerPayment);
}

// ---------------------------------------------------------------------------
// Customer: submitting evidence
// ---------------------------------------------------------------------------

export type EvidenceInput = RawEvidenceFields & {
  /** The receipt image, if one was chosen. Optional by design (PR-013). */
  file: { size: number; name?: string; arrayBuffer(): Promise<ArrayBuffer> } | null;
};

const SUBMITTABLE: readonly ProjectStatus[] = ["AWAITING_PAYMENT", "PAYMENT_REJECTED"];

/**
 * @param supabase the customer's own session client (row level security applies)
 * @param service  trusted client, used only to remove a file this call itself uploaded
 *                 when the payment row could not be saved
 */
export async function submitPayment(
  supabase: Client,
  service: Client,
  userId: string,
  projectId: string,
  input: EvidenceInput,
  options: { now?: Date; env?: Record<string, string | undefined> } = {},
): Promise<ServiceResult<{ paymentId: string }>> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return fail(NOT_FOUND);

  if (project.status === "PAYMENT_PROOF_SUBMITTED") return fail("Your payment details are already waiting for review.");
  if (!SUBMITTABLE.includes(project.status)) return fail("Payment details can be submitted only after you accept your quote.");

  const quote = await getLatestQuote(supabase, projectId);
  if (!quote || !quote.acceptedAt) return fail("Payment details can be submitted only for an accepted quote.");

  // The instructions must be ready: without them nobody knows where to pay.
  if (getPaymentDisplay(quote.currency, options.env).state !== "ready") return fail(`${PAYMENT_NOT_CONFIGURED}. Do not transfer any money yet.`);

  const fields = parseEvidenceFields(input, { now: options.now ?? new Date(), acceptedAt: quote.acceptedAt });
  if (!fields.ok) return fail("Please check the highlighted fields.", fields.fieldErrors);

  // An empty file part is what a browser sends when no file was chosen.
  const file = input.file && !(input.file.size === 0 && !input.file.name) ? input.file : null;
  let upload: { path: string; bytes: Uint8Array; mime: string } | null = null;
  if (file) {
    const checked = await checkEvidenceFile(file);
    if (!checked.ok) return fail(checked.message, { evidence: checked.message });
    upload = { path: buildObjectPath(projectId, "payment-proofs", newObjectName(checked.image.ext)), bytes: checked.bytes, mime: checked.image.mime };
  }

  if (upload) {
    // As the customer: the storage policy re-checks ownership and that payment is due.
    const stored = await supabase.storage.from(PROJECT_FILES_BUCKET).upload(upload.path, upload.bytes, { contentType: upload.mime, upsert: false });
    if (stored.error) return fail("The image could not be uploaded. Please try again.");
  }

  // The row carries no status, owner or decision: the database sets and guards those.
  const { data, error } = await supabase
    .from("payments")
    .insert({
      project_id: projectId,
      quote_id: quote.id,
      amount_claimed: fields.value.amountClaimed,
      currency: quote.currency,
      method: fields.value.method,
      utr_reference: fields.value.utrReference,
      transfer_date: fields.value.transferDate,
      proof_storage_path: upload?.path ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (upload) await removeOwnUpload(service, upload.path);
    if (code(error) === "23505") return fail("Your payment details are already waiting for review.");
    if (code(error) === "42501" || code(error) === "23514") return fail("Payment details cannot be submitted for this project right now.");
    return fail(GENERIC);
  }
  return { ok: true, paymentId: String((data as { id: unknown }).id) };
}

/** Removes a file this request just uploaded. Failure is tolerated: the file is private and unreferenced. */
async function removeOwnUpload(service: Client, path: string): Promise<void> {
  try {
    await service.storage.from(PROJECT_FILES_BUCKET).remove([path]);
  } catch {
    // Nothing more can be done here; the object is private and nothing points at it.
  }
}

// ---------------------------------------------------------------------------
// Administrator: reading (callers must have passed requireAdmin)
// ---------------------------------------------------------------------------

export type QueueItem = CustomerPayment & {
  projectId: string;
  projectType: string;
  projectStatus: string;
  customerId: string;
  quoteTotal: number | null;
};

const ADMIN_SELECT = `${PAYMENT_CUSTOMER_COLUMNS}, projects(project_type, status, customer_id), quotes(total_amount)`;

const one = <T,>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

function toQueueItem(row: Record<string, unknown>): QueueItem {
  const project = one(row.projects as Record<string, unknown> | Record<string, unknown>[] | null);
  const quote = one(row.quotes as Record<string, unknown> | Record<string, unknown>[] | null);
  return {
    ...toCustomerPayment(row),
    projectId: String(row.project_id),
    projectType: project ? String(project.project_type) : "",
    projectStatus: project ? String(project.status) : "",
    customerId: project ? String(project.customer_id) : "",
    quoteTotal: quote ? Number(quote.total_amount) : null,
  };
}

const DECIDED_LIMIT = 20;

/**
 * Pending claims, oldest first, and the most recent decisions (newest submission first).
 * Three reads in total however many payments exist: project and quote come embedded, and
 * each decided status is read on its own so the (status, created_at) index serves the
 * ordering instead of a scan.
 * @param supabase the administrator's own session client: row level security decides what it can read
 */
export async function listPaymentQueue(supabase: Client): Promise<{ pending: QueueItem[]; decided: QueueItem[] }> {
  const read = (status: PaymentStatus, ascending: boolean, limit: number) =>
    supabase.from("payments").select(ADMIN_SELECT).eq("status", status).order("created_at", { ascending }).limit(limit);
  const [pending, verified, rejected] = await Promise.all([read("PENDING_REVIEW", true, 100), read("VERIFIED", false, DECIDED_LIMIT), read("REJECTED", false, DECIDED_LIMIT)]);
  const rows = (r: { data: unknown }) => ((r.data ?? []) as unknown as Record<string, unknown>[]).map(toQueueItem);
  const decided = [...rows(verified), ...rows(rejected)].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, DECIDED_LIMIT);
  return { pending: rows(pending), decided };
}

export type AdminPaymentDetail = QueueItem & {
  proofPath: string | null;
  /** From admin-only columns, read with the trusted client. Null while pending. */
  verifiedBy: string | null;
  auditNote: string | null;
};

/**
 * One payment. `verified_by` and `audit_note` have no column grant for any session role, so
 * they come from the trusted client; call this only after requireAdmin.
 */
export async function getPaymentForAdmin(supabase: Client, trusted: Client, paymentId: string): Promise<AdminPaymentDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return null;
  const { data, error } = await supabase.from("payments").select(ADMIN_SELECT).eq("id", paymentId).maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as Record<string, unknown>;
  const admin = await trusted.from("payments").select("verified_by, audit_note").eq("id", paymentId).maybeSingle();
  return {
    ...toQueueItem(row),
    proofPath: typeof row.proof_storage_path === "string" ? row.proof_storage_path : null,
    verifiedBy: admin.data && typeof admin.data.verified_by === "string" ? admin.data.verified_by : null,
    auditNote: admin.data && typeof admin.data.audit_note === "string" ? admin.data.audit_note : null,
  };
}

export const PROOF_URL_SECONDS = 60;

/**
 * A short-lived link to the receipt image, made with the administrator's own session so
 * the storage policy decides. The path must be this payment's own proof, in its project.
 */
export async function createProofPreviewUrl(supabase: Client, payment: { projectId: string; proofPath: string | null }): Promise<string | null> {
  if (!payment.proofPath) return null;
  const parsed = parseObjectPath(payment.proofPath);
  if (!parsed || parsed.kind !== "payment-proofs" || parsed.projectId.toLowerCase() !== payment.projectId.toLowerCase()) return null;
  const { data, error } = await supabase.storage.from(PROJECT_FILES_BUCKET).createSignedUrl(payment.proofPath, PROOF_URL_SECONDS);
  return error || !data ? null : data.signedUrl;
}

// ---------------------------------------------------------------------------
// Administrator: deciding (callers must have passed requireAdmin)
// ---------------------------------------------------------------------------

function decisionFailure(error: DbError): ServiceResult<never> {
  switch (code(error)) {
    case "P0002":
      return fail("This payment has already been decided, or is no longer awaiting review.");
    case "42501":
      return fail("You do not have access to decide payments.");
    case "23514":
      return fail("The confirmed amount must equal the full quoted total. If it does not, reject the payment instead.");
    default:
      return fail(GENERIC);
  }
}

/**
 * Verifies a payment. The administrator must state the amount actually received; it has
 * to equal the accepted quote's total, which the database also enforces.
 * @param supabase the administrator's OWN session client (never the service role)
 */
export async function verifyPayment(
  supabase: Client,
  paymentId: string,
  input: { confirmedAmount: unknown; note: unknown; acknowledged: boolean },
): Promise<ServiceResult> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return fail(PAYMENT_NOT_FOUND);
  if (input.acknowledged !== true) return fail("Confirm that you checked the receiving account before verifying.");
  const minor = typeof input.confirmedAmount === "string" ? parseAmountToMinor(input.confirmedAmount) : null;
  if (minor === null) return fail("Enter the amount received, for example 12500.00.", { confirmedAmount: "Enter the amount received." });
  const note = limitedText(input.note, NOTE_MAX);
  if (note === null) return fail(`The note must be ${NOTE_MAX} characters or fewer.`, { note: "Too long." });

  const { data: payment, error } = await supabase
    .from("payments")
    .select("id, status, quotes(total_amount)")
    .eq("id", paymentId)
    .maybeSingle();
  if (error || !payment) return fail(PAYMENT_NOT_FOUND);
  if (payment.status !== "PENDING_REVIEW") return decisionFailure({ code: "P0002" });
  const quote = one(payment.quotes as { total_amount: unknown } | { total_amount: unknown }[] | null);
  if (!quote || toMinor(String(quote.total_amount)) !== minor) return decisionFailure({ code: "23514" });

  const result = await supabase.rpc("admin_verify_payment", {
    p_payment_id: paymentId,
    p_confirmed_amount: minorToDecimal(minor),
    p_audit_note: note || null,
  });
  return result.error ? decisionFailure(result.error) : { ok: true };
}

/**
 * Rejects a payment. The reason is stored on the payment and shown to the customer, so it
 * must be written for them; the separate note stays internal.
 */
export async function rejectPayment(
  supabase: Client,
  paymentId: string,
  input: { reason: unknown; note: unknown },
): Promise<ServiceResult> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return fail(PAYMENT_NOT_FOUND);
  const reason = limitedText(input.reason, REASON_MAX);
  if (reason === null) return fail(`The reason must be ${REASON_MAX} characters or fewer.`, { reason: "Too long." });
  if (reason.length < 3) return fail("Give a reason the customer can act on.", { reason: "A reason is required." });
  const note = limitedText(input.note, NOTE_MAX);
  if (note === null) return fail(`The note must be ${NOTE_MAX} characters or fewer.`, { note: "Too long." });

  const result = await supabase.rpc("admin_reject_payment", {
    p_payment_id: paymentId,
    p_reason: reason,
    p_audit_note: note || null,
  });
  return result.error ? decisionFailure(result.error) : { ok: true };
}
