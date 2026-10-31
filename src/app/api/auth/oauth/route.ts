import { NextResponse } from "next/server";
import { rememberNextPath } from "@/lib/auth/cookies";
import { firstIssue, getAuthProviders, oauthSchema } from "@/lib/auth/credentials";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { isAllowedOrigin, resolveRequestOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Starts Google sign-in through Supabase Auth. The PKCE code verifier is stored in a cookie on
 * this response (by the Supabase server client), and Google returns through Supabase to the
 * existing /auth/callback, which exchanges the code. The browser is only handed Supabase's
 * authorize URL; no Google credential ever passes through this app.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return Response.json({ error: { code: "BAD_ORIGIN", message: "Request not allowed." } }, { status: 403 });
  }
  const config = getSupabasePublicConfig();
  if (!config) {
    return Response.json(
      { error: { code: "AUTH_NOT_CONFIGURED", message: "Sign-in is not available yet." } },
      { status: 503 },
    );
  }
  const body = oauthSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: { code: "INVALID_INPUT", message: firstIssue(body.error) } }, { status: 400 });
  }
  // Supabase builds the URL without checking the provider, so an unconfigured Google would
  // otherwise land the visitor on a raw error page.
  const providers = await getAuthProviders();
  if (!providers?.google) {
    return Response.json(
      { error: { code: "GOOGLE_NOT_CONFIGURED", message: "Google sign-in is not set up yet. Use your email and password instead." } },
      { status: 503 },
    );
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${resolveRequestOrigin(request)}/auth/callback`, skipBrowserRedirect: true },
  });
  if (error || !data.url || new URL(data.url).origin !== new URL(config.url).origin) {
    return Response.json(
      { error: { code: "AUTH_UNAVAILABLE", message: "Could not start Google sign-in. Try again shortly." } },
      { status: 503 },
    );
  }
  const response = NextResponse.json({ ok: true, url: data.url });
  rememberNextPath(response, request, body.data.next);
  return response;
}
