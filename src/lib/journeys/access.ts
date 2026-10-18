import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { connection } from "next/server";
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
  // Reading the session is per-request work. Without this, the Supabase auth client is
  // constructed while the page is prerendered and reads the clock (Date.now()), which Next.js
  // reports as an error even though the page still renders.
  await connection();
  if (!getSupabasePublicConfig()) return { state: "not_configured" };
  const user = await getCurrentUser();
  if (!user) return { state: "signed_out" };
  return { state: "ok", user, supabase: await createSupabaseServerClient() };
}
