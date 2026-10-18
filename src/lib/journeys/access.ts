import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth/session";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PageAccess =
  | { state: "not_configured" }
  | { state: "signed_out" }
  | { state: "ok"; user: User; supabase: SupabaseClient };

/**
 * Who is looking at this page. Pages render a sign-in prompt unless the state is "ok";
 * every data read and every action still checks ownership again.
 */
export async function getPageAccess(): Promise<PageAccess> {
  if (!getSupabasePublicConfig()) return { state: "not_configured" };
  const user = await getCurrentUser();
  if (!user) return { state: "signed_out" };
  return { state: "ok", user, supabase: await createSupabaseServerClient() };
}
