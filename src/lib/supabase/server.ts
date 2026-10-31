import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { AuthError } from "@/lib/auth/errors";
import { getSupabasePublicConfig } from "./config";
import { createTimeoutFetch } from "./timeout";

/**
 * A Supabase client that acts AS THE SIGNED-IN USER (anon key + the user's session
 * cookies), so every query is subject to row level security. Use this for ordinary
 * customer and administrator requests.
 *
 * Create a new client per request; never share one between requests.
 * In Server Components cookies are read-only, so refreshed tokens are written by
 * src/proxy.ts instead; the try/catch below covers that case.
 */
export async function createSupabaseServerClient() {
  const config = getSupabasePublicConfig();
  if (!config) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Sign-in is not available yet.");
  }
  const cookieStore = await cookies();
  return createServerClient(config.url, config.anonKey, {
    global: { fetch: createTimeoutFetch() },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies cannot be written here.
        }
      },
    },
  });
}
