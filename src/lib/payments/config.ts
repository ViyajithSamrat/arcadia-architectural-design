import { isSet } from "@/lib/env/schema";

type RawEnv = Record<string, string | undefined>;

/**
 * The manual payment instructions a customer is shown, read from the server's
 * environment (ENVIRONMENT_VARIABLES.md section 6). They are display values only: no
 * gateway, no secret. Nothing here proves a payment, and nothing the browser sends can
 * change what is shown.
 *
 * Submission is allowed only when the instructions are ready. Anything missing or
 * inconsistent reads as "not configured" rather than a guess.
 */
export type PaymentDisplay =
  | { state: "not_configured"; reason: "mode" | "details" | "currency" }
  | {
      state: "ready";
      upiId: string | null;
      accountName: string | null;
      instructions: string | null;
      /** True when any value is labelled DEMO: the screen then says not to transfer money. */
      isDemo: boolean;
    };

export const PAYMENT_NOT_CONFIGURED = "Payment instructions not configured";

const MAX_TEXT = 1000;

function text(env: RawEnv, name: string): string | null {
  if (!isSet(env, name)) return null;
  return String(env[name]).trim().slice(0, MAX_TEXT);
}

/**
 * @param quoteCurrency the accepted quote's currency; a configured PAYMENT_CURRENCY must match it
 */
export function getPaymentDisplay(quoteCurrency: string, env: RawEnv = process.env): PaymentDisplay {
  if (text(env, "PAYMENT_MODE")?.toLowerCase() !== "manual") return { state: "not_configured", reason: "mode" };

  const upiId = text(env, "PAYMENT_UPI_ID");
  const instructions = text(env, "PAYMENT_INSTRUCTIONS");
  if (!upiId && !instructions) return { state: "not_configured", reason: "details" };

  const currency = text(env, "PAYMENT_CURRENCY");
  if (currency && currency.toUpperCase() !== quoteCurrency.toUpperCase()) {
    return { state: "not_configured", reason: "currency" };
  }

  const accountName = text(env, "PAYMENT_ACCOUNT_NAME");
  const isDemo = [upiId, accountName, instructions].some((v) => v !== null && /\bdemo\b/i.test(v));
  return { state: "ready", upiId, accountName, instructions, isDemo };
}
