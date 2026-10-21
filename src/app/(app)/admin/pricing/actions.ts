"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthError } from "@/lib/auth/errors";
import { requireAdmin } from "@/lib/auth/guards";
import { publishRuleVersion } from "@/lib/pricing/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Server Action for the pricing screen. It is a public endpoint: it checks the administrator
 * role on the server (from the database, never from anything the browser sent) and every value
 * is validated again by publishRuleVersion. It writes with the administrator's own session, so
 * row level security and the audit trigger apply. Success is never reported from here: the
 * page reloads and shows what is really in force.
 */

export type PricingActionState = { ok: false; message: string; fieldErrors?: Record<string, string> } | undefined;

export async function publishPricingRuleAction(input: unknown, confirmed: boolean): Promise<PricingActionState> {
  if (confirmed !== true) return { ok: false, message: "Confirm that new quotes will use this rate.", fieldErrors: { confirm: "Tick the box to publish." } };
  try {
    const supabase = await createSupabaseServerClient();
    await requireAdmin(supabase);
    const result = await publishRuleVersion(supabase, input);
    if (!result.ok) return { ok: false, message: result.message, fieldErrors: result.fieldErrors };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath("/admin/pricing");
  redirect("/admin/pricing?published=1");
}
