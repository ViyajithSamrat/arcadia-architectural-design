/**
 * Response security headers sent on every page and route handler (wired in next.config.ts).
 *
 * INTERIM BASELINE, NOT COMPLETE CSP HARDENING. The policy allows inline scripts and inline
 * styles ('unsafe-inline'). The app uses Cache Components, so pages are prerendered shells that
 * carry inline bootstrap scripts and next/image inline styles, and a per-request nonce cannot be
 * added to a page that was built ahead of time. As a result this policy does NOT stop an
 * injected inline script from running. What it does stop: framing (clickjacking), plugins, a
 * changed <base> URL, form posts to other sites, scripts and styles loaded from other origins,
 * and images, media, fonts and network connections to origins that are not listed below.
 * Moving to nonce or hash based script rules is future work and needs the rendering decision
 * revisited.
 *
 * Pure and dependency free (no "@/" imports) because next.config.ts loads this file. It reads
 * only three variables and never copies a key or token into a header: NODE_ENV, the public
 * Supabase URL (only its origin is used) and the public application URL (only to decide whether
 * the site is served over HTTPS).
 */

export type SecurityHeader = { key: string; value: string };

export type SecurityHeaderEnv = Readonly<Record<string, string | undefined>>;

// Scheme, a plain host name or IPv4 address, and an optional port. Anything else (credentials,
// IPv6, ";" or "," that could end a CSP directive, wildcards) is refused rather than escaped.
const SAFE_ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

/**
 * The origin ("https://host[:port]") of an http(s) URL, or null when the value is missing,
 * malformed, carries credentials, or cannot be written safely into a CSP source list.
 */
export function safeHttpOrigin(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  return SAFE_ORIGIN.test(url.origin) ? url.origin : null;
}

/**
 * The Content-Security-Policy value. Image sources are the site itself, data: URLs (the
 * illustrative floor plan is a data: SVG) and the Supabase origin that serves signed links to
 * private files. Media allows blob: for the spoken read-back player. Fonts are self-hosted by
 * next/font at build time. The browser never talks to Supabase or any AI provider directly, so
 * connections stay on the site itself.
 */
export function buildContentSecurityPolicy(env: SecurityHeaderEnv): string {
  const supabaseOrigin = safeHttpOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  const servedOverHttps = safeHttpOrigin(env.NEXT_PUBLIC_APP_URL)?.startsWith("https:") ?? false;

  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${supabaseOrigin ? ` ${supabaseOrigin}` : ""}`,
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  // Upgrading requests would break a production build served over plain http://localhost.
  if (servedOverHttps) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/**
 * The headers to send. The CSP is production only: development needs eval and a hot-reload
 * connection that this policy forbids. The other headers are harmless everywhere. Each key
 * appears once.
 */
export function buildSecurityHeaders(env: SecurityHeaderEnv): SecurityHeader[] {
  const headers: SecurityHeader[] = [];
  if (env.NODE_ENV === "production") {
    headers.push({ key: "Content-Security-Policy", value: buildContentSecurityPolicy(env) });
  }
  headers.push(
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Voice input needs the microphone on this site only.
    { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()" },
  );
  return headers;
}
