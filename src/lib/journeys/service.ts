import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EDITABLE_PROJECT_STATUSES, type ProjectRow, type ProjectStatus, type ProjectType } from "@/lib/db/schema";
import {
  BRIEF_MAX_TEXT,
  getBriefProvider,
  parseBrief,
  BriefProviderUnavailableError,
  type Brief,
  type BriefProvider,
} from "./brief";
import { refusalMessage, withUsage } from "@/lib/providers/budget";
import { containsMockTranscript } from "@/lib/providers/mock-speech";
import { MOCK_BRIEF_REFUSED, MOCK_DESCRIPTION_REFUSED } from "@/lib/voice/copy";
import { TRANSCRIPT_TOKEN_MAX_CHARS, transcriptVerificationKeys, verifyTranscriptToken, type TranscriptClaims } from "@/lib/voice/provenance";
import { minorToDecimal } from "./money";
import {
  computeQuote,
  PricingRuleSchema,
  QuoteLineItemSchema,
  type ComputedQuote,
  type PricingRule,
  type QuoteLineItem,
} from "./quote";
import { findStep, JOURNEY_STEPS } from "./steps";
import { validateRequirements, validateStep, type StepData } from "./validation";
import { isLiveTranscriptionWired } from "./voice";

/**
 * The customer journey's server-side rules. Every function:
 *  - receives the user-session client (row level security applies) and, where a
 *    status or quote must change, the trusted service client;
 *  - re-checks that the signed-in user OWNS the project (an administrator can read
 *    other people's rows through RLS, so RLS alone is not enough here);
 *  - re-checks the project's current status and refuses invalid moves;
 *  - changes the status with a conditional update (`status = <expected>`), so two
 *    simultaneous requests cannot both apply the same transition.
 * The database guards remain the last line of defence and are never bypassed.
 * Messages are written for customers and never contain database details.
 */

export type ServiceResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; message: string; fieldErrors?: Record<string, string>; missing?: string[] };

const fail = (message: string, extra?: { fieldErrors?: Record<string, string>; missing?: string[] }) =>
  ({ ok: false as const, message, ...extra });

const GENERIC = "Something went wrong. Please try again.";
const NOT_FOUND = "We could not find that project.";

type Client = SupabaseClient;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getOwnedProject(supabase: Client, userId: string, projectId: string): Promise<ProjectRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const { data, error } = await supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  if (error || !data) return null;
  const project = data as ProjectRow;
  return project.customer_id === userId ? project : null;
}

export type ProjectSummary = Pick<ProjectRow, "id" | "project_type" | "status" | "created_at" | "updated_at">;

export async function listOwnProjects(supabase: Client, userId: string): Promise<ProjectSummary[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, project_type, status, created_at, updated_at")
    .eq("customer_id", userId)
    .order("updated_at", { ascending: false })
    .limit(50);
  return error || !data ? [] : (data as ProjectSummary[]);
}

export type StoredQuote = {
  id: string;
  currency: string;
  lines: QuoteLineItem[];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  pricingRuleVersion: string;
  validUntil: string | null;
  acceptedAt: string | null;
};

/** The newest quote for a project the user owns, parsed from what is stored. */
export async function getLatestQuote(supabase: Client, projectId: string): Promise<StoredQuote | null> {
  const { data, error } = await supabase
    .from("quotes")
    .select("id, currency, line_items_json, subtotal, tax_amount, discount_amount, total_amount, pricing_rule_version, valid_until, accepted_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const lines = QuoteLineItemSchema.array().safeParse(data.line_items_json);
  if (!lines.success) return null;
  return {
    id: String(data.id),
    currency: String(data.currency),
    lines: lines.data,
    subtotal: Number(data.subtotal),
    taxAmount: Number(data.tax_amount),
    discountAmount: Number(data.discount_amount),
    totalAmount: Number(data.total_amount),
    pricingRuleVersion: String(data.pricing_rule_version),
    validUntil: data.valid_until ? String(data.valid_until) : null,
    acceptedAt: data.accepted_at ? String(data.accepted_at) : null,
  };
}

/** The stored brief, only if it still parses. A brief that does not parse is treated as absent. */
export function readStoredBrief(project: Pick<ProjectRow, "english_brief_json">): Brief | null {
  if (!project.english_brief_json) return null;
  const parsed = parseBrief(project.english_brief_json);
  return parsed.ok ? parsed.brief : null;
}

// ---------------------------------------------------------------------------
// Draft and requirements
// ---------------------------------------------------------------------------

export async function createDraftProject(supabase: Client, userId: string, type: ProjectType): Promise<ServiceResult<{ projectId: string }>> {
  const { data, error } = await supabase
    .from("projects")
    // source_language is left to the database default ('en'): customers may not set it.
    .insert({ customer_id: userId, project_type: type, requirements_json: { schemaVersion: 1 } })
    .select("id")
    .single();
  if (error || !data) return fail("We could not start your project. Please try again.");
  return { ok: true, projectId: String(data.id) };
}

/**
 * A voice transcript the customer chose to use for the description: the text as it came back
 * (`original`), the text "Use this text" put into the description (`used`, after any edits in
 * the transcript box), and the provenance token the transcribe route signed over `original`.
 * The source and language are read from the verified token only, never from the browser.
 */
export type TranscriptInput = { original: string; used: string; provenance: string };

const TRANSCRIPT_MAX_CHARS = 5000;

/** A trimmed, non-empty string of at most 5,000 characters, or null. */
function transcriptText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length === 0 || text.length > TRANSCRIPT_MAX_CHARS ? null : text;
}

/**
 * Validates the SHAPE of an untrusted transcript payload: the text as it came back, the text
 * put into the description, and a provenance token of bounded size. Anything else is null.
 * Whether the token is genuine is decided in saveStep, against the signed-in user and project.
 */
export function readTranscriptInput(value: unknown): TranscriptInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { original, used, provenance } = value as Record<string, unknown>;
  const originalText = transcriptText(original);
  const usedText = transcriptText(used);
  if (originalText === null || usedText === null) return null;
  if (typeof provenance !== "string" || provenance.length === 0 || provenance.length > TRANSCRIPT_TOKEN_MAX_CHARS) return null;
  return { original: originalText, used: usedText, provenance };
}

/** A transcript whose provenance token verified: its text and what the server signed about it. */
type VerifiedTranscript = { original: string; claims: TranscriptClaims };

/** The language a project has unless a live transcript says otherwise (what createDraftProject sets). */
const DEFAULT_SOURCE_LANGUAGE = "en";

type TranscriptColumns = { transcript_original: string | null; transcript_corrected: string | null; source_language: string };

/**
 * The transcript and language columns after a description save, so none of them is left stale:
 *  - With a chosen transcript whose provenance verified: the text as it came back and the
 *    description as saved. The language comes from the signed claims only, and only when a
 *    live speech service is wired, the server signed it as a Gnani transcript and the text is
 *    not the mock; a mock (all of R1-A) or demo-only selection never claims a language.
 *  - Without one, while the description still equals the saved transcript's corrected text:
 *    the transcript is kept (and its language only if it could have been live).
 *  - Without one, once the description was replaced by typing: the transcript is cleared and
 *    the language goes back to the default, as for any typed description.
 */
function descriptionColumns(project: ProjectRow, saved: string | null, voice: VerifiedTranscript | undefined, liveTranscription: boolean): TranscriptColumns {
  if (voice) {
    const { source, sourceLanguage } = voice.claims;
    const trusted = liveTranscription && source === "gnani" && sourceLanguage !== null && !containsMockTranscript(voice.original);
    return { transcript_original: voice.original, transcript_corrected: saved, source_language: trusted && sourceLanguage ? sourceLanguage : DEFAULT_SOURCE_LANGUAGE };
  }
  const original = project.transcript_original ?? null;
  if (original !== null && saved === (project.transcript_corrected ?? null)) {
    const language = liveTranscription ? (project.source_language ?? DEFAULT_SOURCE_LANGUAGE) : DEFAULT_SOURCE_LANGUAGE;
    return { transcript_original: original, transcript_corrected: saved, source_language: language };
  }
  return { transcript_original: null, transcript_corrected: null, source_language: DEFAULT_SOURCE_LANGUAGE };
}

export async function saveStep(
  supabase: Client,
  userId: string,
  projectId: string,
  stepId: string,
  raw: StepData,
  transcript?: TranscriptInput,
  options: {
    liveTranscription?: boolean;
    /** Checks a provenance token; by default against VOICE_TRANSCRIPT_SECRET and this process's mock key. */
    verifyTranscript?: (token: string, expected: { userId: string; projectId: string; transcript: string }) => TranscriptClaims | null;
    /**
     * The trusted client for the description step. Customers cannot write the transcript and
     * language columns (migration 20261021000100), so that step is saved by the server, after
     * the ownership, status and provenance checks above, in one conditional update.
     */
    service?: () => Client;
  } = {},
): Promise<ServiceResult<{ nextStepId: string | null }>> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return fail(NOT_FOUND);
  if (!EDITABLE_PROJECT_STATUSES.includes(project.status)) return fail("This project can no longer be edited.");
  const step = findStep(project.project_type, stepId);
  if (!step) return fail("That step does not exist.");
  const voice = transcript === undefined ? undefined : readTranscriptInput(transcript);
  if (voice === null || (voice && !step.isDescription)) return fail("That request was not valid.");

  const result = validateStep(step, raw);
  if (!result.ok) return fail("Please fix the highlighted answers.", { fieldErrors: result.errors });

  const text = step.isDescription ? (result.data as Record<string, unknown>).text : undefined;
  // The mock placeholder is never saved as the customer's description, whatever the screen did.
  if (containsMockTranscript(text)) return fail("Please fix the highlighted answers.", { fieldErrors: { text: MOCK_DESCRIPTION_REFUSED } });

  const stored = typeof project.requirements_json === "object" && project.requirements_json ? project.requirements_json : {};
  const update: Record<string, unknown> = { requirements_json: { ...stored, schemaVersion: 1, [stepId]: result.data } };
  if (step.isDescription) {
    // Only columns whose value changes are written, so a typed save on a project that never
    // used voice writes exactly what it did before. The status is never touched here.
    const saved = typeof text === "string" && text.trim().length > 0 ? text : null;
    // A transcript counts only while the description is still exactly the text it put there,
    // and only with a genuine, unexpired token issued to this user for this project and this
    // exact text. Otherwise the save is a typed save: nothing the browser sent is stored as a
    // transcript, so it cannot pass typed text off as a speech service's output.
    const chosen = voice && saved === voice.used ? voice : undefined;
    const verify = options.verifyTranscript ?? ((token, expected) => verifyTranscriptToken(token, expected, transcriptVerificationKeys()));
    const claims = chosen ? verify(chosen.provenance, { userId, projectId: project.id, transcript: chosen.original }) : null;
    const verified = chosen && claims ? { original: chosen.original, claims } : undefined;
    const columns = descriptionColumns(project, saved, verified, options.liveTranscription ?? isLiveTranscriptionWired());
    if ((project.transcript_original ?? null) !== columns.transcript_original) update.transcript_original = columns.transcript_original;
    if ((project.transcript_corrected ?? null) !== columns.transcript_corrected) update.transcript_corrected = columns.transcript_corrected;
    if ((project.source_language ?? DEFAULT_SOURCE_LANGUAGE) !== columns.source_language) update.source_language = columns.source_language;
  }
  // Changing an answer makes any earlier brief out of date, so it is cleared.
  if (project.english_brief_json || project.english_brief_text) {
    update.english_brief_json = null;
    update.english_brief_text = null;
  }
  // Other steps keep the customer's own session (row level security applies). The description
  // step goes through the trusted client; the same id, owner and status conditions make it
  // one atomic write that refuses a project changed or locked since it was read.
  let writer: Client = supabase;
  if (step.isDescription) {
    if (!options.service) return fail(GENERIC);
    try {
      writer = options.service();
    } catch {
      return fail(GENERIC);
    }
  }
  const { data, error } = await writer
    .from("projects")
    .update(update)
    .eq("id", project.id)
    .eq("customer_id", userId)
    .eq("status", project.status)
    .select("id");
  if (error || !data || data.length !== 1) return fail(GENERIC);

  return { ok: true, nextStepId: nextStepId(project.project_type, stepId) };
}

function nextStepId(type: ProjectType, stepId: string): string | null {
  const steps = JOURNEY_STEPS[type];
  const i = steps.findIndex((s) => s.id === stepId);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1].id : null;
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export async function createBrief(
  supabase: Client,
  service: Client,
  userId: string,
  projectId: string,
  provider: BriefProvider | (() => BriefProvider) = () => getBriefProvider(process.env.PROVIDER_MODE),
): Promise<ServiceResult> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return fail(NOT_FOUND);
  if (!EDITABLE_PROJECT_STATUSES.includes(project.status)) return fail("The brief can no longer be changed.");

  const check = validateRequirements(project.project_type, project.requirements_json);
  if (!check.complete) {
    return fail("Some required answers are missing, so the brief cannot be created yet.", { missing: check.missingRequiredFields });
  }
  // A placeholder is not the customer's words: it never reaches any brief writer.
  if (containsMockTranscript(check.requirements.description?.text)) return fail(MOCK_BRIEF_REFUSED);

  let produced: unknown;
  try {
    const p = typeof provider === "function" ? provider() : provider;
    const input = { projectType: project.project_type, sourceLanguage: project.source_language ?? "en", requirements: check.requirements };
    if (p.usage) {
      // A provider that costs something or is rate limited: reserve its usage first. If the
      // reservation is refused (or cannot be made) nothing is called.
      const guarded = await withUsage(service, { customerId: userId, projectId }, p.usage, (hooks) => p.generate(input, hooks));
      if (!guarded.ok) return fail(refusalMessage(guarded.reason));
      produced = guarded.value;
    } else {
      produced = await p.generate(input);
    }
  } catch (error) {
    if (error instanceof BriefProviderUnavailableError) return fail(error.message);
    return fail("The brief could not be created. Please try again.");
  }

  const parsed = parseBrief(produced);
  if (!parsed.ok) return fail("The brief came back in an unexpected form and was not used. Please try again.");

  // The server, not the producer, decides what is missing and which answers were used.
  const brief: Brief = {
    ...parsed.brief,
    projectType: project.project_type,
    requirements: check.requirements,
    missingRequiredFields: [],
  };

  const update: Record<string, unknown> = { english_brief_json: brief, english_brief_text: brief.englishBrief };
  if (project.status === "DRAFT") update.status = "BRIEF_REVIEW";
  const { data, error } = await service
    .from("projects")
    .update(update)
    .eq("id", projectId)
    .eq("customer_id", userId)
    .eq("status", project.status)
    .select("id");
  if (error || !data || data.length !== 1) return fail(GENERIC);
  return { ok: true };
}

export type BriefIntent = "save" | "approve";

export async function reviewBrief(
  supabase: Client,
  service: Client,
  userId: string,
  projectId: string,
  intent: BriefIntent,
  text: string,
  confirmed: boolean,
): Promise<ServiceResult> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return fail(NOT_FOUND);
  if (project.status !== "BRIEF_REVIEW") return fail("This brief is not open for review.");

  const body = text.trim();
  if (body.length === 0) return fail("The brief cannot be empty.", { fieldErrors: { briefText: "Enter the brief." } });
  if (body.length > BRIEF_MAX_TEXT) {
    return fail("The brief is too long.", { fieldErrors: { briefText: `Keep the brief under ${BRIEF_MAX_TEXT} characters.` } });
  }

  const stored = readStoredBrief(project);
  if (!stored) return fail("Create the brief first.");

  const { data: saved, error: saveError } = await supabase
    .from("projects")
    .update({ english_brief_text: body })
    .eq("id", projectId)
    .eq("customer_id", userId)
    .eq("status", "BRIEF_REVIEW")
    .select("id");
  if (saveError || !saved || saved.length !== 1) return fail(GENERIC);
  if (intent === "save") return { ok: true };

  // Approval: every required answer must still be complete, and the customer must say so.
  const check = validateRequirements(project.project_type, project.requirements_json);
  if (!check.complete) {
    return fail("Some required answers are missing, so the brief cannot be approved.", { missing: check.missingRequiredFields });
  }
  if (!confirmed) {
    return fail("Please confirm that you have read the brief.", { fieldErrors: { confirm: "Tick the box to approve." } });
  }
  const { data, error } = await service
    .from("projects")
    .update({ status: "BRIEF_APPROVED" satisfies ProjectStatus })
    .eq("id", projectId)
    .eq("customer_id", userId)
    .eq("status", "BRIEF_REVIEW")
    .select("id");
  if (error || !data || data.length !== 1) return fail(GENERIC);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pricing and quote
// ---------------------------------------------------------------------------

export type PricingSnapshot = { rules: PricingRule[]; isDemo: boolean };

/** Reads pricing with the trusted client: customers cannot read pricing_rules directly. */
export async function loadPricing(service: Client, type: ProjectType): Promise<PricingSnapshot | null> {
  const [rulesResult, modeResult] = await Promise.all([
    service.from("pricing_rules").select("*").eq("project_type", type).eq("is_active", true).limit(200),
    service.from("site_settings").select("value_json").eq("key", "pricing_mode").maybeSingle(),
  ]);
  if (rulesResult.error || !rulesResult.data) return null;
  const rules: PricingRule[] = [];
  for (const row of rulesResult.data) {
    const parsed = PricingRuleSchema.safeParse(row);
    if (parsed.success) rules.push(parsed.data);
  }
  const mode = modeResult.data?.value_json as { mode?: unknown } | null | undefined;
  return { rules, isDemo: mode?.mode === "demo" };
}

export type QuotePreparation =
  | { configured: true; quote: ComputedQuote }
  | { configured: false; reason: "no_rules" | "missing_rules" | "mixed_currency"; missingKeys: string[] };

/** What a quote would be right now, without saving it. Used to show "Pricing not configured". */
export async function previewQuote(service: Client, project: ProjectRow, now = new Date()): Promise<QuotePreparation | null> {
  const check = validateRequirements(project.project_type, project.requirements_json);
  if (!check.complete) return null;
  const pricing = await loadPricing(service, project.project_type);
  if (!pricing) return null;
  const outcome = computeQuote({ type: project.project_type, requirements: check.requirements, rules: pricing.rules, isDemo: pricing.isDemo, now });
  return outcome.status === "ok"
    ? { configured: true, quote: outcome.quote }
    : { configured: false, reason: outcome.reason, missingKeys: outcome.missingKeys };
}

export async function createQuote(supabase: Client, service: Client, userId: string, projectId: string): Promise<ServiceResult> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return fail(NOT_FOUND);
  if (project.status === "QUOTED") return { ok: true };
  if (project.status !== "BRIEF_APPROVED") return fail("Approve the brief before requesting a quote.");

  const prepared = await previewQuote(service, project);
  if (!prepared) return fail(GENERIC);
  if (!prepared.configured) return fail("Pricing not configured. A quote cannot be prepared yet.");
  const q = prepared.quote;

  // An earlier attempt may have saved a quote and been interrupted before the status moved.
  const existing = await getLatestQuote(supabase, projectId);
  if (!existing || existing.acceptedAt) {
    const { error } = await service.from("quotes").insert({
      project_id: projectId,
      currency: q.currency,
      line_items_json: q.lines,
      subtotal: minorToDecimal(q.subtotalMinor),
      tax_amount: minorToDecimal(q.taxMinor),
      discount_amount: minorToDecimal(q.discountMinor),
      total_amount: minorToDecimal(q.totalMinor),
      pricing_rule_version: q.ruleVersion,
    });
    if (error) return fail(GENERIC);
  }

  const { data, error } = await service
    .from("projects")
    .update({ status: "QUOTED" satisfies ProjectStatus })
    .eq("id", projectId)
    .eq("customer_id", userId)
    .eq("status", "BRIEF_APPROVED")
    .select("id");
  if (error || !data || data.length !== 1) return fail(GENERIC);
  return { ok: true };
}

export async function acceptQuote(
  supabase: Client,
  service: Client,
  userId: string,
  projectId: string,
  quoteId: string,
): Promise<ServiceResult> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return fail(NOT_FOUND);
  if (project.status !== "QUOTED") return fail("This project has no quote waiting for acceptance.");

  // The customer accepts the quote they were shown; if a newer one exists, they must look again.
  const latest = await getLatestQuote(supabase, projectId);
  if (!latest || latest.id !== quoteId) return fail("This quote is out of date. Please reload the page and review it again.");
  if (latest.validUntil && new Date(latest.validUntil) <= new Date()) return fail("This quote has expired.");

  if (!latest.acceptedAt) {
    const { data, error } = await service
      .from("quotes")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", quoteId)
      .eq("project_id", projectId)
      .is("accepted_at", null)
      .select("id");
    if (error || !data || data.length !== 1) return fail(GENERIC);
  }

  const { data, error } = await service
    .from("projects")
    .update({ status: "AWAITING_PAYMENT" satisfies ProjectStatus })
    .eq("id", projectId)
    .eq("customer_id", userId)
    .eq("status", "QUOTED")
    .select("id");
  if (error || !data || data.length !== 1) return fail(GENERIC);
  return { ok: true };
}
