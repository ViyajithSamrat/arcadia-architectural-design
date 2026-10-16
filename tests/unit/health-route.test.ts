import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `connection()` only works inside a Next.js request. Outside Next it is a no-op here.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { GET } from "@/app/api/health/route";

const ORIGINAL = { ...process.env };

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("GET /api/health", () => {
  beforeEach(() => {
    setEnv({
      NEXT_PUBLIC_APP_URL: undefined,
      OPENROUTER_API_KEY: undefined,
      GNANI_API_KEY: undefined,
      NEXT_PUBLIC_SUPABASE_URL: undefined,
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("responds 200 with ok status and every integration not configured", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.configValid).toBe(true);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.integrations.every((i: { state: string }) => i.state === "not_configured")).toBe(true);
  });

  it("never returns a secret value, even when one is configured", async () => {
    setEnv({
      OPENROUTER_API_KEY: "sk-or-TOPSECRET-424242",
      GNANI_API_KEY: "gnani-TOPSECRET-777",
      NEXT_PUBLIC_SUPABASE_URL: "https://TOPSECRET-999.supabase.co",
    });
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain("TOPSECRET");
    const gnani = JSON.parse(text).integrations.find((i: { id: string }) => i.id === "gnani");
    expect(gnani.state).toBe("configured_unverified");
  });

  it("returns 503 and only the invalid variable name when a setting is malformed", async () => {
    setEnv({ NEXT_PUBLIC_APP_URL: "bad value VALUE-555" });
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).invalidVariables).toEqual(["NEXT_PUBLIC_APP_URL"]);
    expect(text).not.toContain("VALUE-555");
  });
});
