import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { AuthError } from "@/lib/auth/errors";
import { requireAdmin } from "@/lib/auth/guards";
import { getPageAccess, type PageAccess } from "@/lib/journeys/access";

export type AdminAccess =
  | Exclude<PageAccess, { state: "ok" }>
  | { state: "forbidden" }
  | { state: "ok"; user: User; supabase: SupabaseClient };

/**
 * Who is looking at an administrator page. The role is read from the database
 * (public.is_admin), never from anything the browser sent. Every administrator page and
 * action calls this or requireAdmin itself; hiding a link would not be authorization.
 */
export async function getAdminAccess(): Promise<AdminAccess> {
  const access = await getPageAccess();
  if (access.state !== "ok") return access;
  try {
    await requireAdmin(access.supabase);
    return access;
  } catch (error) {
    if (error instanceof AuthError && error.status === 403) return { state: "forbidden" };
    throw error;
  }
}
