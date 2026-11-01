import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runGeneration, type GenerationCode, type GenerationResult, type StartDeps } from "./service";

/**
 * Generation that follows a payment verification, with no second click.
 *
 * The outbox is the database itself: verifying a payment moves the project to PAYMENT_VERIFIED in
 * the same transaction (migration 3), so "a verified payment with no job yet" is durable, queryable
 * state. Starting generation is therefore a retryable, idempotent reaction to that state, and it
 * is triggered from two places that both call the same code: right after the administrator's
 * decision (src/app/(app)/admin/payments/actions.ts) and, as a safety net, from the customer's
 * status poll (src/app/api/projects/[id]/status/route.ts) if the first attempt never ran.
 *
 * Exactly-once comes from three layers, none of which trusts the caller:
 *   1. a key derived from the verified payment (autoGenerationKey): a repeat is a replay, never a
 *      second provider call (runGeneration checks the key before doing anything);
 *   2. the conditional claim PAYMENT_VERIFIED -> GENERATING inside runGeneration: of any number of
 *      concurrent callers exactly one proceeds;
 *   3. the database: one active job per project, and a job only while GENERATING with a verified
 *      payment.
 *
 * Release is separate and stricter. A finished job is released to the customer automatically only
 * when GENERATION_AUTO_RELEASE is not "false", the job is not placeholder output, and the
 * database function public.system_release_project (migration 12) agrees after re-checking
 * everything itself. Placeholder (mock) output is never released here: it waits for an
 * administrator, who must acknowledge it.
 */

type Client = SupabaseClient;
type Env = Record<string, string | undefined>;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A PAYMENT_VERIFIED project is picked up by the status poll only after this long without a run. */
export const AUTO_KICK_AFTER_MS = 20_000;

/** The idempotency key of the automatic run for one verified payment ("auto-" plus a UUID: 41 characters). */
export function autoGenerationKey(paymentId: string): string {
  return `auto-${paymentId}`;
}

/** Automatic release is ON unless GENERATION_AUTO_RELEASE is "false". Placeholder output is never released either way. */
export function isAutoReleaseEnabled(env: Env = process.env): boolean {
  return String(env.GENERATION_AUTO_RELEASE ?? "").trim().toLowerCase() !== "false";
}

export type AutoOutcome =
  | { state: "released"; jobId: string }
  | { state: "awaiting_review"; jobId: string; reason: "placeholder" | "auto_release_off" | "release_blocked" }
  | { state: "running" }
  | { state: "failed"; message: string }
  | { state: "not_started"; code: GenerationCode; message: string }
  | { state: "idle" };

function log(event: string, fields: Record<string, string | number | boolean | null>) {
  console.info(JSON.stringify({ event: `generation.${event}`, at: new Date().toISOString(), ...fields }));
}

async function releaseIfAllowed(service: Client, projectId: string, result: Extract<GenerationResult, { ok: true }>, env: Env): Promise<AutoOutcome> {
  if (result.mock) return { state: "awaiting_review", jobId: result.jobId, reason: "placeholder" };
  if (!isAutoReleaseEnabled(env)) return { state: "awaiting_review", jobId: result.jobId, reason: "auto_release_off" };

  const { error } = await service.rpc("system_release_project", { p_project_id: projectId });
  if (!error) {
    log("auto_released", { project_id: projectId, job_id: result.jobId });
    return { state: "released", jobId: result.jobId };
  }
  // P0002 also covers "already released by an earlier call": a repeat is then a success, not an error.
  if ((error as { code?: string }).code === "P0002") {
    const { data } = await service.from("projects").select("status").eq("id", projectId).maybeSingle();
    if ((data as { status?: string } | null)?.status === "RELEASED") return { state: "released", jobId: result.jobId };
  }
  log("auto_release_blocked", { project_id: projectId, job_id: result.jobId, code: (error as { code?: string }).code ?? "db" });
  return { state: "awaiting_review", jobId: result.jobId, reason: "release_blocked" };
}

/**
 * Runs generation for a project whose payment an administrator verified, then releases the result
 * if the rules allow. `service` is the trusted client; `actorId` is the verifying administrator (or
 * null when a poll re-triggers it). Safe to call any number of times, from any number of requests.
 */
export async function startAutomaticGeneration(service: Client, input: { projectId: string; actorId: string | null }, deps: StartDeps = {}): Promise<AutoOutcome> {
  if (typeof input.projectId !== "string" || !ID.test(input.projectId)) return { state: "not_started", code: "bad_request", message: "That request was not valid." };

  const { data, error } = await service
    .from("payments")
    .select("id")
    .eq("project_id", input.projectId)
    .eq("status", "VERIFIED")
    .order("verified_at", { ascending: false })
    .limit(1);
  const paymentId = (data as { id: string }[] | null)?.[0]?.id;
  if (error || !paymentId) return { state: "not_started", code: "not_eligible", message: "Generation starts only after a payment has been verified." };

  const result = await runGeneration(service, { projectId: input.projectId, idempotencyKey: autoGenerationKey(paymentId), actorId: input.actorId, source: "auto" }, deps);
  if (!result.ok) {
    if (result.code === "in_progress") return { state: "running" };
    if (result.code === "failed" || result.code === "finalize_failed") return { state: "failed", message: result.message };
    return { state: "not_started", code: result.code, message: result.message };
  }
  return releaseIfAllowed(service, input.projectId, result, deps.env ?? process.env);
}

/**
 * The safety net behind the status poll: looks at the project and, only when automatic work is
 * pending, runs it. A project that was only just verified is left alone (the run that follows the
 * decision is almost certainly under way). Never throws for an ordinary refusal.
 */
export async function reconcileGeneration(service: Client, projectId: string, deps: StartDeps & { now?: () => number } = {}): Promise<AutoOutcome> {
  if (typeof projectId !== "string" || !ID.test(projectId)) return { state: "idle" };
  const { data } = await service.from("projects").select("status, updated_at").eq("id", projectId).maybeSingle();
  const project = data as { status: string; updated_at: string | null } | null;
  if (!project) return { state: "idle" };

  if (project.status === "PAYMENT_VERIFIED") {
    const since = Date.parse(project.updated_at ?? "");
    const now = (deps.now ?? Date.now)();
    if (!Number.isFinite(since) || now - since < AUTO_KICK_AFTER_MS) return { state: "idle" };
    return startAutomaticGeneration(service, { projectId, actorId: null }, deps);
  }
  // A finished job whose release did not happen (the request ended first): the replay finishes it.
  if (project.status === "READY_FOR_REVIEW" && isAutoReleaseEnabled(deps.env ?? process.env)) {
    return startAutomaticGeneration(service, { projectId, actorId: null }, deps);
  }
  return { state: "idle" };
}
