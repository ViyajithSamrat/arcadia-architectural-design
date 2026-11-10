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
  /**
   * OpenRouter's unified `reasoning.effort`, sent only when OPENROUTER_TEXT_REASONING_EFFORT is set.
   * "none" switches thinking off on models that allow it (google/gemini-3.1-flash-lite reports
   * reasoning as optional with "none" supported); thinking tokens are billed and share max_tokens
   * with the JSON answer. Unset: nothing is sent and the model's default applies.
   */
  reasoningEffort?: (typeof OPENROUTER_REASONING_EFFORTS)[number] | null;
};

/** The efforts this app may request: off or the cheapest levels only. */
export const OPENROUTER_REASONING_EFFORTS = ["none", "minimal", "low"] as const;

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
  const effort = isSet(env, "OPENROUTER_TEXT_REASONING_EFFORT") ? String(env.OPENROUTER_TEXT_REASONING_EFFORT).trim().toLowerCase() : null;
  // An explicit value outside the list is a configuration error: fail closed rather than guess.
  if (effort !== null && !(OPENROUTER_REASONING_EFFORTS as readonly string[]).includes(effort)) return null;
  return {
    apiKey: String(env.OPENROUTER_API_KEY).trim(),
    baseUrl,
    model: String(env.OPENROUTER_TEXT_MODEL).trim(),
    referer: isSet(env, "OPENROUTER_HTTP_REFERER") ? String(env.OPENROUTER_HTTP_REFERER).trim() : null,
    title: isSet(env, "OPENROUTER_APP_TITLE") ? String(env.OPENROUTER_APP_TITLE).trim().slice(0, 100) : null,
    timeoutMs: getProviderTimeoutMs(env),
    reasoningEffort: effort as OpenRouterConfig["reasoningEffort"],
  };
}

// ---------------------------------------------------------------------------
// OpenRouter (images): the dedicated Image API, POST {base}/images
// ---------------------------------------------------------------------------

export const OPENROUTER_IMAGE_RESOLUTIONS = ["512", "768", "1K", "1.5K", "2K"] as const;
export const OPENROUTER_IMAGE_FORMATS = ["jpeg", "webp", "png"] as const;
/** author/slug, as OpenRouter names models (for example bytedance-seed/seedream-4.5). */
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/i;
const ASPECT_RATIO = /^(?:auto|\d{1,2}:\d{1,2})$/;

export type OpenRouterImageConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  referer: string | null;
  title: string | null;
  /** Time allowed for ONE image. The whole request may take this many times the number of views. */
  timeoutMsPerImage: number;
  resolution: (typeof OPENROUTER_IMAGE_RESOLUTIONS)[number];
  aspectRatio: string;
  /**
   * Sent only when OPENROUTER_IMAGE_FORMAT is set. Not every model accepts it (Seedream 4.5 does not
   * list it), so by default the request leaves it out and the model's own format is used; every
   * output is still checked for type, size (5 MiB) and dimensions before it is stored.
   */
  outputFormat: (typeof OPENROUTER_IMAGE_FORMATS)[number] | null;
  /** Send a project's reference photos as inputs. Off unless the owner has checked that the model supports them. */
  sendReferences: boolean;
};

/**
 * Null unless the key and an image model are set, and the base URL is the OpenRouter host.
 * Fail closed: a missing or malformed value turns live image generation off; nothing here
 * ever falls back to another model, another host or the mock.
 */
export function getOpenRouterImageConfig(env: RawEnv = process.env): OpenRouterImageConfig | null {
  if (!isSet(env, "OPENROUTER_API_KEY") || !isSet(env, "OPENROUTER_IMAGE_MODEL")) return null;
  const baseUrl = openRouterBaseUrl(env);
  if (!baseUrl) return null;
  const model = String(env.OPENROUTER_IMAGE_MODEL).trim();
  if (!MODEL_SLUG.test(model) || model.length > 120) return null;

  const resolution = isSet(env, "OPENROUTER_IMAGE_RESOLUTION") ? String(env.OPENROUTER_IMAGE_RESOLUTION).trim() : "1K";
  if (!(OPENROUTER_IMAGE_RESOLUTIONS as readonly string[]).includes(resolution)) return null;
  const aspectRatio = isSet(env, "OPENROUTER_IMAGE_ASPECT_RATIO") ? String(env.OPENROUTER_IMAGE_ASPECT_RATIO).trim() : "16:9";
  if (!ASPECT_RATIO.test(aspectRatio)) return null;
  const outputFormat = isSet(env, "OPENROUTER_IMAGE_FORMAT") ? String(env.OPENROUTER_IMAGE_FORMAT).trim().toLowerCase() : null;
  // An explicit value outside the list is a configuration error: fail closed rather than guess.
  if (outputFormat !== null && !(OPENROUTER_IMAGE_FORMATS as readonly string[]).includes(outputFormat)) return null;

  return {
    apiKey: String(env.OPENROUTER_API_KEY).trim(),
    baseUrl,
    model,
    referer: isSet(env, "OPENROUTER_HTTP_REFERER") ? String(env.OPENROUTER_HTTP_REFERER).trim() : null,
    title: isSet(env, "OPENROUTER_APP_TITLE") ? String(env.OPENROUTER_APP_TITLE).trim().slice(0, 100) : null,
    timeoutMsPerImage: whole(env, "OPENROUTER_IMAGE_TIMEOUT_MS", 90_000, 10_000, 180_000),
    resolution: resolution as OpenRouterImageConfig["resolution"],
    aspectRatio,
    outputFormat: outputFormat as OpenRouterImageConfig["outputFormat"],
    sendReferences: isSet(env, "OPENROUTER_IMAGE_REFERENCES") && String(env.OPENROUTER_IMAGE_REFERENCES).trim().toLowerCase() === "true",
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

/** GNANI_LANGUAGES, limited to the codes Gnani documents; anything else is dropped. */
export function configuredGnaniLanguages(env: RawEnv = process.env): string[] {
  const listed = (isSet(env, "GNANI_LANGUAGES") ? String(env.GNANI_LANGUAGES).split(",") : [])
    .map((l) => l.trim())
    .filter((l) => (GNANI_STT_LANGUAGES as readonly string[]).includes(l));
  return [...new Set(listed)];
}

/** Longest recording accepted, in seconds: GNANI_STT_MAX_SECONDS, never more than 30. */
export function gnaniSttMaxSeconds(env: RawEnv = process.env): number {
  return whole(env, "GNANI_STT_MAX_SECONDS", 30, 1, 30);
}

/** What speech-to-text alone needs. Nothing about text-to-speech. */
export type GnaniSttConfig = Pick<
  GnaniConfig,
  "apiKey" | "baseUrl" | "sttPath" | "timeoutMs" | "languages" | "maxSttSeconds" | "creditsPerSttSecond" | "maxCreditsPerRequest" | "customerCreditsPerHour" | "budgetCredits"
>;

export type GnaniSttReadiness = { ready: true; config: GnaniSttConfig } | { ready: false; missing: string[] };

/**
 * Speech-to-text readiness on its own, so an STT-only account does not need any
 * text-to-speech setting. Same fail-closed rules as getGnaniReadiness: switched on
 * explicitly, an allowed https host (the allow-list is not widened here), a path, documented
 * languages and every spending limit. Missing settings are listed by NAME only.
 */
export function getGnaniSttReadiness(env: RawEnv = process.env): GnaniSttReadiness {
  const missing: string[] = [];
  const need = (ok: boolean, name: string) => {
    if (!ok) missing.push(name);
  };

  need(isSet(env, "GNANI_VOICE_ENABLED") && String(env.GNANI_VOICE_ENABLED).trim().toLowerCase() === "true", "GNANI_VOICE_ENABLED=true");
  need(isSet(env, "GNANI_API_KEY"), "GNANI_API_KEY");
  const baseUrl = gnaniBaseUrl(env);
  need(baseUrl !== null, "GNANI_BASE_URL (an allowed https host)");
  const sttPath = isSet(env, "GNANI_STT_ENDPOINT") ? String(env.GNANI_STT_ENDPOINT).trim() : "";
  need(safePath(sttPath), "GNANI_STT_ENDPOINT (a path)");
  const languages = configuredGnaniLanguages(env);
  need(languages.length > 0, "GNANI_LANGUAGES (documented codes, comma separated)");
  const perSecond = positive(env, "GNANI_CREDITS_PER_STT_SECOND");
  const perRequest = positive(env, "GNANI_MAX_CREDITS_PER_REQUEST");
  const perCustomer = positive(env, "GNANI_CUSTOMER_CREDITS_PER_HOUR");
  const budget = positive(env, "GNANI_BUDGET_CREDITS");
  need(perSecond !== null, "GNANI_CREDITS_PER_STT_SECOND");
  need(perRequest !== null, "GNANI_MAX_CREDITS_PER_REQUEST");
  need(perCustomer !== null, "GNANI_CUSTOMER_CREDITS_PER_HOUR");
  need(budget !== null, "GNANI_BUDGET_CREDITS");

  if (missing.length > 0 || baseUrl === null || perSecond === null || perRequest === null || perCustomer === null || budget === null) {
    return { ready: false, missing };
  }
  return {
    ready: true,
    config: {
      apiKey: String(env.GNANI_API_KEY).trim(),
      baseUrl,
      sttPath,
      timeoutMs: getProviderTimeoutMs(env),
      languages,
      maxSttSeconds: gnaniSttMaxSeconds(env),
      creditsPerSttSecond: perSecond,
      maxCreditsPerRequest: perRequest,
      customerCreditsPerHour: perCustomer,
      budgetCredits: Math.min(budget, GNANI_HARD_CEILING_CREDITS),
    },
  };
}

// ---------------------------------------------------------------------------
// Gnani text-to-speech (spoken read-back of the brief summary)
// ---------------------------------------------------------------------------

/** The only language read-back is offered in: the stored summary is English text. */
export const READBACK_LANGUAGE = "en-IN";

/** Models Gnani documents for text-to-speech (docs.gnani.ai, 2026-10-21). */
export const GNANI_TTS_MODELS = ["timbre-v2.5", "timbre-v3.0"] as const;

/** What text-to-speech alone needs. Nothing about speech-to-text. */
export type GnaniTtsConfig = Pick<
  GnaniConfig,
  "apiKey" | "baseUrl" | "ttsPath" | "ttsModel" | "ttsVoice" | "timeoutMs" | "languages" | "maxTtsChars" | "creditsPerTtsChar" | "maxCreditsPerRequest" | "customerCreditsPerHour" | "budgetCredits"
>;

export type GnaniTtsReadiness = { ready: true; config: GnaniTtsConfig } | { ready: false; missing: string[] };

/**
 * Text-to-speech readiness on its own, with the same fail-closed rules as speech-to-text:
 * switched on explicitly with GNANI_VOICE_ENABLED=true, an allowed https host, an endpoint
 * path, a documented model and a voice, English (en-IN) among the configured languages, and
 * every spending limit. Missing settings are listed by NAME only, never by value.
 */
export function getGnaniTtsReadiness(env: RawEnv = process.env): GnaniTtsReadiness {
  const missing: string[] = [];
  const need = (ok: boolean, name: string) => {
    if (!ok) missing.push(name);
  };

  need(isSet(env, "GNANI_VOICE_ENABLED") && String(env.GNANI_VOICE_ENABLED).trim().toLowerCase() === "true", "GNANI_VOICE_ENABLED=true");
  need(isSet(env, "GNANI_API_KEY"), "GNANI_API_KEY");
  const baseUrl = gnaniBaseUrl(env);
  need(baseUrl !== null, "GNANI_BASE_URL (an allowed https host)");
  const ttsPath = isSet(env, "GNANI_TTS_ENDPOINT") ? String(env.GNANI_TTS_ENDPOINT).trim() : "";
  need(safePath(ttsPath), "GNANI_TTS_ENDPOINT (a path)");
  const model = isSet(env, "GNANI_TTS_MODEL") ? String(env.GNANI_TTS_MODEL).trim() : "";
  need((GNANI_TTS_MODELS as readonly string[]).includes(model), `GNANI_TTS_MODEL (one of ${GNANI_TTS_MODELS.join(", ")})`);
  need(isSet(env, "GNANI_TTS_VOICE"), "GNANI_TTS_VOICE");
  const languages = configuredGnaniLanguages(env);
  need(languages.includes(READBACK_LANGUAGE), `GNANI_LANGUAGES (must include ${READBACK_LANGUAGE})`);
  const perChar = positive(env, "GNANI_CREDITS_PER_TTS_CHAR");
  const perRequest = positive(env, "GNANI_MAX_CREDITS_PER_REQUEST");
  const perCustomer = positive(env, "GNANI_CUSTOMER_CREDITS_PER_HOUR");
  const budget = positive(env, "GNANI_BUDGET_CREDITS");
  need(perChar !== null, "GNANI_CREDITS_PER_TTS_CHAR");
  need(perRequest !== null, "GNANI_MAX_CREDITS_PER_REQUEST");
  need(perCustomer !== null, "GNANI_CUSTOMER_CREDITS_PER_HOUR");
  need(budget !== null, "GNANI_BUDGET_CREDITS");

  if (missing.length > 0 || baseUrl === null || perChar === null || perRequest === null || perCustomer === null || budget === null) {
    return { ready: false, missing };
  }
  return {
    ready: true,
    config: {
      apiKey: String(env.GNANI_API_KEY).trim(),
      baseUrl,
      ttsPath,
      ttsModel: model,
      ttsVoice: String(env.GNANI_TTS_VOICE).trim(),
      timeoutMs: getProviderTimeoutMs(env),
      languages,
      maxTtsChars: whole(env, "GNANI_TTS_MAX_CHARS", 600, 1, 2000),
      creditsPerTtsChar: perChar,
      maxCreditsPerRequest: perRequest,
      customerCreditsPerHour: perCustomer,
      budgetCredits: Math.min(budget, GNANI_HARD_CEILING_CREDITS),
    },
  };
}
