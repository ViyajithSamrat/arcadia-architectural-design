import { NextResponse } from "next/server";
import { readCookie } from "@/lib/auth/cookies";
import {
  DEFAULT_AFTER_SIGN_IN,
  NEXT_PATH_COOKIE,
  RECOVERY_COOKIE,
  RESET_PASSWORD_PATH,
  safeNextPath,
  withSignedInMarker,
} from "@/lib/auth/next-path";
import { signInErrorReason } from "@/lib/auth/sign-in-errors";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { resolveRequestOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Completes every redirect-based sign-in: Google (OAuth), the email confirmation link after
 * registration, and the password reset link. All of them use the PKCE code exchange, so they
 * must finish in the browser that started them.
 *
 * There is no `next` query parameter, which rules out open-redirect abuse: the destination is
 * the allow-listed path remembered by the starting request (next-path.ts), on this same origin,
 * or My projects; a reset link goes to the new-password page instead.
 */
export async function GET(request: Request): Promise<Response> {
  const origin = resolveRequestOrigin(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (!code || !getSupabasePublicConfig()) {
    // Supabase (and Google, through it) sends a failed attempt back with error_code instead of a code.
    return NextResponse.redirect(`${origin}/sign-in?error=${signInErrorReason(params.get("error_code"))}`);
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/sign-in?error=${signInErrorReason(error.code)}`);

  const cookies = request.headers.get("cookie");
  const recovery = readCookie(cookies, RECOVERY_COOKIE) === "1";
  const remembered = readCookie(cookies, NEXT_PATH_COOKIE);
  const destination = recovery ? RESET_PASSWORD_PATH : withSignedInMarker(safeNextPath(remembered) ?? DEFAULT_AFTER_SIGN_IN);
  const response = NextResponse.redirect(`${origin}${destination}`);
  if (remembered !== null) response.cookies.set(NEXT_PATH_COOKIE, "", { path: "/auth/callback", maxAge: 0 });
  if (recovery) response.cookies.set(RECOVERY_COOKIE, "", { path: "/auth/callback", maxAge: 0 });
  return response;
}
