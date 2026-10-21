import { describe, expect, it } from "vitest";
import { isSet, parseEnv } from "@/lib/env/schema";

describe("parseEnv", () => {
  it("accepts an empty environment: nothing is required in Phase 1", () => {
    expect(parseEnv({}).ok).toBe(true);
  });

  it("treats blank values, as in .env.example, as not set", () => {
    const result = parseEnv({
      NEXT_PUBLIC_APP_URL: "",
      NEXT_PUBLIC_SUPABASE_URL: "   ",
      OPENROUTER_API_KEY: "",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.NEXT_PUBLIC_APP_URL).toBeUndefined();
      expect(result.env.OPENROUTER_API_KEY).toBeUndefined();
    }
  });

  it("accepts well-formed values", () => {
    const result = parseEnv({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      OPENROUTER_API_KEY: "any-non-empty-text",
    });
    expect(result.ok).toBe(true);
  });

  it("reports a malformed URL by variable name only, never the value", () => {
    const badValue = "not a url SECRET-IN-URL-12345";
    const result = parseEnv({ NEXT_PUBLIC_SUPABASE_URL: badValue });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ name: "NEXT_PUBLIC_SUPABASE_URL", problem: "invalid format" }]);
      expect(JSON.stringify(result.issues)).not.toContain("SECRET-IN-URL");
    }
  });

  it("accepts PROVIDER_MODE mock or live, treats blank as unset, and flags other values by name only", () => {
    expect(parseEnv({ PROVIDER_MODE: "mock" }).ok).toBe(true);
    expect(parseEnv({ PROVIDER_MODE: "live" }).ok).toBe(true);
    expect(parseEnv({ PROVIDER_MODE: "" }).ok).toBe(true);

    const bad = parseEnv({ PROVIDER_MODE: "demo-SECRET-777" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues).toEqual([{ name: "PROVIDER_MODE", problem: "invalid format" }]);
      expect(JSON.stringify(bad.issues)).not.toContain("SECRET-777");
    }
  });

  it("lists each invalid variable once", () => {
    const result = parseEnv({ APP_BASE_URL: "nope", OPENROUTER_BASE_URL: "also nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.name).sort()).toEqual(["APP_BASE_URL", "OPENROUTER_BASE_URL"]);
  });
});

describe("isSet", () => {
  it("is true only for a non-blank value and never returns the value", () => {
    expect(isSet({ A: "x" }, "A")).toBe(true);
    expect(isSet({ A: "  " }, "A")).toBe(false);
    expect(isSet({}, "A")).toBe(false);
    expect(typeof isSet({ A: "secret" }, "A")).toBe("boolean");
  });
});

describe("VOICE_TRANSCRIPT_SECRET", () => {
  it("is optional, and when set must be at least 32 characters; the value is never reported", () => {
    expect(parseEnv({ VOICE_TRANSCRIPT_SECRET: "" }).ok).toBe(true);
    expect(parseEnv({ VOICE_TRANSCRIPT_SECRET: "a".repeat(32) }).ok).toBe(true);
    const short = parseEnv({ VOICE_TRANSCRIPT_SECRET: "short-SECRET" });
    expect(short.ok).toBe(false);
    expect(JSON.stringify(short)).not.toContain("short-SECRET");
  });
});
