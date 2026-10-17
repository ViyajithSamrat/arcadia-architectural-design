import { afterEach, describe, expect, it } from "vitest";
import { POST as signIn } from "@/app/api/auth/sign-in/route";

const KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/auth/sign-in", () => {
  it("rejects a cross-origin request", async () => {
    const res = await signIn(req({ email: "a@b.test" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("reports a clear disabled state when Supabase is not configured", async () => {
    for (const k of KEYS) delete process.env[k];
    const res = await signIn(req({ email: "a@b.test" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("AUTH_NOT_CONFIGURED");
  });

  it("rejects an invalid email before contacting any service", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.example.test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "k";
    const res = await signIn(req({ email: "not-an-email" }));
    expect(res.status).toBe(400);
  });
});
