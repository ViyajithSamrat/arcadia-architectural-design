import type { SupabaseClient, User } from "@supabase/supabase-js";
import { AuthError } from "./errors";

/**
 * Verifies the session with the Auth server (getUser), never by trusting the
 * cookie contents alone (getSession is not safe for authorization).
 */
export async function requireUser(supabase: SupabaseClient): Promise<User> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new AuthError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }
  return data.user;
}

/**
 * The admin check is the database's own: public.is_admin() reads the admin_users
 * table. Nothing the browser sends (role claims, metadata, query values) is used.
 */
export async function requireAdmin(supabase: SupabaseClient): Promise<User> {
  const user = await requireUser(supabase);
  const { data, error } = await supabase.rpc("is_admin");
  if (error || data !== true) {
    throw new AuthError(403, "FORBIDDEN", "You do not have access to this area.");
  }
  return user;
}
