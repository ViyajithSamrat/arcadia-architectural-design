import { z } from "zod";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { createTimeoutFetch } from "@/lib/supabase/timeout";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password-rules";

/**
 * Email/password and Google sign-in helpers shared by the /api/auth routes and the sign-in page.
 * Supabase Auth stays the only identity system: these only validate input, map its documented
 * error codes to plain messages and read which providers the Auth server has switched on.
 */

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password-rules";

export const emailSchema = z.email("Enter a valid email address.").max(254, "Enter a valid email address.");
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters for your password.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters for your password.`);
const nextSchema = z.string().max(400).optional();

export const credentialsSchema = z.object({ email: emailSchema, password: passwordSchema, next: nextSchema });
/** Sign-in accepts any non-empty password: older or shorter ones are judged by Supabase. */
export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH, "Email or password is incorrect."),
  next: nextSchema,
});
export const emailOnlySchema = z.object({ email: emailSchema });
export const newPasswordSchema = z.object({ password: passwordSchema });
export const oauthSchema = z.object({ provider: z.literal("google"), next: nextSchema });

/** The first validation message, for a 400 answer. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the details and try again.";
}

export type AuthProblem = { status: number; code: string; message: string };

/**
 * Supabase Auth errors as answers to the browser. Only codes Supabase documents are mapped;
 * anything else is a generic failure, and the raw message is never passed through.
 */
export function authProblem(error: { code?: string; status?: number } | null | undefined): AuthProblem {
  const code = error?.code;
  switch (code) {
    case "invalid_credentials":
      return { status: 400, code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." };
    case "email_not_confirmed":
      return { status: 403, code: "EMAIL_NOT_CONFIRMED", message: "Confirm your email address first: open the link we sent you, then sign in." };
    case "user_already_exists":
    case "email_exists":
      return { status: 409, code: "ACCOUNT_EXISTS", message: "An account with this email already exists. Sign in instead, or use Forgot password." };
    case "weak_password":
      return { status: 400, code: "WEAK_PASSWORD", message: "That password is too weak. Use a longer one that is harder to guess." };
    case "same_password":
      return { status: 400, code: "SAME_PASSWORD", message: "Choose a password different from your current one." };
    case "signup_disabled":
    case "email_provider_disabled":
      return { status: 403, code: "SIGNUP_DISABLED", message: "New accounts cannot be created right now." };
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return { status: 429, code: "RATE_LIMITED", message: "Too many attempts. Wait a few minutes and try again." };
    case "session_not_found":
    case "session_expired":
      return { status: 401, code: "SESSION_EXPIRED", message: "Your session has expired. Sign in again." };
  }
  if (error?.status === 429) return { status: 429, code: "RATE_LIMITED", message: "Too many attempts. Wait a few minutes and try again." };
  return { status: 503, code: "AUTH_UNAVAILABLE", message: "Sign-in is not available right now. Try again shortly." };
}

export function problemResponse(problem: AuthProblem): Response {
  return Response.json({ error: { code: problem.code, message: problem.message } }, { status: problem.status });
}

export type AuthProviders = { google: boolean; email: boolean; signupOpen: boolean; autoConfirm: boolean };

/**
 * What the Auth server has switched on, from its public settings endpoint (no secrets involved).
 * Null when Supabase is not configured or the settings cannot be read; callers then treat
 * Google as unavailable rather than guessing.
 */
export async function getAuthProviders(fetchImpl: typeof fetch = createTimeoutFetch()): Promise<AuthProviders | null> {
  const config = getSupabasePublicConfig();
  if (!config) return null;
  try {
    const res = await fetchImpl(`${config.url}/auth/v1/settings`, { headers: { apikey: config.anonKey }, cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { external?: Record<string, unknown>; disable_signup?: unknown; mailer_autoconfirm?: unknown };
    return {
      google: json.external?.google === true,
      email: json.external?.email === true,
      signupOpen: json.disable_signup !== true,
      autoConfirm: json.mailer_autoconfirm === true,
    };
  } catch {
    return null;
  }
}
