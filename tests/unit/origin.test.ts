import { describe, expect, it } from "vitest";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { allowedOrigins, isAllowedOrigin, resolveRequestOrigin } from "@/lib/supabase/origin";

// Next.js reports request.url as localhost whatever host the browser used.
const URL_ = "http://localhost:3000/api/auth/sign-in";
const req = (headers: Record<string, string> = {}, url = URL_) => new Request(url, { method: "POST", headers });

describe("allowed origins", () => {
  it("uses the request origin when no app URL is configured, plus its loopback twin", () => {
    expect([...allowedOrigins(URL_, {})].sort()).toEqual(["http://127.0.0.1:3000", "http://localhost:3000"]);
  });

  it("uses the configured app URL, and its loopback twin only when it is a loopback address", () => {
    expect([...allowedOrigins(URL_, { NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000/x" })].sort()).toEqual([
      "http://127.0.0.1:3000",
      "http://localhost:3000",
    ]);
    expect([...allowedOrigins(URL_, { NEXT_PUBLIC_APP_URL: "https://app.example.test" })]).toEqual(["https://app.example.test"]);
  });

  it("ignores a malformed or non-http app URL", () => {
    expect(allowedOrigins(URL_, { NEXT_PUBLIC_APP_URL: "javascript:alert(1)" }).has("javascript:alert(1)")).toBe(false);
    expect(allowedOrigins(URL_, { NEXT_PUBLIC_APP_URL: "not a url" }).has("http://localhost:3000")).toBe(true);
  });
});

describe("isAllowedOrigin", () => {
  it.each([
    ["the expected origin", "http://localhost:3000", true],
    ["the loopback twin (same scheme and port)", "http://127.0.0.1:3000", true],
    ["an unexpected site", "https://evil.example", false],
    ["a lookalike host", "http://localhost.evil.example:3000", false],
    ["another port", "http://127.0.0.1:3001", false],
    ["another scheme", "https://localhost:3000", false],
    ["the literal string null", "null", false],
    ["another loopback form", "http://[::1]:3000", false],
  ])("%s", (_name, origin, expected) => {
    expect(isAllowedOrigin(req({ origin }), {})).toBe(expected);
  });

  it("accepts a request without an Origin header (non-browser client), as before", () => {
    expect(isAllowedOrigin(req(), {})).toBe(true);
  });

  it("in production the twin is not accepted and the configured origin is exact", () => {
    const env = { NEXT_PUBLIC_APP_URL: "https://app.example.test" };
    expect(isAllowedOrigin(req({ origin: "https://app.example.test" }), env)).toBe(true);
    expect(isAllowedOrigin(req({ origin: "http://127.0.0.1:3000" }), env)).toBe(false);
    expect(isAllowedOrigin(req({ origin: "http://localhost:3000" }), env)).toBe(false);
  });

  it("never reads forwarded headers", () => {
    const forged = req({ origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", forwarded: "host=evil.example" });
    expect(isAllowedOrigin(forged, {})).toBe(false);
    const spoofedHost = req({ origin: "https://evil.example", "x-forwarded-host": "localhost:3000" });
    expect(isAllowedOrigin(spoofedHost, {})).toBe(false);
  });
});

describe("the origin sign-in links return to", () => {
  it("is the origin the browser used, so the sign-in cookie and the callback share a host", () => {
    expect(resolveRequestOrigin(req({ origin: "http://127.0.0.1:3000" }), {})).toBe("http://127.0.0.1:3000");
    expect(resolveRequestOrigin(req({ origin: "http://localhost:3000" }), {})).toBe("http://localhost:3000");
  });

  it("falls back to the Host header for the callback (a navigation has no Origin), but only if allowed", () => {
    expect(resolveRequestOrigin(req({ host: "127.0.0.1:3000" }), {})).toBe("http://127.0.0.1:3000");
    expect(resolveRequestOrigin(req({ host: "evil.example" }), {})).toBe("http://localhost:3000");
    expect(resolveRequestOrigin(req({ host: "evil.example" }), { NEXT_PUBLIC_APP_URL: "https://app.example.test" })).toBe(
      "https://app.example.test",
    );
  });

  it("never follows a forged Origin or forwarded host", () => {
    expect(resolveRequestOrigin(req({ origin: "https://evil.example", "x-forwarded-host": "evil.example" }), {})).toBe("http://localhost:3000");
  });

  it("uses the configured origin in production regardless of the Host header", () => {
    const env = { NEXT_PUBLIC_APP_URL: "https://app.example.test" };
    expect(resolveRequestOrigin(req({ host: "127.0.0.1:3000" }), env)).toBe("https://app.example.test");
  });
});

describe("the routes use the policy", () => {
  const post = (handler: (r: Request) => Promise<Response>, origin: string, url: string) =>
    handler(new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.test" }) }));

  it("sign-in and sign-out reject an unexpected origin with 403", async () => {
    expect((await post(signIn, "https://evil.example", "http://localhost:3000/api/auth/sign-in")).status).toBe(403);
    expect((await post(signOut, "https://evil.example", "http://localhost:3000/api/auth/sign-out")).status).toBe(403);
  });

  it("neither route rejects the loopback twin on origin grounds", async () => {
    const a = await post(signIn, "http://127.0.0.1:3000", "http://localhost:3000/api/auth/sign-in");
    expect(a.status).not.toBe(403);
    const b = await post(signOut, "http://127.0.0.1:3000", "http://localhost:3000/api/auth/sign-out");
    expect(b.status).not.toBe(403);
  });
});
