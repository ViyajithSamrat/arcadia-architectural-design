import { isSet, parseEnv } from "@/lib/env/schema";

type RawEnv = Record<string, string | undefined>;

export type SupabasePublicConfig = {
  url: string;
  anonKey: string;
};

/**
 * The browser-safe Supabase settings. Returns null (never throws) when they are
 * absent or malformed, so callers can show a "not configured" state instead of
 * failing. A configured value is NOT proof the service works.
 */
export function getSupabasePublicConfig(env: RawEnv = process.env): SupabasePublicConfig | null {
  if (!isSet(env, "NEXT_PUBLIC_SUPABASE_URL") || !isSet(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY")) return null;
  if (!parseEnv(env).ok) return null;
  return {
    url: String(env.NEXT_PUBLIC_SUPABASE_URL).trim(),
    anonKey: String(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).trim(),
  };
}

/** The elevated key. Server-only. Never log it, never send it to a browser. */
export function getServiceRoleKey(env: RawEnv = process.env): string | null {
  return isSet(env, "SUPABASE_SERVICE_ROLE_KEY") ? String(env.SUPABASE_SERVICE_ROLE_KEY).trim() : null;
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
