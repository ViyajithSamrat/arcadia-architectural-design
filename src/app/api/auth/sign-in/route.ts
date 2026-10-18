import { z } from "zod";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { isAllowedOrigin, resolveRequestOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const bodySchema = z.object({ email: z.email().max(254) });

const GENERIC = { ok: true, message: "If that address can sign in, a link is on its way." };

/** Sends a magic link. The response never reveals whether an account exists. */
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
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: { code: "INVALID_EMAIL", message: "Enter a valid email address." } }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: body.data.email,
    options: { emailRedirectTo: `${resolveRequestOrigin(request)}/auth/callback` },
  });
  if (error && (error.status === undefined || error.status >= 500 || error.status === 429)) {
    return Response.json(
      { error: { code: "AUTH_UNAVAILABLE", message: "Could not send the link right now. Try again shortly." } },
      { status: 503 },
    );
  }
  return Response.json(GENERIC);
}
