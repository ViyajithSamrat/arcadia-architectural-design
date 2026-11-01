import { beforeEach, describe, expect, it } from "vitest";
import {
  createProofPreviewUrl,
  getPaymentForAdmin,
  listOwnPayments,
  listPaymentQueue,
  rejectPayment,
  submitPayment,
  verifyPayment,
  type EvidenceInput,
} from "@/lib/payments/service";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const QUOTE = "44444444-4444-4444-8444-444444444444";
const PAYMENT = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-18T12:00:00Z");
const ENV = { PAYMENT_MODE: "manual", PAYMENT_UPI_ID: "demo@demo", PAYMENT_INSTRUCTIONS: "DEMO — DO NOT TRANSFER MONEY." };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const project = (patch: Record<string, unknown> = {}) => ({
  id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "AWAITING_PAYMENT",
  requirements_json: {}, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...patch,
});
const quote = (patch: Record<string, unknown> = {}) => ({
  id: QUOTE, project_id: PROJECT, currency: "INR", line_items_json: [], subtotal: 10000, tax_amount: 0, discount_amount: 0,
  total_amount: 12500, pricing_rule_version: "v1", valid_until: null, accepted_at: "2026-10-17T09:00:00Z", created_at: "2026-10-17T08:00:00Z", ...patch,
});
const fields = { utrReference: "UTR123456789", transferDate: "2026-10-18", amount: "12500.00", method: "UPI" };
const png = (name = "receipt.png") => ({ size: PNG.length, name, arrayBuffer: async () => PNG.buffer.slice(0) as ArrayBuffer });
const input = (patch: Partial<EvidenceInput> = {}): EvidenceInput => ({ ...fields, file: null, ...patch });

let userDb: FakeDb;
let serviceDb: FakeDb;
const submit = (patch: Partial<EvidenceInput> = {}, user = ME, env: Record<string, string | undefined> = ENV) =>
  submitPayment(userDb.client(), serviceDb.client(), user, PROJECT, input(patch), { now: NOW, env });

beforeEach(() => {
  userDb = new FakeDb().seed("projects", [project()]).seed("quotes", [quote()]);
  serviceDb = new FakeDb();
});

describe("submitPayment", () => {
  it("records a PENDING claim with only the fields the customer may state, and nothing else", async () => {
    const result = await submit();
    expect(result).toMatchObject({ ok: true });
    const inserts = userDb.writes.filter((w) => w.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("payments");
    expect(Object.keys(inserts[0].payload).sort()).toEqual(
      ["amount_claimed", "currency", "method", "project_id", "proof_storage_path", "quote_id", "transfer_date", "utr_reference"],
    );
    expect(inserts[0].payload).toMatchObject({ project_id: PROJECT, quote_id: QUOTE, currency: "INR", amount_claimed: "12500.00", proof_storage_path: null });
  });

  it("takes quote, currency and project from the server, not from the request", async () => {
    await submit({ ...({ quoteId: "x", currency: "USD", projectId: "y", customer_id: OTHER } as object) });
    expect(userDb.writes[0].payload).toMatchObject({ quote_id: QUOTE, currency: "INR", project_id: PROJECT });
    expect(userDb.writes[0].payload).not.toHaveProperty("customer_id");
  });

  it("ignores a forged status, verified flag or confirmed amount", async () => {
    await submit({ ...({ status: "VERIFIED", verified: true, isPaid: true, confirmed_amount: 12500, verified_by: ME } as object) });
    const payload = userDb.writes[0].payload;
    for (const key of ["status", "verified", "isPaid", "confirmed_amount", "verified_by", "verified_at"]) expect(payload).not.toHaveProperty(key);
  });

  it("stores a real image privately under a random name and links it", async () => {
    const result = await submit({ file: png("my receipt.png") });
    expect(result).toMatchObject({ ok: true });
    expect(userDb.uploads).toHaveLength(1);
    expect(userDb.uploads[0].path).toMatch(new RegExp(`^${PROJECT}/payment-proofs/[0-9a-f-]{36}\\.png$`));
    expect(userDb.uploads[0].path).not.toContain("receipt");
    expect(userDb.uploads[0].contentType).toBe("image/png");
    expect(userDb.writes[0].payload.proof_storage_path).toBe(userDb.uploads[0].path);
  });

  it("uses the detected type, not the file name", async () => {
    await submit({ file: png("evil.jpg") });
    expect(userDb.uploads[0].path.endsWith(".png")).toBe(true);
  });

  it("treats an empty, unnamed file part as no file", async () => {
    const result = await submit({ file: { size: 0, name: "", arrayBuffer: async () => new ArrayBuffer(0) } });
    expect(result).toMatchObject({ ok: true });
    expect(userDb.uploads).toHaveLength(0);
  });

  it.each([
    ["text pretending to be an image", { size: 5, name: "a.png", arrayBuffer: async () => new TextEncoder().encode("hello").buffer as ArrayBuffer }],
    ["a zero-byte named file", { size: 0, name: "a.png", arrayBuffer: async () => new ArrayBuffer(0) }],
    ["an oversized file", { size: 6 * 1024 * 1024, name: "a.png", arrayBuffer: async () => new ArrayBuffer(0) }],
  ])("refuses %s: nothing is uploaded or saved", async (_n, file) => {
    const result = await submit({ file });
    expect(result).toMatchObject({ ok: false, fieldErrors: { evidence: expect.any(String) } });
    expect(userDb.uploads).toHaveLength(0);
    expect(userDb.writes).toHaveLength(0);
  });

  it("refuses invalid fields before touching storage or the database", async () => {
    const result = await submit({ utrReference: "x", amount: "-1", file: png() });
    expect(result).toMatchObject({ ok: false, fieldErrors: { utrReference: expect.any(String), amount: expect.any(String) } });
    expect(userDb.uploads).toHaveLength(0);
    expect(userDb.writes).toHaveLength(0);
  });

  it("does not let someone else submit for a project", async () => {
    const result = await submit({ file: png() }, OTHER);
    expect(result).toMatchObject({ ok: false, message: "We could not find that project." });
    expect(userDb.uploads).toHaveLength(0);
    expect(userDb.writes).toHaveLength(0);
  });

  it.each(["DRAFT", "BRIEF_REVIEW", "BRIEF_APPROVED", "QUOTED", "PAYMENT_PROOF_SUBMITTED", "PAYMENT_VERIFIED", "GENERATING", "READY_FOR_REVIEW", "RELEASED", "CANCELLED"])(
    "refuses a submission while the project is %s",
    async (status) => {
      userDb.tables.projects = [project({ status })];
      expect(await submit({ file: png() })).toMatchObject({ ok: false });
      expect(userDb.uploads).toHaveLength(0);
      expect(userDb.writes).toHaveLength(0);
    },
  );

  it("allows a new submission after a rejection", async () => {
    userDb.tables.projects = [project({ status: "PAYMENT_REJECTED" })];
    expect(await submit()).toMatchObject({ ok: true });
  });

  it("refuses when the quote has not been accepted", async () => {
    userDb.tables.quotes = [quote({ accepted_at: null })];
    expect(await submit()).toMatchObject({ ok: false });
    expect(userDb.writes).toHaveLength(0);
  });

  it("refuses, saying payment instructions are not configured, when they are missing", async () => {
    for (const env of [{}, { PAYMENT_MODE: "manual" }, { ...ENV, PAYMENT_CURRENCY: "USD" }]) {
      const result = await submit({ file: png() }, ME, env);
      expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Payment instructions not configured") });
    }
    expect(userDb.uploads).toHaveLength(0);
    expect(userDb.writes).toHaveLength(0);
  });

  it("removes the uploaded image when the claim cannot be saved", async () => {
    userDb.failNext = { table: "payments", op: "insert" };
    const result = await submit({ file: png() });
    expect(result).toMatchObject({ ok: false, message: "Something went wrong. Please try again." });
    expect(serviceDb.removals).toEqual([userDb.uploads[0].path]);
  });

  it("reports a duplicate pending claim without leaking database detail, and cleans up", async () => {
    userDb.failNext = { table: "payments", op: "insert", code: "23505" };
    const result = await submit({ file: png() });
    expect(result).toMatchObject({ ok: false, message: "Your payment details are already waiting for review." });
    expect(serviceDb.removals).toHaveLength(1);
  });

  it("saves nothing when the upload itself fails", async () => {
    userDb.failUpload = true;
    expect(await submit({ file: png() })).toMatchObject({ ok: false });
    expect(userDb.writes).toHaveLength(0);
  });
});

describe("customer reads", () => {
  it("lists only the payments of the given project, newest first, as camel-cased data without admin fields", async () => {
    userDb.seed("payments", [
      { id: "a", project_id: PROJECT, quote_id: QUOTE, amount_claimed: "100.00", currency: "INR", method: "UPI", utr_reference: "U1", transfer_date: "2026-10-17", proof_storage_path: null, status: "REJECTED", rejection_reason: "Not found", confirmed_amount: null, verified_at: "2026-10-17T10:00:00Z", created_at: "2026-10-17T09:00:00Z", verified_by: ME, audit_note: "secret" },
      { id: "b", project_id: PROJECT, quote_id: QUOTE, amount_claimed: "12500.00", currency: "INR", method: "UPI", utr_reference: "U2", transfer_date: "2026-10-18", proof_storage_path: `${PROJECT}/payment-proofs/x.png`, status: "PENDING_REVIEW", created_at: "2026-10-18T09:00:00Z" },
      { id: "c", project_id: "other", quote_id: QUOTE, created_at: "2026-10-18T10:00:00Z" },
    ]);
    const list = await listOwnPayments(userDb.client(), PROJECT);
    expect(list.map((p) => p.id)).toEqual(["b", "a"]);
    expect(list[0]).toMatchObject({ hasProof: true, status: "PENDING_REVIEW" });
    expect(JSON.stringify(list)).not.toContain("secret");
  });
});

describe("administrator decisions", () => {
  const pending = () => ({ id: PAYMENT, project_id: PROJECT, quote_id: QUOTE, status: "PENDING_REVIEW", quotes: { total_amount: "12500.00" }, created_at: "2026-10-18T09:00:00Z" });
  const ADMIN_OK = { acknowledged: true, confirmedAmount: "12500.00", note: "Seen in the bank statement." };
  let adminDb: FakeDb;
  beforeEach(() => {
    adminDb = new FakeDb().seed("payments", [pending()]);
    adminDb.rpcHandlers.admin_verify_payment = () => ({ data: {} });
    adminDb.rpcHandlers.admin_reject_payment = () => ({ data: {} });
  });

  it("verifies through the database function with the stated, decimal amount", async () => {
    // The project id is returned so the caller can start the generation this decision unlocks.
    expect(await verifyPayment(adminDb.client(), PAYMENT, ADMIN_OK)).toEqual({ ok: true, projectId: PROJECT });
    expect(adminDb.rpcCalls).toEqual([{ name: "admin_verify_payment", args: { p_payment_id: PAYMENT, p_confirmed_amount: "12500.00", p_audit_note: "Seen in the bank statement." } }]);
  });

  it("requires the administrator to confirm they checked the receiving account", async () => {
    expect(await verifyPayment(adminDb.client(), PAYMENT, { ...ADMIN_OK, acknowledged: false })).toMatchObject({ ok: false });
    expect(await verifyPayment(adminDb.client(), PAYMENT, { ...ADMIN_OK, acknowledged: "yes" as never })).toMatchObject({ ok: false });
    expect(adminDb.rpcCalls).toHaveLength(0);
  });

  it.each(["", "abc", "12499.99", "12500.01", "-12500", "1250"])("refuses to verify with a confirmed amount of %j", async (amount) => {
    const result = await verifyPayment(adminDb.client(), PAYMENT, { ...ADMIN_OK, confirmedAmount: amount });
    expect(result).toMatchObject({ ok: false });
    expect(adminDb.rpcCalls).toHaveLength(0);
  });

  it("refuses a payment that is already decided, without calling the database function", async () => {
    adminDb.tables.payments = [{ ...pending(), status: "VERIFIED" }];
    expect(await verifyPayment(adminDb.client(), PAYMENT, ADMIN_OK)).toMatchObject({ ok: false, message: expect.stringContaining("already been decided") });
    expect(adminDb.rpcCalls).toHaveLength(0);
  });

  it("turns database refusals into safe messages (second decision, non-administrator)", async () => {
    adminDb.rpcHandlers.admin_verify_payment = () => ({ error: { code: "P0002", message: "payment not found or not awaiting review (internal)" } });
    const second = await verifyPayment(adminDb.client(), PAYMENT, ADMIN_OK);
    expect(second).toMatchObject({ ok: false, message: expect.stringContaining("already been decided") });
    adminDb.rpcHandlers.admin_verify_payment = () => ({ error: { code: "42501", message: "administrator access required" } });
    const denied = await verifyPayment(adminDb.client(), PAYMENT, ADMIN_OK);
    expect(denied).toMatchObject({ ok: false });
    expect(JSON.stringify([second, denied])).not.toContain("internal");
  });

  it("rejects with a required reason, passing reason and note separately", async () => {
    expect(await rejectPayment(adminDb.client(), PAYMENT, { reason: "   ", note: "" })).toMatchObject({ ok: false });
    expect(await rejectPayment(adminDb.client(), PAYMENT, { reason: "x".repeat(501), note: "" })).toMatchObject({ ok: false });
    expect(adminDb.rpcCalls).toHaveLength(0);
    expect(await rejectPayment(adminDb.client(), PAYMENT, { reason: "No matching credit found.", note: "checked 18 Oct" })).toEqual({ ok: true });
    expect(adminDb.rpcCalls[0]).toEqual({ name: "admin_reject_payment", args: { p_payment_id: PAYMENT, p_reason: "No matching credit found.", p_audit_note: "checked 18 Oct" } });
  });

  it("refuses malformed ids", async () => {
    expect(await verifyPayment(adminDb.client(), "not-an-id", ADMIN_OK)).toMatchObject({ ok: false });
    expect(await rejectPayment(adminDb.client(), "../x", { reason: "No credit", note: "" })).toMatchObject({ ok: false });
    expect(adminDb.rpcCalls).toHaveLength(0);
  });

  it("never sends a status, verifier or timestamp: those are set by the database", async () => {
    await verifyPayment(adminDb.client(), PAYMENT, ADMIN_OK);
    await rejectPayment(adminDb.client(), PAYMENT, { reason: "No credit", note: "" });
    for (const call of adminDb.rpcCalls) {
      expect(Object.keys(call.args).every((k) => ["p_payment_id", "p_confirmed_amount", "p_audit_note", "p_reason"].includes(k))).toBe(true);
    }
    expect(adminDb.writes).toHaveLength(0);
  });
});

describe("administrator reads", () => {
  it("builds the queue from two reads, pending oldest first", async () => {
    const db = new FakeDb().seed("payments", [
      { id: "p2", project_id: PROJECT, quote_id: QUOTE, status: "PENDING_REVIEW", created_at: "2026-10-18T10:00:00Z", projects: { project_type: "INTERIOR", status: "PAYMENT_PROOF_SUBMITTED", customer_id: ME }, quotes: [{ total_amount: "500.00" }] },
      { id: "p1", project_id: PROJECT, quote_id: QUOTE, status: "PENDING_REVIEW", created_at: "2026-10-18T09:00:00Z", projects: { project_type: "EMPTY_PLOT", status: "PAYMENT_PROOF_SUBMITTED", customer_id: ME }, quotes: { total_amount: "12500.00" } },
      { id: "v1", project_id: PROJECT, quote_id: QUOTE, status: "VERIFIED", created_at: "2026-10-17T09:00:00Z", verified_at: "2026-10-17T10:00:00Z" },
    ]);
    const queue = await listPaymentQueue(db.client());
    expect(queue.pending.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(queue.pending[0]).toMatchObject({ quoteTotal: 12500, projectType: "EMPTY_PLOT", customerId: ME });
    expect(queue.pending[1].quoteTotal).toBe(500);
    expect(queue.decided.map((p) => p.id)).toEqual(["v1"]);
  });

  it("reads the admin-only columns with the trusted client", async () => {
    const adminDb = new FakeDb().seed("payments", [{ id: PAYMENT, project_id: PROJECT, quote_id: QUOTE, status: "VERIFIED", created_at: "2026-10-18T09:00:00Z", proof_storage_path: `${PROJECT}/payment-proofs/x.png` }]);
    const trusted = new FakeDb().seed("payments", [{ id: PAYMENT, verified_by: OTHER, audit_note: "checked" }]);
    const detail = await getPaymentForAdmin(adminDb.client(), trusted.client(), PAYMENT);
    expect(detail).toMatchObject({ id: PAYMENT, verifiedBy: OTHER, auditNote: "checked", proofPath: `${PROJECT}/payment-proofs/x.png` });
    expect(await getPaymentForAdmin(adminDb.client(), trusted.client(), "nope")).toBeNull();
  });
});

describe("proof preview links", () => {
  const db = () => new FakeDb();
  it("expire after 60 seconds", async () => {
    const d = db();
    const url = await createProofPreviewUrl(d.client(), { projectId: PROJECT, proofPath: `${PROJECT}/payment-proofs/x.png` });
    expect(url).toContain("t=60");
    expect(d.signed).toEqual([{ path: `${PROJECT}/payment-proofs/x.png`, seconds: 60 }]);
  });

  it.each([
    ["no proof", null],
    ["another project's path", `${OTHER}/payment-proofs/x.png`],
    ["a generated file", `${PROJECT}/generated/x.png`],
    ["a reference file", `${PROJECT}/references/x.png`],
    ["a traversal path", `${PROJECT}/payment-proofs/../generated/x.png`],
  ])("are not created for %s", async (_n, proofPath) => {
    const d = db();
    expect(await createProofPreviewUrl(d.client(), { projectId: PROJECT, proofPath })).toBeNull();
    expect(d.signed).toHaveLength(0);
  });
});
