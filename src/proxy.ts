import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

/**
 * Refreshes the Supabase session cookies on every page and route (static files excluded).
 * Server Components cannot write cookies, so without this a refreshed token is never saved
 * and, once the one-hour access token expires, the rotated refresh token is reused and
 * Supabase ends the session. It does not authorize anything; every route and database
 * policy checks access itself. When Supabase is not configured it passes requests through.
 */
export async function proxy(request: NextRequest) {
  const config = getSupabasePublicConfig();
  if (!config) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(config.url, config.publicKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });
  await supabase.auth.getUser();
  return response;
}

export const config = {
  // Everything except Next.js internals (build output, image optimisation and the development
  // hot-reload connection) and public static files.
  matcher: ["/((?!_next/|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|txt|woff2?)$).*)"],
};
