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

export const envSchema = z.object({
  // Application
  NEXT_PUBLIC_APP_URL: optionalUrl,
  APP_BASE_URL: optionalUrl,
  ADMIN_EMAILS: optionalText,

  // Supabase (service role key and DB URL are server-only)
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalText,
  SUPABASE_SERVICE_ROLE_KEY: optionalText,
  SUPABASE_DB_URL: optionalText,
  SUPABASE_STORAGE_BUCKET: optionalText,

  // OpenRouter (server-only)
  OPENROUTER_API_KEY: optionalText,
  OPENROUTER_BASE_URL: optionalUrl,
  OPENROUTER_TEXT_MODEL: optionalText,
  OPENROUTER_IMAGE_MODEL: optionalText,
  OPENROUTER_HTTP_REFERER: optionalUrl,
  OPENROUTER_APP_TITLE: optionalText,

  // Gnani speech-to-text / text-to-speech (server-only; details unverified)
  GNANI_API_KEY: optionalText,
  GNANI_BASE_URL: optionalUrl,
  GNANI_STT_ENDPOINT: optionalText,
  GNANI_TTS_ENDPOINT: optionalText,
  GNANI_STT_MODEL: optionalText,
  GNANI_TTS_MODEL: optionalText,
  GNANI_TTS_VOICE: optionalText,

  // Manual payment display values (no gateway secrets)
  PAYMENT_MODE: optionalText,
  PAYMENT_UPI_ID: optionalText,
  PAYMENT_ACCOUNT_NAME: optionalText,
  PAYMENT_INSTRUCTIONS: optionalText,
  PAYMENT_CURRENCY: optionalText,

  // Optional operational services
  SENTRY_DSN: optionalText,
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
