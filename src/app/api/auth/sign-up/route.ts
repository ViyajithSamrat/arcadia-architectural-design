import { NextResponse } from "next/server";
import { rememberNextPath } from "@/lib/auth/cookies";
import { authProblem, credentialsSchema, firstIssue, problemResponse } from "@/lib/auth/credentials";
import { DEFAULT_AFTER_SIGN_IN, safeNextPath, withSignedInMarker } from "@/lib/auth/next-path";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { isAllowedOrigin, resolveRequestOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const CHECK_EMAIL =
  "Check your email and open the confirmation link in this same browser window to finish creating your account. If you already have an account, sign in instead.";

/**
 * Self-service registration for customers. A new account is an ordinary customer: nothing here
 * (or in the database) grants administrator rights, which come only from public.admin_users.
 *
 * Whether the account is usable at once depends on the Auth server's email confirmation setting:
 *   - confirmation off: Supabase returns a session and the browser goes straight on;
 *   - confirmation on: no session; the emailed link comes back through /auth/callback.
 * With confirmation on, Supabase answers an already-registered email the same way as a new one
 * (to avoid revealing accounts), so the reply then says to sign in if they already have one.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return Response.json({ error: { code: "BAD_ORIGIN", message: "Request not allowed." } }, { status: 403 });
  }
  if (!getSupabasePublicConfig()) {
    return Response.json(
      { error: { code: "AUTH_NOT_CONFIGURED", message: "Sign-in is not available yet." } },
      { status: 503 },
    );
  }
  const body = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: { code: "INVALID_INPUT", message: firstIssue(body.error) } }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: body.data.email,
    password: body.data.password,
    options: { emailRedirectTo: `${resolveRequestOrigin(request)}/auth/callback` },
  });
  if (error) return problemResponse(authProblem(error));

  if (data.session) {
    return NextResponse.json({ ok: true, redirect: withSignedInMarker(safeNextPath(body.data.next) ?? DEFAULT_AFTER_SIGN_IN) });
  }
  const response = NextResponse.json({ ok: true, confirm: true, message: CHECK_EMAIL });
  rememberNextPath(response, request, body.data.next);
  return response;
}
