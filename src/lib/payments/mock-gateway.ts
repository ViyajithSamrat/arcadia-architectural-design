import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSet } from "@/lib/env/schema";
import { getLatestQuote, getOwnedProject } from "@/lib/journeys/service";
import { minorToDecimal, toMinor } from "@/lib/journeys/money";
import { submitPayment, type ServiceResult } from "./service";

/**
 * A SIMULATED payment gateway for demonstrations: a checkout dialog with success, failure and
 * cancel outcomes, in the style of a hosted gateway such as Razorpay. It is not Razorpay and
 * talks to no payment service. No money moves and no card, UPI or bank details are collected.
 *
 * What "success" does, and does not do:
 *  - It records an ordinary payment CLAIM (PENDING_REVIEW) through submitPayment, with the
 *    amount taken from the accepted quote on the server and a reference the server makes up
 *    (MOCKPAY-…). The browser sends no amount, status, reference or owner.
 *  - It does NOT verify the payment. An administrator still verifies or rejects it with their
 *    own session, and generation stays blocked until then; release is unchanged.
 * Failure and cancel record nothing.
 *
 * Switched on only with PAYMENT_MOCK_GATEWAY=true, and only where the manual payment
 * instructions are configured (submitPayment refuses otherwise).
 */

export const MOCK_GATEWAY_REFERENCE_PREFIX = "MOCKPAY-";

export const isMockGatewayReference = (reference: string): boolean => reference.toUpperCase().startsWith(MOCK_GATEWAY_REFERENCE_PREFIX);

export function isMockGatewayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isSet(env, "PAYMENT_MOCK_GATEWAY") && String(env.PAYMENT_MOCK_GATEWAY).trim().toLowerCase() === "true";
}

/** MOCKPAY- and 12 random upper-case hex characters: 20 characters, within the reference rules. */
export const newMockReference = (): string => `${MOCK_GATEWAY_REFERENCE_PREFIX}${randomBytes(6).toString("hex").toUpperCase()}`;

const today = (now: Date) => now.toISOString().slice(0, 10);

/**
 * The "successful" outcome of the simulated checkout for the owner's own project.
 * @param supabase the customer's own session client (row level security applies)
 * @param service  trusted client, passed through to submitPayment for its own clean-up only
 */
export async function payWithMockGateway(
  supabase: SupabaseClient,
  service: SupabaseClient,
  userId: string,
  projectId: string,
  options: { now?: Date; env?: Record<string, string | undefined>; newReference?: () => string } = {},
): Promise<ServiceResult<{ paymentId: string; reference: string }>> {
  if (!isMockGatewayEnabled(options.env)) return { ok: false, message: "The demo payment gateway is not switched on." };
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return { ok: false, message: "We could not find that project." };
  const quote = await getLatestQuote(supabase, projectId);
  if (!quote || !quote.acceptedAt) return { ok: false, message: "Payment can be made only for an accepted quote." };

  const now = options.now ?? new Date();
  const reference = (options.newReference ?? newMockReference)();
  const result = await submitPayment(
    supabase,
    service,
    userId,
    projectId,
    { utrReference: reference, transferDate: today(now), amount: minorToDecimal(toMinor(quote.totalAmount)), method: "UPI", file: null },
    { now, env: options.env, mockGateway: true },
  );
  return result.ok ? { ok: true, paymentId: result.paymentId, reference } : result;
}
