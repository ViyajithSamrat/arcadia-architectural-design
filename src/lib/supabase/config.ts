import { isSet, parseEnv } from "@/lib/env/schema";

type RawEnv = Record<string, string | undefined>;

export type SupabasePublicConfig = {
  url: string;
  /** The publishable key (`sb_publishable_…`) or, as a fallback, the legacy anon key. Browser-safe. */
  publicKey: string;
};

/** Modern name first; the legacy name stays as a fallback for the local Docker stack. */
export const SUPABASE_PUBLIC_KEY_VARS = ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
export const SUPABASE_SECRET_KEY_VARS = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

function firstSet(env: RawEnv, names: readonly string[]): string | null {
  const name = names.find((n) => isSet(env, n));
  return name ? String(env[name]).trim() : null;
}

/**
 * The browser-safe Supabase settings. Returns null (never throws) when they are
 * absent or malformed, so callers can show a "not configured" state instead of
 * failing. A secret key placed in a public variable counts as malformed. A
 * configured value is NOT proof the service works.
 */
export function getSupabasePublicConfig(env: RawEnv = process.env): SupabasePublicConfig | null {
  const publicKey = firstSet(env, SUPABASE_PUBLIC_KEY_VARS);
  if (!isSet(env, "NEXT_PUBLIC_SUPABASE_URL") || !publicKey) return null;
  if (!parseEnv(env).ok) return null;
  return { url: String(env.NEXT_PUBLIC_SUPABASE_URL).trim(), publicKey };
}

/** The elevated key: the secret key, else the legacy service role key. Server-only. Never log it, never send it to a browser. */
export function getServiceRoleKey(env: RawEnv = process.env): string | null {
  return firstSet(env, SUPABASE_SECRET_KEY_VARS);
}

/** The public origin used in sign-in links: the configured app URL, else the request's own origin. */
export function resolveAppOrigin(requestUrl: string, env: RawEnv = process.env): string {
  if (isSet(env, "NEXT_PUBLIC_APP_URL")) {
    try {
      return new URL(String(env.NEXT_PUBLIC_APP_URL).trim()).origin;
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(requestUrl).origin;
}
