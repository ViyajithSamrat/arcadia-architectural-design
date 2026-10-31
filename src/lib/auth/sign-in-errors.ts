/**
 * Why a redirect-based sign-in failed (Google, an email confirmation or a password reset link),
 * as far as Supabase Auth tells us. Only error codes the Auth library documents are mapped;
 * anything else gets the general message.
 */

export type SignInErrorReason = "expired" | "browser" | "1";

const EXPIRED_CODES = new Set(["otp_expired", "flow_state_expired", "flow_state_not_found"]);
const OTHER_BROWSER_CODES = new Set(["pkce_code_verifier_not_found", "bad_code_verifier"]);

/** The `error` value the callback puts on /sign-in for a Supabase error code. */
export function signInErrorReason(code: string | null | undefined): SignInErrorReason {
  if (code && EXPIRED_CODES.has(code)) return "expired";
  if (code && OTHER_BROWSER_CODES.has(code)) return "browser";
  return "1";
}

/** The message /sign-in shows for its `error` query value (any unknown value is general). */
export function signInErrorMessage(value: string): string {
  if (value === "expired") return "That link has expired or was already used. Sign in again, or request a new email below.";
  if (value === "browser") {
    return "That sign-in was finished in a different browser or window from the one that started it. Start again here and finish in this same window.";
  }
  return "Sign-in did not complete. Try again, or use another way to sign in below.";
}
