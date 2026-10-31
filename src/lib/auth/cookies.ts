import type { NextResponse } from "next/server";
import { resolveRequestOrigin } from "@/lib/supabase/origin";
import { NEXT_PATH_COOKIE, NEXT_PATH_MAX_AGE_SECONDS, RECOVERY_COOKIE, RECOVERY_MAX_AGE_SECONDS, safeNextPath } from "./next-path";

/**
 * Short-lived, http-only cookies read only by /auth/callback. They carry no identity: one is an
 * allow-listed return path, the other a flag that the email was a password reset.
 */
function options(request: Request, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: new URL(resolveRequestOrigin(request)).protocol === "https:",
    path: "/auth/callback",
    maxAge,
  };
}

/** Remembers `next` for the callback when it is an allow-listed application path. */
export function rememberNextPath(response: NextResponse, request: Request, next: unknown): void {
  const path = safeNextPath(next);
  if (path) response.cookies.set(NEXT_PATH_COOKIE, path, options(request, NEXT_PATH_MAX_AGE_SECONDS));
}

export function rememberRecovery(response: NextResponse, request: Request): void {
  response.cookies.set(RECOVERY_COOKIE, "1", options(request, RECOVERY_MAX_AGE_SECONDS));
}

/** The cookie value from a raw Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}
