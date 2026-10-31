import "server-only";
import { createClient } from "@supabase/supabase-js";
import { AuthError } from "@/lib/auth/errors";
import { getServiceRoleKey, getSupabasePublicConfig } from "./config";
import { createTimeoutFetch } from "./timeout";

/**
 * A client using the SERVICE ROLE key. It bypasses row level security, so it must
 * be used only in trusted server code, only AFTER the caller has been authenticated
 * and authorized (requireUser / requireAdmin and an ownership check), and never to
 * serve ordinary customer reads. The database workflow guards still apply to it.
 *
 * `server-only` makes importing this file from browser code a build error.
 */
export function createSupabaseServiceClient() {
  const config = getSupabasePublicConfig();
  const serviceKey = getServiceRoleKey();
  if (!config || !serviceKey) {
    throw new AuthError(503, "AUTH_NOT_CONFIGURED", "Server-side data access is not available yet.");
  }
  return createClient(config.url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createTimeoutFetch() },
  });
}
