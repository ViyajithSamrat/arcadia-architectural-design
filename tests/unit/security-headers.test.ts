import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  safeHttpOrigin,
  type SecurityHeader,
} from "@/lib/security/headers";

const HOSTED_SUPABASE = "https://abcdefghij.supabase.co";
const PRODUCTION = { NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: `${HOSTED_SUPABASE}/`, NEXT_PUBLIC_APP_URL: "https://arcadia.vercel.app" };

function byKey(headers: SecurityHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((h) => [h.key, h.value]));
}

/** Directive name -> its sources, from a CSP value. */
function parse(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name, sources);
  }
  return map;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("security headers", () => {
  it("sends the four fixed headers with their reviewed values", () => {
    const headers = byKey(buildSecurityHeaders(PRODUCTION));
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toBe("camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
  });

  it("keeps the microphone for this site (voice input) and denies camera, location, payment and USB", () => {
    const policy = parse(byKey(buildSecurityHeaders(PRODUCTION))["Permissions-Policy"].replaceAll(",", ";").replaceAll("=", " "));
    expect(policy.get("microphone")).toEqual(["(self)"]);
    for (const feature of ["camera", "geolocation", "payment", "usb"]) expect(policy.get(feature)).toEqual(["()"]);
  });

  it("adds the Content-Security-Policy in production only", () => {
    expect(Object.keys(byKey(buildSecurityHeaders({ NODE_ENV: "production" })))).toContain("Content-Security-Policy");
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }, {}]) {
      const headers = byKey(buildSecurityHeaders(env));
      expect(headers["Content-Security-Policy"]).toBeUndefined();
      // The other four still apply, so local development is checked against them too.
      expect(Object.keys(headers).sort()).toEqual(["Permissions-Policy", "Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options"]);
    }
  });

  it("never repeats a header key and never puts a line break in a value", () => {
    for (const env of [PRODUCTION, { NODE_ENV: "development" }, {}]) {
      const headers = buildSecurityHeaders(env);
      const keys = headers.map((h) => h.key.toLowerCase());
      expect(new Set(keys).size).toBe(keys.length);
      for (const h of headers) expect(h.value).not.toMatch(/[\r\n]/);
    }
  });
});

describe("Content-Security-Policy", () => {
  const csp = buildContentSecurityPolicy(PRODUCTION);
  const directives = parse(csp);

  it("is exactly the reviewed policy", () => {
    expect(csp).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        `img-src 'self' data: ${HOSTED_SUPABASE}`,
        "font-src 'self'",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
      ].join("; "),
    );
  });

  it("locks down framing, plugins, the base URL and form targets", () => {
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("frame-src")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(directives.get("form-action")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
  });

  it("allows inline script and style (the documented interim limit) and nowhere else", () => {
    const inline = [...directives].filter(([, sources]) => sources.includes("'unsafe-inline'")).map(([name]) => name);
    expect(inline.sort()).toEqual(["script-src", "style-src"]);
  });

  it("never allows eval, wildcards, bare schemes or remote script origins", () => {
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("*");
    const scripts = directives.get("script-src") ?? [];
    expect(scripts).toEqual(["'self'", "'unsafe-inline'"]);
    for (const sources of directives.values()) {
      for (const source of sources) expect(source).not.toMatch(/^(https?|wss?):$/);
    }
  });

  it("lists every directive once", () => {
    const names = csp.split(";").map((part) => part.trim().split(/\s+/)[0]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("allows what the app needs: data: floor plans, blob: audio, and the Supabase origin for signed images", () => {
    expect(directives.get("img-src")).toEqual(["'self'", "data:", HOSTED_SUPABASE]);
    expect(directives.get("media-src")).toEqual(["'self'", "blob:"]);
    expect(directives.get("font-src")).toEqual(["'self'"]);
  });
});

describe("Supabase image origin", () => {
  it.each([
    ["https://abcdefghij.supabase.co", "https://abcdefghij.supabase.co"],
    ["https://abcdefghij.supabase.co/", "https://abcdefghij.supabase.co"],
    ["  https://abcdefghij.supabase.co  ", "https://abcdefghij.supabase.co"],
    ["https://ABCDEFGHIJ.supabase.co/storage/v1/object?x=1#frag", "https://abcdefghij.supabase.co"],
    ["http://127.0.0.1:54321", "http://127.0.0.1:54321"],
    ["http://localhost:54321/", "http://localhost:54321"],
  ])("accepts %j as %j", (input, origin) => {
    expect(safeHttpOrigin(input)).toBe(origin);
    expect(parse(buildContentSecurityPolicy({ NEXT_PUBLIC_SUPABASE_URL: input })).get("img-src")).toEqual(["'self'", "data:", origin]);
  });

  it.each([
    undefined,
    "",
    "   ",
    "not a url",
    "javascript:alert(1)",
    "data:text/html,hello",
    "ftp://files.example.com",
    "//abcdefghij.supabase.co",
    "https://user:pass@abcdefghij.supabase.co",
    "https://abcdefghij.supabase.co;script-src *",
    "https://abcdefghij.supabase.co,https://evil.example",
    "https://*.supabase.co",
    "https://[::1]:54321",
    "https://exa mple.com",
  ])("refuses %j and falls back to the site itself", (input) => {
    expect(safeHttpOrigin(input)).toBeNull();
    const csp = buildContentSecurityPolicy({ NEXT_PUBLIC_SUPABASE_URL: input });
    expect(parse(csp).get("img-src")).toEqual(["'self'", "data:"]);
    // Nothing else about the policy changes, and nothing from the bad value leaks in.
    expect(csp).toBe(buildContentSecurityPolicy({}));
  });

  it("uses the origin only: no path, query, fragment or credentials", () => {
    const csp = buildContentSecurityPolicy({ NEXT_PUBLIC_SUPABASE_URL: `${HOSTED_SUPABASE}/rest/v1/?apikey=SECRET-QUERY-VALUE#SECRET-FRAGMENT` });
    expect(csp).toContain(HOSTED_SUPABASE);
    expect(csp).not.toContain("SECRET");
    expect(csp).not.toContain("rest/v1");
  });
});

describe("HTTPS upgrade", () => {
  it.each(["https://arcadia.vercel.app", "https://arcadia.vercel.app/some/path", "HTTPS://ARCADIA.VERCEL.APP"])("is on for %j", (url) => {
    expect(parse(buildContentSecurityPolicy({ NEXT_PUBLIC_APP_URL: url })).has("upgrade-insecure-requests")).toBe(true);
  });

  it.each([undefined, "", "http://localhost:3000", "http://127.0.0.1:3000", "not a url", "javascript:alert(1)", "https://user:pass@arcadia.vercel.app"])(
    "is off for %j, so a production build served over plain http still works",
    (url) => {
      expect(buildContentSecurityPolicy({ NEXT_PUBLIC_APP_URL: url })).not.toContain("upgrade-insecure-requests");
    },
  );
});

describe("secrets", () => {
  const secrets = {
    SUPABASE_SERVICE_ROLE_KEY: "SENTINEL-service-role-key",
    SUPABASE_SECRET_KEY: "SENTINEL-secret-key",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "SENTINEL-publishable-key",
    OPENROUTER_API_KEY: "SENTINEL-openrouter-key",
    GNANI_API_KEY: "SENTINEL-gnani-key",
    VOICE_TRANSCRIPT_SECRET: "SENTINEL-transcript-secret",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "SENTINEL-anon-key",
    PAYMENT_UPI_ID: "SENTINEL-upi",
  };

  it("never copies another variable into a header", () => {
    const env = { ...PRODUCTION, ...secrets };
    const text = JSON.stringify(buildSecurityHeaders(env));
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    expect(text).not.toContain("SENTINEL");
  });

  it("reads only NODE_ENV and the two public URLs", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/lib/security/headers.ts", import.meta.url)), "utf8");
    const read = new Set([...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
    expect([...read].sort()).toEqual(["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL", "NODE_ENV"]);
    expect(source).not.toContain("process.env");
  });
});

describe("next.config.ts wiring", () => {
  it("keeps Cache Components and partial prefetching on (the CSP must not depend on turning them off)", () => {
    expect(nextConfig.cacheComponents).toBe(true);
    expect(nextConfig.partialPrefetching).toBe(true);
  });

  it("applies one rule built from the current environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", HOSTED_SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://arcadia.vercel.app");
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(Object.keys(rule).sort()).toEqual(["headers", "source"]);
    expect(rule.headers).toEqual(buildSecurityHeaders(process.env));
    expect(byKey(rule.headers)["Content-Security-Policy"]).toContain(`img-src 'self' data: ${HOSTED_SUPABASE}`);
  });

  it("sends no CSP in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const [rule] = (await nextConfig.headers?.()) ?? [];
    expect(byKey(rule.headers)["Content-Security-Policy"]).toBeUndefined();
  });

  it("covers pages and API routes but not Next's static files or the image optimiser", async () => {
    const [rule] = (await nextConfig.headers?.()) ?? [];
    const matches = new RegExp(`^${rule.source}$`);
    for (const path of ["/", "/sign-in", "/projects/abc/results", "/admin/payments", "/api/health", "/api/projects/abc/readback", "/auth/callback"]) {
      expect(matches.test(path), path).toBe(true);
    }
    for (const path of ["/_next/static/chunks/app.js", "/_next/static/media/font.woff2", "/_next/image"]) {
      expect(matches.test(path), path).toBe(false);
    }
  });
});

describe("constructs that would need the policy reviewed", () => {
  // The policy assumes: no inline HTML injection, no eval, no frames, no remote scripts, and a
  // browser that only talks to this site. Adding any of these needs a deliberate CSP change.
  const forbidden: [string, RegExp][] = [
    ["raw HTML injection", /dangerouslySetInnerHTML/],
    ["eval", /\beval\s*\(/],
    ["Function constructor", /\bnew Function\s*\(/],
    ["iframe", /<iframe\b/i],
    ["next/script (remote scripts)", /from\s+["']next\/script["']/],
    ["browser Supabase client (connect-src would block it)", /\bcreateBrowserClient\b/],
    ["WebSocket", /\bnew WebSocket\s*\(/],
    ["EventSource", /\bnew EventSource\s*\(/],
  ];

  function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
    return files;
  }

  it("none appears in the application source", () => {
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const own = join(root, "lib", "security", "headers.ts");
    const found: string[] = [];
    for (const file of sourceFiles(root)) {
      if (file === own) continue;
      const text = readFileSync(file, "utf8");
      for (const [label, pattern] of forbidden) if (pattern.test(text)) found.push(`${label}: ${file.slice(root.length + 1)}`);
    }
    expect(found).toEqual([]);
  });
});
