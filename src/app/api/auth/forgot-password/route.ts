import { NextResponse } from "next/server";
import { rememberRecovery } from "@/lib/auth/cookies";
import { authProblem, emailOnlySchema, firstIssue, problemResponse } from "@/lib/auth/credentials";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { isAllowedOrigin, resolveRequestOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const GENERIC = {
  ok: true,
  message: "If an account uses that address, a password reset link is on its way. Open it in this same browser window.",
};

/**
 * Sends a password reset email. The answer is the same whether or not the account exists. The
 * link returns through /auth/callback; a flag cookie tells the callback to continue to
 * /reset-password, where the signed-in (recovery) session sets the new password.
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
  const body = emailOnlySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: { code: "INVALID_INPUT", message: firstIssue(body.error) } }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(body.data.email, {
    redirectTo: `${resolveRequestOrigin(request)}/auth/callback`,
  });
  // No email can be sent at all (no custom SMTP yet): say so, rather than promise a link that will not come.
  if (error?.code === "email_address_not_authorized") return problemResponse(authProblem(error));
  if (error && (error.status === undefined || error.status >= 500 || error.status === 429)) {
    const limited = error.status === 429;
    return Response.json(
      {
        error: {
          code: limited ? "RATE_LIMITED" : "AUTH_UNAVAILABLE",
          message: limited ? "Too many attempts. Wait a few minutes and try again." : "Could not send the email right now. Try again shortly.",
        },
      },
      { status: limited ? 429 : 503 },
    );
  }
  const response = NextResponse.json(GENERIC);
  rememberRecovery(response, request);
  return response;
}
