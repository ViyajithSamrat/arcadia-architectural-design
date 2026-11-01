"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AuthError } from "@/lib/auth/errors";
import { requireAdmin } from "@/lib/auth/guards";
import { startAutomaticGeneration } from "@/lib/generation/auto";
import { rejectPayment, verifyPayment, type ServiceResult } from "@/lib/payments/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * Server Actions for the administrator's payment decision. They are public endpoints:
 * each one checks the administrator role on the server, and then acts through the
 * administrator's OWN session (never the service role), so the database functions
 * record who decided. Every argument is treated as untrusted.
 */

export type DecisionState = { ok: false; message: string; fieldErrors?: Record<string, string> } | undefined;

const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
const BAD_REQUEST: DecisionState = { ok: false, message: "That request was not valid." };

async function asAdmin(work: (supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, adminId: string) => Promise<ServiceResult>): Promise<ServiceResult> {
  try {
    const supabase = await createSupabaseServerClient();
    const admin = await requireAdmin(supabase);
    return await work(supabase, admin.id);
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    throw error;
  }
}

function done(paymentId: string): never {
  // The whole admin area: the overview's pending count as well as the payment pages.
  revalidatePath("/admin", "layout");
  redirect(`/admin/payments/${paymentId}?decided=1`);
}

/**
 * Starts the generation that follows a verification, after the response has been sent, so the
 * administrator does not wait for the image provider. The decision is already committed and the
 * project is PAYMENT_VERIFIED, which is the durable record that generation is owed: if this run
 * never happens (the process ends first), the customer's status poll starts it later. A failure
 * here is logged without detail and never changes the decision.
 */
function scheduleAutomaticGeneration(projectId: string, adminId: string): void {
  after(async () => {
    try {
      await startAutomaticGeneration(createSupabaseServiceClient(), { projectId, actorId: adminId });
    } catch {
      console.error(JSON.stringify({ event: "generation.auto_schedule_failed", at: new Date().toISOString(), project_id: projectId }));
    }
  });
}

export async function verifyPaymentAction(paymentId: string, confirmedAmount: string, note: string, acknowledged: boolean): Promise<DecisionState> {
  if (!isId(paymentId) || typeof confirmedAmount !== "string" || typeof note !== "string") return BAD_REQUEST;
  const verified: { projectId: string | null; adminId: string | null } = { projectId: null, adminId: null };
  const result = await asAdmin(async (supabase, adminId) => {
    const outcome = await verifyPayment(supabase, paymentId, { confirmedAmount, note, acknowledged: acknowledged === true });
    if (outcome.ok) Object.assign(verified, { projectId: outcome.projectId, adminId });
    return outcome;
  });
  if (!result.ok) return { ok: false, message: result.message, fieldErrors: result.fieldErrors };
  if (verified.projectId && verified.adminId) scheduleAutomaticGeneration(verified.projectId, verified.adminId);
  done(paymentId);
}

export async function rejectPaymentAction(paymentId: string, reason: string, note: string): Promise<DecisionState> {
  if (!isId(paymentId) || typeof reason !== "string" || typeof note !== "string") return BAD_REQUEST;
  const result = await asAdmin((supabase) => rejectPayment(supabase, paymentId, { reason, note }));
  if (!result.ok) return { ok: false, message: result.message, fieldErrors: result.fieldErrors };
  done(paymentId);
}
