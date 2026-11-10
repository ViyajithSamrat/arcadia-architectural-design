import type { SupabaseClient } from "@supabase/supabase-js";
import { GNANI_HARD_CEILING_CREDITS, type GnaniConfig, type OpenRouterConfig, type OpenRouterImageConfig } from "./config";
import type { ProviderHooks, ProviderUsage } from "./interfaces";
import { logProviderCall } from "./log";

/**
 * The usage ledger guard. Before any provider call, usage is RESERVED in the database
 * (public.ai_usage_reserve, serialized per provider). ARCADIA sets no usage quota any more (see
 * AI_UNMETERED_LIMIT): the reservation records the call, and refuses only for a call already in
 * flight, the SQL-level Gnani ceiling, or a database that cannot be reached, in which case nothing
 * is called: the guard fails closed.
 *
 * Use the trusted (service) client: customers cannot call the reservation functions.
 */

type Client = SupabaseClient;

export type UsagePlan = {
  provider: "openrouter" | "gnani";
  operation: "brief" | "translate" | "image" | "stt" | "tts";
  model: string | null;
  /** "image" counts generated images and is accounted apart from "request" (briefs). */
  unit: "request" | "image" | "credit";
  /** What this call is expected to use. For Gnani this is a conservative ESTIMATE: Gnani reports no usage. */
  units: number;
  limits: {
    customerLimit: number;
    customerWindowMinutes: number;
    globalLimit: number;
    /** null: cumulative, for ever. */
    globalWindowMinutes: number | null;
    /** null: no cap on simultaneous calls. */
    maxInFlight: number | null;
  };
};

export type RefusalReason = "customer_limit" | "global_limit" | "busy" | "unavailable";

export type Reservation = { ok: true; usageId: string } | { ok: false; reason: RefusalReason };

const REFUSALS: Record<string, RefusalReason> = { AI001: "customer_limit", AI002: "global_limit", AI003: "busy" };

export async function reserveUsage(service: Client, who: { customerId: string; projectId: string | null }, plan: UsagePlan): Promise<Reservation> {
  try {
    const { data, error } = await service.rpc("ai_usage_reserve", {
      p_customer_id: who.customerId,
      p_project_id: who.projectId,
      p_provider: plan.provider,
      p_operation: plan.operation,
      p_model: plan.model,
      p_unit: plan.unit,
      p_units: plan.units,
      p_customer_limit: plan.limits.customerLimit,
      p_customer_window_minutes: plan.limits.customerWindowMinutes,
      p_global_limit: plan.limits.globalLimit,
      p_global_window_minutes: plan.limits.globalWindowMinutes,
      p_max_in_flight: plan.limits.maxInFlight,
    });
    if (error) {
      const reason = REFUSALS[(error as { code?: string }).code ?? ""] ?? "unavailable";
      logProviderCall({ provider: plan.provider, operation: plan.operation, status: "refused", reason });
      return { ok: false, reason };
    }
    if (typeof data !== "string" || data.length === 0) return { ok: false, reason: "unavailable" };
    return { ok: true, usageId: data };
  } catch {
    logProviderCall({ provider: plan.provider, operation: plan.operation, status: "refused", reason: "unavailable" });
    return { ok: false, reason: "unavailable" };
  }
}

export async function finishUsage(
  service: Client,
  usageId: string,
  outcome: { status: "SUCCEEDED" | "FAILED" | "NOT_SENT"; unitsReported?: number | null; requestId?: string | null; model?: string | null },
): Promise<void> {
  try {
    await service.rpc("ai_usage_finish", {
      p_id: usageId,
      p_status: outcome.status,
      p_units_reported: outcome.unitsReported ?? null,
      p_request_id: outcome.requestId ?? null,
      p_model: outcome.model ?? null,
    });
  } catch {
    // The reservation stays RESERVED, which still counts against the budget: that is the safe side.
  }
}

/** Customer-safe wording for a refusal. Never mentions budgets, credits or providers. */
export function refusalMessage(reason: RefusalReason): string {
  switch (reason) {
    case "customer_limit":
      return "You have reached the limit for this for now. Please try again later.";
    case "global_limit":
      return "This service has reached its limit for now. Please try again later.";
    case "busy":
      return "This service is busy. Please try again in a moment.";
    default:
      return "This service is unavailable right now.";
  }
}

export type GuardedResult<T> = { ok: true; value: T } | { ok: false; reason: RefusalReason };

/**
 * Reserve, run, then record the outcome. `work` receives hooks so the adapter can say
 * whether the request was refused before anything was sent (`onNotSent`: only then is the
 * reservation released) and what usage the provider reported. If `work` throws, the failure
 * is recorded as FAILED (still counted) and rethrown.
 */
export async function withUsage<T>(
  service: Client,
  who: { customerId: string; projectId: string | null },
  plan: UsagePlan,
  work: (hooks: ProviderHooks) => Promise<T>,
): Promise<GuardedResult<T>> {
  const reservation = await reserveUsage(service, who, plan);
  if (!reservation.ok) return reservation;

  // A failure is assumed to be a call that was made (and so counts) unless the adapter
  // explicitly says nothing was sent. An adapter that forgets a hook can only over-count.
  let sent = false;
  let notSent = false;
  let usage: ProviderUsage = {};
  const hooks: ProviderHooks = {
    onSent: () => {
      sent = true;
    },
    onNotSent: () => {
      notSent = true;
    },
    onUsage: (u) => {
      usage = { ...usage, ...u };
    },
  };
  try {
    const value = await work(hooks);
    await finishUsage(service, reservation.usageId, { status: "SUCCEEDED", unitsReported: usage.units ?? null, requestId: usage.requestId ?? null, model: usage.model ?? null });
    return { ok: true, value };
  } catch (error) {
    await finishUsage(service, reservation.usageId, {
      status: notSent && !sent ? "NOT_SENT" : "FAILED",
      unitsReported: usage.units ?? null,
      requestId: usage.requestId ?? null,
      model: usage.model ?? null,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * ARCADIA imposes no AI usage quota (owner decisions, 2026-11-10: first image generation, then text,
 * translation and speech, because the quotas refused valid requests while the provider accounts still
 * had credit). The database function still requires finite, positive limits, so this is a ceiling no
 * real usage can reach rather than an absent argument: the function keeps validating, recording and
 * serialising every reservation. The providers' own account balances and key limits remain the real
 * spending limits. The one remaining ceiling is in SQL (see GNANI_HARD_CEILING_CREDITS).
 */
export const AI_UNMETERED_LIMIT = 1_000_000_000;

const UNMETERED_TEXT_LIMITS = {
  customerLimit: AI_UNMETERED_LIMIT,
  customerWindowMinutes: 60,
  globalLimit: AI_UNMETERED_LIMIT,
  globalWindowMinutes: 24 * 60,
  maxInFlight: null,
} as const;

/** One brief = one request. The retry-free adapter makes exactly one. Recorded in the ledger, never refused for quota. */
export function planOpenRouterBrief(config: Pick<OpenRouterConfig, "model">): UsagePlan {
  return {
    provider: "openrouter",
    operation: "brief",
    model: config.model,
    unit: "request",
    units: 1,
    limits: { ...UNMETERED_TEXT_LIMITS },
  };
}

/** A transcript translation is one OpenRouter text request, recorded under its own operation and never refused for quota. */
export function planOpenRouterTranslation(config: Pick<OpenRouterConfig, "model">): UsagePlan {
  return { ...planOpenRouterBrief(config), operation: "translate" };
}

/**
 * Image generation is metered in images, in a unit of its own. The reservation is for the images THIS
 * request will ask for and is always written to the ledger (audit, observability), one call at a time.
 * The only refusals are a call already in flight (maxInFlight) and a ledger that cannot be reached
 * (fail closed).
 */
export function planOpenRouterImages(config: Pick<OpenRouterImageConfig, "model">, images: number): UsagePlan {
  return {
    provider: "openrouter",
    operation: "image",
    model: config.model,
    unit: "image",
    units: images,
    limits: { ...UNMETERED_TEXT_LIMITS, maxInFlight: 1 },
  };
}

export type GnaniPlan = { ok: true; plan: UsagePlan } | { ok: false; reason: "unmeasurable" };

/** What a Gnani plan needs: the owner's credit rates, to ESTIMATE a call. TTS without its rate is unmeasurable. */
export type GnaniPlanConfig = Partial<Pick<GnaniConfig, "creditsPerSttSecond" | "creditsPerTtsChar" | "ttsModel">>;

const ceil2 = (n: number) => Math.ceil(n * 100) / 100;

/**
 * Gnani's documentation gives no price and its responses report no usage, so the cost of a
 * call is ESTIMATED from the owner's own credits-per-second / credits-per-character figures
 * and rounded up, only so that the ledger records it. If the estimate is not a positive number the
 * call is refused (fail closed). One call at a time, provider-wide (Gnani allows one active
 * request per account).
 *
 * There is no ARCADIA per-request, per-customer or configured-budget limit any more. The cumulative
 * ceiling that remains is enforced inside ai_usage_reserve (5,000 credits, the owner's own credit
 * balance); the plan asks for exactly that number so the database's clamp changes nothing.
 *
 * @param amount seconds of audio for STT, characters for TTS
 */
export function planGnaniCall(operation: "stt" | "tts", amount: number, config: GnaniPlanConfig): GnaniPlan {
  // A missing rate is NaN, which is refused as unmeasurable below (fail closed).
  const rate = (operation === "stt" ? config.creditsPerSttSecond : config.creditsPerTtsChar) ?? Number.NaN;
  const units = ceil2(Math.ceil(amount) * rate);
  if (!Number.isFinite(units) || units <= 0) return { ok: false, reason: "unmeasurable" };
  return {
    ok: true,
    plan: {
      provider: "gnani",
      operation,
      model: operation === "tts" ? (config.ttsModel ?? null) : null,
      unit: "credit",
      units,
      limits: {
        customerLimit: AI_UNMETERED_LIMIT,
        customerWindowMinutes: 60,
        globalLimit: GNANI_HARD_CEILING_CREDITS,
        globalWindowMinutes: null,
        maxInFlight: 1,
      },
    },
  };
}
