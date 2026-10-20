import { isSet } from "@/lib/env/schema";

type RawEnv = Record<string, string | undefined>;

/**
 * Provider configuration read from the server's environment. Presence is not proof that a
 * provider works: nothing here has been verified against a live service.
 */

export function getProviderMode(env: RawEnv = process.env): "mock" | "live" {
  return isSet(env, "PROVIDER_MODE") && String(env.PROVIDER_MODE).trim().toLowerCase() === "live" ? "live" : "mock";
}

function whole(env: RawEnv, name: string, fallback: number, min: number, max: number): number {
  if (!isSet(env, name)) return fallback;
  const n = Number(String(env[name]).trim());
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** A positive number, or null when unset or invalid (callers fail closed on null). */
function positive(env: RawEnv, name: string): number | null {
  if (!isSet(env, name)) return null;
  const n = Number(String(env[name]).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const PROVIDER_TIMEOUT_DEFAULT_MS = 30_000;
export function getProviderTimeoutMs(env: RawEnv = process.env): number {
  return whole(env, "PROVIDER_TIMEOUT_MS", PROVIDER_TIMEOUT_DEFAULT_MS, 1_000, 60_000);
}

// ---------------------------------------------------------------------------
// OpenRouter (text)
// ---------------------------------------------------------------------------

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/** The only host a request may go to. A different value in the environment is ignored, not followed. */
export const OPENROUTER_HOST = "openrouter.ai";

export type OpenRouterConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  referer: string | null;
  title: string | null;
  timeoutMs: number;
  /** Most briefs one customer may create per hour. */
  briefsPerHour: number;
  /** Most OpenRouter requests the whole app may make per 24 hours (free models allow 50 without purchased credits). */
  dailyRequestCap: number;
};

function openRouterBaseUrl(env: RawEnv): string | null {
  const raw = isSet(env, "OPENROUTER_BASE_URL") ? String(env.OPENROUTER_BASE_URL).trim() : OPENROUTER_DEFAULT_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== OPENROUTER_HOST || url.username || url.password || url.port) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Null unless the key and model are set and the base URL is the OpenRouter host. */
export function getOpenRouterConfig(env: RawEnv = process.env): OpenRouterConfig | null {
  if (!isSet(env, "OPENROUTER_API_KEY") || !isSet(env, "OPENROUTER_TEXT_MODEL")) return null;
  const baseUrl = openRouterBaseUrl(env);
  if (!baseUrl) return null;
  return {
    apiKey: String(env.OPENROUTER_API_KEY).trim(),
    baseUrl,
    model: String(env.OPENROUTER_TEXT_MODEL).trim(),
    referer: isSet(env, "OPENROUTER_HTTP_REFERER") ? String(env.OPENROUTER_HTTP_REFERER).trim() : null,
    title: isSet(env, "OPENROUTER_APP_TITLE") ? String(env.OPENROUTER_APP_TITLE).trim().slice(0, 100) : null,
    timeoutMs: getProviderTimeoutMs(env),
    briefsPerHour: whole(env, "AI_BRIEFS_PER_HOUR", 5, 1, 50),
    dailyRequestCap: whole(env, "OPENROUTER_DAILY_REQUEST_CAP", 40, 1, 1000),
  };
}

// ---------------------------------------------------------------------------
// Gnani (speech): disabled unless every safeguard is configured
// ---------------------------------------------------------------------------

/** The owner's remaining credits. No configured budget can exceed this. */
export const GNANI_HARD_CEILING_CREDITS = 5000;

/**
 * Hosts a Gnani request may go to. Gnani's own documentation (docs.gnani.ai) names
 * api.vachana.ai; a developer page names api.gnani.ai with a different scheme. Only the
 * documented one is allowed until the owner confirms which is current for the account.
 */
export const GNANI_ALLOWED_HOSTS: readonly string[] = ["api.vachana.ai"];

/** Language codes Gnani documents for REST speech-to-text. */
export const GNANI_STT_LANGUAGES = ["bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "pa-IN", "ta-IN", "te-IN"] as const;

export type GnaniConfig = {
  apiKey: string;
  baseUrl: string;
  sttPath: string;
  ttsPath: string;
  ttsModel: string;
  ttsVoice: string;
  timeoutMs: number;
  /** Offered languages: the configured list, limited to the ones Gnani documents. */
  languages: string[];
  /** Longest recording accepted, in seconds. Never more than 30 (Gnani's pages say 30 and 60). */
  maxSttSeconds: number;
  maxTtsChars: number;
  creditsPerSttSecond: number;
  creditsPerTtsChar: number;
  maxCreditsPerRequest: number;
  customerCreditsPerHour: number;
  /** Total Phase 5 budget: the configured value, never above GNANI_HARD_CEILING_CREDITS. */
  budgetCredits: number;
};

export type GnaniReadiness = { ready: true; config: GnaniConfig } | { ready: false; missing: string[] };

function gnaniBaseUrl(env: RawEnv): string | null {
  if (!isSet(env, "GNANI_BASE_URL")) return null;
  try {
    const url = new URL(String(env.GNANI_BASE_URL).trim());
    if (url.protocol !== "https:" || !GNANI_ALLOWED_HOSTS.includes(url.hostname) || url.username || url.password || url.port) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const safePath = (value: string) => /^\/[A-Za-z0-9._\-/]*$/.test(value) && !value.includes("//") && !value.includes("..");

/**
 * Voice is ready only when it is switched on explicitly AND every safeguard has a value:
 * key, allowed host, endpoint paths, model and voice, a credit conversion for each
 * direction, a per-request maximum, a per-customer limit and a total budget. Anything
 * missing is listed by NAME and voice stays off (fail closed). Values are never returned
 * in `missing`.
 */
export function getGnaniReadiness(env: RawEnv = process.env): GnaniReadiness {
  const missing: string[] = [];
  const need = (ok: boolean, name: string) => {
    if (!ok) missing.push(name);
  };

  need(isSet(env, "GNANI_VOICE_ENABLED") && String(env.GNANI_VOICE_ENABLED).trim().toLowerCase() === "true", "GNANI_VOICE_ENABLED=true");
  need(isSet(env, "GNANI_API_KEY"), "GNANI_API_KEY");
  const baseUrl = gnaniBaseUrl(env);
  need(baseUrl !== null, "GNANI_BASE_URL (an allowed https host)");
  const sttPath = isSet(env, "GNANI_STT_ENDPOINT") ? String(env.GNANI_STT_ENDPOINT).trim() : "";
  const ttsPath = isSet(env, "GNANI_TTS_ENDPOINT") ? String(env.GNANI_TTS_ENDPOINT).trim() : "";
  need(safePath(sttPath), "GNANI_STT_ENDPOINT (a path)");
  need(safePath(ttsPath), "GNANI_TTS_ENDPOINT (a path)");
  need(isSet(env, "GNANI_TTS_MODEL"), "GNANI_TTS_MODEL");
  need(isSet(env, "GNANI_TTS_VOICE"), "GNANI_TTS_VOICE");
  const perSecond = positive(env, "GNANI_CREDITS_PER_STT_SECOND");
  const perChar = positive(env, "GNANI_CREDITS_PER_TTS_CHAR");
  const perRequest = positive(env, "GNANI_MAX_CREDITS_PER_REQUEST");
  const perCustomer = positive(env, "GNANI_CUSTOMER_CREDITS_PER_HOUR");
  const budget = positive(env, "GNANI_BUDGET_CREDITS");
  need(perSecond !== null, "GNANI_CREDITS_PER_STT_SECOND");
  need(perChar !== null, "GNANI_CREDITS_PER_TTS_CHAR");
  need(perRequest !== null, "GNANI_MAX_CREDITS_PER_REQUEST");
  need(perCustomer !== null, "GNANI_CUSTOMER_CREDITS_PER_HOUR");
  need(budget !== null, "GNANI_BUDGET_CREDITS");

  const languages = (isSet(env, "GNANI_LANGUAGES") ? String(env.GNANI_LANGUAGES).split(",") : [])
    .map((l) => l.trim())
    .filter((l): l is (typeof GNANI_STT_LANGUAGES)[number] => (GNANI_STT_LANGUAGES as readonly string[]).includes(l));
  need(languages.length > 0, "GNANI_LANGUAGES (documented codes, comma separated)");

  if (missing.length > 0 || baseUrl === null || perSecond === null || perChar === null || perRequest === null || perCustomer === null || budget === null) {
    return { ready: false, missing };
  }
  return {
    ready: true,
    config: {
      apiKey: String(env.GNANI_API_KEY).trim(),
      baseUrl,
      sttPath,
      ttsPath,
      ttsModel: String(env.GNANI_TTS_MODEL).trim(),
      ttsVoice: String(env.GNANI_TTS_VOICE).trim(),
      timeoutMs: getProviderTimeoutMs(env),
      languages: [...new Set(languages)],
      maxSttSeconds: whole(env, "GNANI_STT_MAX_SECONDS", 30, 1, 30),
      maxTtsChars: whole(env, "GNANI_TTS_MAX_CHARS", 600, 1, 2000),
      creditsPerSttSecond: perSecond,
      creditsPerTtsChar: perChar,
      maxCreditsPerRequest: perRequest,
      customerCreditsPerHour: perCustomer,
      budgetCredits: Math.min(budget, GNANI_HARD_CEILING_CREDITS),
    },
  };
}
