import { requireUser } from "@/lib/auth/guards";
import { authProblem, firstIssue, newPasswordSchema, problemResponse } from "@/lib/auth/credentials";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { isAllowedOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Sets a new password for the signed-in account (after a reset link, or any time while signed
 * in). The session is checked with the Auth server first; there is no way to name another user.
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
  const body = newPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: { code: "INVALID_INPUT", message: firstIssue(body.error) } }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  try {
    await requireUser(supabase);
  } catch {
    return Response.json(
      { error: { code: "UNAUTHENTICATED", message: "Your reset link has expired or this browser is not signed in. Request a new link." } },
      { status: 401 },
    );
  }
  const { error } = await supabase.auth.updateUser({ password: body.data.password });
  if (error) return problemResponse(authProblem(error));
  return Response.json({ ok: true, redirect: "/projects" });
}
