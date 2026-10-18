import { isSet } from "@/lib/env/schema";
import { resolveAppOrigin } from "./config";

type RawEnv = Record<string, string | undefined>;

/**
 * Which origins may call the sign-in and sign-out routes, and which origin the sign-in
 * link returns to.
 *
 * Next.js reports `request.url` as http://localhost:<port> whatever host the browser used,
 * so comparing the browser's Origin with `request.url` rejects a legitimate visit to
 * http://127.0.0.1:<port>. The rules here are explicit instead:
 *
 *  - The expected origin is NEXT_PUBLIC_APP_URL when set, otherwise the origin of `request.url`.
 *  - For local development only, `localhost` and `127.0.0.1` count as the same machine, so
 *    each is accepted when the other is expected (same scheme and port required).
 *  - Nothing else is accepted. In particular X-Forwarded-Host / X-Forwarded-Proto are never
 *    read, and the Host header only ever selects among the origins allowed above.
 */

const LOOPBACK_TWINS: Record<string, string> = { localhost: "127.0.0.1", "127.0.0.1": "localhost" };

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The set of origins this deployment accepts. */
export function allowedOrigins(requestUrl: string, env: RawEnv = process.env): Set<string> {
  const configured = isSet(env, "NEXT_PUBLIC_APP_URL") ? originOf(String(env.NEXT_PUBLIC_APP_URL).trim()) : null;
  const expected = configured ?? originOf(requestUrl);
  const allowed = new Set<string>();
  if (!expected) return allowed;
  allowed.add(expected);
  const url = new URL(expected);
  const twin = LOOPBACK_TWINS[url.hostname];
  if (twin) {
    url.hostname = twin;
    allowed.add(url.origin);
  }
  return allowed;
}

/**
 * A browser request is allowed when its Origin header is an allowed origin. A request with
 * no Origin header (a non-browser client, or a same-origin navigation) carries no
 * cross-site risk and is allowed, as before.
 */
export function isAllowedOrigin(request: Request, env: RawEnv = process.env): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return allowedOrigins(request.url, env).has(origin);
}

/**
 * The origin to build sign-in redirects from: the one the browser actually used when that is
 * an allowed origin (so the cookie set at sign-in and the callback share a host), otherwise
 * the configured or request origin.
 */
export function resolveRequestOrigin(request: Request, env: RawEnv = process.env): string {
  const allowed = allowedOrigins(request.url, env);
  const fromOrigin = request.headers.get("origin");
  if (fromOrigin && allowed.has(fromOrigin)) return fromOrigin;
  const host = request.headers.get("host");
  if (host) {
    const candidate = originOf(`${new URL(request.url).protocol}//${host}`);
    if (candidate && allowed.has(candidate)) return candidate;
  }
  return resolveAppOrigin(request.url, env);
}
