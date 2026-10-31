/**
 * Where a signed-in visitor returns to after signing in (password, Google, or an email link).
 *
 * The callback URL itself stays fixed (`/auth/callback`, no query), so it keeps matching the
 * redirect URLs allowed in Supabase Auth and cannot be turned into an open redirect. The
 * wanted page is instead remembered in a short-lived, http-only cookie set by the sign-in
 * request, and only an allow-listed, same-origin application path is ever accepted.
 */

export const NEXT_PATH_COOKIE = "aad_next";
/** Long enough to finish Google sign-in or open a confirmation email; links expire on Supabase's schedule. */
export const NEXT_PATH_MAX_AGE_SECONDS = 15 * 60;
/** Marks a password-reset email request, so the callback sends that browser to /reset-password. */
export const RECOVERY_COOKIE = "aad_recovery";
/** Matches Supabase's email link lifetime (auth.email.otp_expiry, 1 hour). */
export const RECOVERY_MAX_AGE_SECONDS = 60 * 60;
/** The page that sets a new password after a reset link. */
export const RESET_PASSWORD_PATH = "/reset-password";
/** Where the callback goes when no valid return path was remembered. */
export const DEFAULT_AFTER_SIGN_IN = "/projects";
/** Query marker the callback adds so the landing page can confirm the sign-in (display only). */
export const SIGNED_IN_PARAM = "signed_in";

/** The validated destination with the sign-in marker added (keeps an existing query). */
export function withSignedInMarker(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${SIGNED_IN_PARAM}=1`;
}

const MAX_LENGTH = 200;
/** Only application pages: a project, a new-project journey or an administrator screen. */
const ALLOWED = /^\/(?:projects|new|admin)(?:\/[A-Za-z0-9_-]+)*\/?(?:\?[A-Za-z0-9_=&-]*)?$/;

/** The path when it is a safe in-app destination, otherwise null. Never returns an absolute URL. */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (path.length === 0 || path.length > MAX_LENGTH) return null;
  return ALLOWED.test(path) ? path : null;
}
