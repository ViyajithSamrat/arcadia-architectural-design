import { z } from "zod";

/**
 * Environment variable schema (Phase 1 foundation).
 *
 * Every variable is optional so the app runs without any credentials.
 * A value that IS provided must have a valid format. Blank strings (as in
 * .env.example) count as "not set". Names come from ENVIRONMENT_VARIABLES.md.
 *
 * Nothing here proves an integration works. It only checks presence and format.
 */

/** Blank or whitespace-only strings count as unset. */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalUrl = z.preprocess(blankToUndefined, z.url().optional());

/** The `role` claim of a legacy Supabase JWT key, or null when the value is not one. */
function legacyJwtRole(value: string): string | null {
  const payload = value.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const role = (JSON.parse(atob(base64)) as { role?: unknown }).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

/** A public (NEXT_PUBLIC_) key must never be a secret: no `sb_secret_` key and no legacy service_role JWT. */
const optionalPublicKey = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine((v) => !v.startsWith("sb_secret_") && legacyJwtRole(v) !== "service_role", "A secret key must not be public.")
    .optional(),
);
/** A publishable key here would silently lack server privileges. */
const optionalSecretKey = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine((v) => !v.startsWith("sb_publishable_"), "Use the secret key, not the publishable key.")
    .optional(),
);

export const envSchema = z.object({
  // Application
  // PROVIDER_MODE (02_TRD.md section 2.4): "mock" or "live". Unset behaves as
  // "mock". Nothing reads it in Phase 1; it is validated so a typo is caught early.
  PROVIDER_MODE: z.preprocess(blankToUndefined, z.enum(["mock", "live"]).optional()),
  NEXT_PUBLIC_APP_URL: optionalUrl,
  APP_BASE_URL: optionalUrl,
  ADMIN_EMAILS: optionalText,

  // Supabase (secret / service role key and DB URL are server-only). The modern
  // publishable and secret keys are preferred; the legacy anon and service role
  // keys are fallbacks for the local Docker stack.
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalPublicKey,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalPublicKey,
  SUPABASE_SECRET_KEY: optionalSecretKey,
  SUPABASE_SERVICE_ROLE_KEY: optionalSecretKey,
  SUPABASE_DB_URL: optionalText,
  SUPABASE_STORAGE_BUCKET: optionalText,

  // OpenRouter (server-only)
  OPENROUTER_API_KEY: optionalText,
  OPENROUTER_BASE_URL: optionalUrl,
  OPENROUTER_TEXT_MODEL: optionalText,
  OPENROUTER_IMAGE_MODEL: optionalText,
  OPENROUTER_HTTP_REFERER: optionalUrl,
  OPENROUTER_APP_TITLE: optionalText,
  // Images per generation request (Phase 6, mock only for now); parsed and clamped in code.
  MAX_GENERATION_IMAGES: optionalText,
  // "false" keeps finished generation for an administrator to release; anything else releases real (non-placeholder) output automatically.
  GENERATION_AUTO_RELEASE: optionalText,
  // Live image generation (OpenRouter Image API): format, size, timeouts and image limits; parsed and clamped in code.
  OPENROUTER_IMAGE_RESOLUTION: optionalText,
  OPENROUTER_IMAGE_ASPECT_RATIO: optionalText,
  OPENROUTER_IMAGE_FORMAT: optionalText,
  OPENROUTER_IMAGE_TIMEOUT_MS: optionalText,
  OPENROUTER_IMAGES_PER_HOUR: optionalText,
  OPENROUTER_IMAGES_PER_DAY: optionalText,
  OPENROUTER_IMAGE_REFERENCES: optionalText,

  // Gnani speech-to-text / text-to-speech (server-only; details unverified)
  GNANI_API_KEY: optionalText,
  GNANI_BASE_URL: optionalUrl,
  GNANI_STT_ENDPOINT: optionalText,
  GNANI_TTS_ENDPOINT: optionalText,
  GNANI_STT_MODEL: optionalText,
  GNANI_TTS_MODEL: optionalText,
  GNANI_TTS_VOICE: optionalText,
  // Gnani voice is OFF unless GNANI_VOICE_ENABLED=true AND every limit below has a value (Phase 5).
  GNANI_VOICE_ENABLED: optionalText,
  GNANI_LANGUAGES: optionalText,
  GNANI_STT_MAX_SECONDS: optionalText,
  GNANI_TTS_MAX_CHARS: optionalText,
  GNANI_CREDITS_PER_STT_SECOND: optionalText,
  GNANI_CREDITS_PER_TTS_CHAR: optionalText,
  GNANI_MAX_CREDITS_PER_REQUEST: optionalText,
  GNANI_CUSTOMER_CREDITS_PER_HOUR: optionalText,
  GNANI_BUDGET_CREDITS: optionalText,
  // Signs voice transcripts so a save can tell them from typed text (server-only, R1-B).
  // Transcript translation: empty/"off" = typed English only; "live" = OpenRouter text model (needs its key and model).
  TRANSLATION_MODE: optionalText,
  VOICE_TRANSCRIPT_SECRET: z.preprocess(blankToUndefined, z.string().trim().min(32, "Use at least 32 characters.").optional()),

  // AI request limits (Phase 5)
  PROVIDER_TIMEOUT_MS: optionalText,
  AI_BRIEFS_PER_HOUR: optionalText,
  // OpenRouter reasoning effort for the brief and translation: "none", "minimal" or "low"; empty = model default.
  OPENROUTER_TEXT_REASONING_EFFORT: optionalText,
  OPENROUTER_DAILY_REQUEST_CAP: optionalText,

  // Manual payment display values (no gateway secrets)
  PAYMENT_MODE: optionalText,
  PAYMENT_UPI_ID: optionalText,
  PAYMENT_ACCOUNT_NAME: optionalText,
  PAYMENT_INSTRUCTIONS: optionalText,
  PAYMENT_CURRENCY: optionalText,
  // "true" shows the SIMULATED demo payment gateway (no money moves; an administrator still verifies).
  PAYMENT_MOCK_GATEWAY: optionalText,

  // Optional operational services (no error-monitoring service is adopted, so
  // there is deliberately no SENTRY_DSN; add it only if monitoring is approved)
  LOG_LEVEL: optionalText,
  RATE_LIMIT_MAX_REQUESTS: optionalText,
  RATE_LIMIT_WINDOW_SECONDS: optionalText,
});

export type AppEnv = z.infer<typeof envSchema>;

/** A problem with one variable. Carries the name only, never the submitted value. */
export type EnvIssue = {
  name: string;
  problem: "invalid format";
};

export type EnvResult =
  | { ok: true; env: AppEnv; issues: [] }
  | { ok: false; env: null; issues: EnvIssue[] };

type RawEnv = Record<string, string | undefined>;

/** Validates an environment object and returns issue names only. */
export function parseEnv(raw: RawEnv): EnvResult {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) return { ok: true, env: parsed.data, issues: [] };

  const seen = new Set<string>();
  const issues: EnvIssue[] = [];
  for (const issue of parsed.error.issues) {
    const name = String(issue.path[0] ?? "unknown");
    if (seen.has(name)) continue;
    seen.add(name);
    issues.push({ name, problem: "invalid format" });
  }
  return { ok: false, env: null, issues };
}

/** True when the variable holds a non-blank value. Never returns the value. */
export function isSet(raw: RawEnv, name: string): boolean {
  const value = raw[name];
  return typeof value === "string" && value.trim() !== "";
}
