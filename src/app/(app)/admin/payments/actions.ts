"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthError } from "@/lib/auth/errors";
import { requireAdmin } from "@/lib/auth/guards";
import { rejectPayment, verifyPayment, type ServiceResult } from "@/lib/payments/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Server Actions for the administrator's payment decision. They are public endpoints:
 * each one checks the administrator role on the server, and then acts through the
 * administrator's OWN session (never the service role), so the database functions
 * record who decided. Every argument is treated as untrusted.
 */

export type DecisionState = { ok: false; message: string; fieldErrors?: Record<string, string> } | undefined;

const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
const BAD_REQUEST: DecisionState = { ok: false, message: "That request was not valid." };

async function asAdmin(work: (supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) => Promise<ServiceResult>): Promise<ServiceResult> {
  try {
    const supabase = await createSupabaseServerClient();
    await requireAdmin(supabase);
    return await work(supabase);
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    throw error;
  }
}

function done(paymentId: string): never {
  revalidatePath("/admin/payments", "layout");
  redirect(`/admin/payments/${paymentId}?decided=1`);
}

export async function verifyPaymentAction(paymentId: string, confirmedAmount: string, note: string, acknowledged: boolean): Promise<DecisionState> {
  if (!isId(paymentId) || typeof confirmedAmount !== "string" || typeof note !== "string") return BAD_REQUEST;
  const result = await asAdmin((supabase) => verifyPayment(supabase, paymentId, { confirmedAmount, note, acknowledged: acknowledged === true }));
  if (!result.ok) return { ok: false, message: result.message, fieldErrors: result.fieldErrors };
  done(paymentId);
}

export async function rejectPaymentAction(paymentId: string, reason: string, note: string): Promise<DecisionState> {
  if (!isId(paymentId) || typeof reason !== "string" || typeof note !== "string") return BAD_REQUEST;
  const result = await asAdmin((supabase) => rejectPayment(supabase, paymentId, { reason, note }));
  if (!result.ok) return { ok: false, message: result.message, fieldErrors: result.fieldErrors };
  done(paymentId);
}
