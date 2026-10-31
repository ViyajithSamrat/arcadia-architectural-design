import { NextResponse } from "next/server";
import { authProblem, firstIssue, problemResponse, signInSchema } from "@/lib/auth/credentials";
import { DEFAULT_AFTER_SIGN_IN, safeNextPath, withSignedInMarker } from "@/lib/auth/next-path";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { isAllowedOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Email and password sign-in. Supabase sets the session cookies on this response; the browser
 * then goes to the allow-listed return path. A wrong email and a wrong password get the same
 * answer, so the response does not reveal whether an account exists.
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
  const body = signInSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: { code: "INVALID_INPUT", message: firstIssue(body.error) } }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: body.data.email, password: body.data.password });
  if (error || !data.session) return problemResponse(authProblem(error));

  return NextResponse.json({ ok: true, redirect: withSignedInMarker(safeNextPath(body.data.next) ?? DEFAULT_AFTER_SIGN_IN) });
}
