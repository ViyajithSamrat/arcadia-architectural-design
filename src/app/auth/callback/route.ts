import { NextResponse } from "next/server";
import { getSupabasePublicConfig, resolveAppOrigin } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Completes magic-link sign-in. The destination is fixed (no `next` parameter),
 * which rules out open-redirect abuse.
 */
export async function GET(request: Request): Promise<Response> {
  const origin = resolveAppOrigin(request.url);
  const code = new URL(request.url).searchParams.get("code");
  if (!code || !getSupabasePublicConfig()) {
    return NextResponse.redirect(`${origin}/sign-in?error=1`);
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  return NextResponse.redirect(error ? `${origin}/sign-in?error=1` : `${origin}/`);
}
