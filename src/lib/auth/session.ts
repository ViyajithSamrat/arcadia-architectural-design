import type { User } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** The signed-in user, or null (also null when Supabase is not configured). */
export async function getCurrentUser(): Promise<User | null> {
  if (!getSupabasePublicConfig()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
}

export type AccountSummary = { email: string | null; isAdmin: boolean };

/**
 * What the headers show about the signed-in account, or null when nobody is signed in.
 * isAdmin is display only: it comes from the database's public.is_admin() and is false on
 * any error. Admin pages and actions still check with requireAdmin themselves.
 */
export async function getAccountSummary(): Promise<AccountSummary | null> {
  if (!getSupabasePublicConfig()) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const admin = await supabase.rpc("is_admin");
  return { email: data.user.email ?? null, isAdmin: !admin.error && admin.data === true };
}
