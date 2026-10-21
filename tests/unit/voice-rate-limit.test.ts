import { describe, expect, it } from "vitest";
import { getVoiceMode } from "@/lib/journeys/voice";
import { createLiveSpeechDeps } from "@/lib/voice/live";
import { RequestLimiter, transcribeLimiter } from "@/lib/voice/rate-limit";

describe("RequestLimiter", () => {
  const make = (now: { t: number }, patch: Partial<ConstructorParameters<typeof RequestLimiter>[0]> = {}) =>
    new RequestLimiter({ windowMs: 60_000, maxPerWindow: 3, maxConcurrent: 1, maxKeys: 100, now: () => now.t, ...patch });

  it("allows up to the limit in a sliding window, then says when to retry", () => {
    const now = { t: 1_000_000 };
    const limiter = make(now);
    for (let i = 0; i < 3; i++) {
      const slot = limiter.acquire("u1");
      expect(slot.ok).toBe(true);
      if (slot.ok) slot.release();
      now.t += 10_000;
    }
    expect(limiter.acquire("u1")).toEqual({ ok: false, reason: "rate", retryAfterSeconds: 30 });
    now.t += 30_000; // the first request leaves the window
    expect(limiter.acquire("u1").ok).toBe(true);
  });

  it("caps requests in flight per key, and a release (even twice) frees exactly one slot", () => {
    const now = { t: 0 };
    const limiter = make(now, { maxPerWindow: 10 });
    const first = limiter.acquire("u1");
    expect(limiter.acquire("u1")).toMatchObject({ ok: false, reason: "concurrent" });
    expect(limiter.acquire("u2").ok).toBe(true);
    if (first.ok) {
      first.release();
      first.release();
    }
    const second = limiter.acquire("u1");
    expect(second.ok).toBe(true);
    expect(limiter.acquire("u1")).toMatchObject({ ok: false, reason: "concurrent" });
  });

  it("a burst of parallel requests never gets more slots than either limit allows", () => {
    const now = { t: 0 };
    const rate = make(now, { maxPerWindow: 3, maxConcurrent: 50 });
    expect(Array.from({ length: 20 }, () => rate.acquire("u1")).filter((s) => s.ok)).toHaveLength(3);
    const concurrent = make(now, { maxPerWindow: 50, maxConcurrent: 2 });
    expect(Array.from({ length: 20 }, () => concurrent.acquire("u1")).filter((s) => s.ok)).toHaveLength(2);
  });

  it("keeps memory bounded by forgetting the least recently used idle keys", () => {
    const now = { t: 0 };
    const limiter = make(now, { maxKeys: 2, maxPerWindow: 1 });
    for (const key of ["a", "b", "c"]) {
      const slot = limiter.acquire(key);
      if (slot.ok) slot.release();
    }
    // "a" was forgotten, so it may send again; "c" is still limited.
    expect(limiter.acquire("a").ok).toBe(true);
    expect(limiter.acquire("c")).toMatchObject({ ok: false, reason: "rate" });
  });

  it("is one shared instance per server process", () => {
    expect(transcribeLimiter()).toBe(transcribeLimiter());
  });
});

describe("createLiveSpeechDeps (the live route's setup, never reached while LIVE_STT_WIRED is false)", () => {
  const mode = getVoiceMode({
    GNANI_VOICE_ENABLED: "true",
    GNANI_API_KEY: "gnani-test-not-real",
    GNANI_BASE_URL: "https://api.vachana.ai",
    GNANI_STT_ENDPOINT: "/stt/v3",
    GNANI_LANGUAGES: "ta-IN",
    GNANI_CREDITS_PER_STT_SECOND: "2",
    GNANI_MAX_CREDITS_PER_REQUEST: "100",
    GNANI_CUSTOMER_CREDITS_PER_HOUR: "300",
    GNANI_BUDGET_CREDITS: "1000",
    VOICE_TRANSCRIPT_SECRET: "live-deps-test-secret-0123456789abcdef",
  });
  if (mode.kind !== "live") throw new Error("expected a complete live configuration");

  it("gives null, not an exception, when the trusted database client cannot be created", () => {
    expect(
      createLiveSpeechDeps(mode.config, {
        service: () => {
          throw new Error("server-side Supabase settings are missing");
        },
      }),
    ).toBeNull();
  });

  it("gives null when the provider cannot be created", () => {
    expect(
      createLiveSpeechDeps(mode.config, {
        provider: () => {
          throw new Error("bad config");
        },
        service: () => ({}) as never,
      }),
    ).toBeNull();
  });

  it("builds both without making any network call", () => {
    const deps = createLiveSpeechDeps(mode.config, { service: () => ({}) as never });
    expect(deps?.provider.id).toBe("gnani");
  });
});
