import { describe, expect, it } from "vitest";
import {
  getGnaniReadiness,
  getOpenRouterConfig,
  getProviderMode,
  getProviderTimeoutMs,
  GNANI_HARD_CEILING_CREDITS,
} from "@/lib/providers/config";

const OPENROUTER = { OPENROUTER_API_KEY: "sk-test-not-real", OPENROUTER_TEXT_MODEL: "vendor/model:free" };

const GNANI = {
  GNANI_VOICE_ENABLED: "true",
  GNANI_API_KEY: "gnani-test-not-real",
  GNANI_BASE_URL: "https://api.vachana.ai",
  GNANI_STT_ENDPOINT: "/stt/v3",
  GNANI_TTS_ENDPOINT: "/api/v1/tts/inference",
  GNANI_TTS_MODEL: "timbre-v2.5",
  GNANI_TTS_VOICE: "voice-x",
  GNANI_LANGUAGES: "hi-IN,en-IN",
  GNANI_CREDITS_PER_STT_SECOND: "2",
  GNANI_CREDITS_PER_TTS_CHAR: "0.5",
  GNANI_MAX_CREDITS_PER_REQUEST: "100",
  GNANI_CUSTOMER_CREDITS_PER_HOUR: "300",
  GNANI_BUDGET_CREDITS: "1000",
};

describe("provider mode and timeout", () => {
  it("is mock unless explicitly live", () => {
    expect(getProviderMode({})).toBe("mock");
    expect(getProviderMode({ PROVIDER_MODE: "" })).toBe("mock");
    expect(getProviderMode({ PROVIDER_MODE: "mock" })).toBe("mock");
    expect(getProviderMode({ PROVIDER_MODE: "banana" })).toBe("mock");
    expect(getProviderMode({ PROVIDER_MODE: " LIVE " })).toBe("live");
  });

  it("bounds the timeout and ignores nonsense", () => {
    expect(getProviderTimeoutMs({})).toBe(30_000);
    expect(getProviderTimeoutMs({ PROVIDER_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(getProviderTimeoutMs({ PROVIDER_TIMEOUT_MS: "1" })).toBe(1000);
    expect(getProviderTimeoutMs({ PROVIDER_TIMEOUT_MS: "999999" })).toBe(60_000);
    expect(getProviderTimeoutMs({ PROVIDER_TIMEOUT_MS: "soon" })).toBe(30_000);
  });
});

describe("OpenRouter configuration", () => {
  it("is absent without a key and a model", () => {
    expect(getOpenRouterConfig({})).toBeNull();
    expect(getOpenRouterConfig({ OPENROUTER_API_KEY: "k" })).toBeNull();
    expect(getOpenRouterConfig({ OPENROUTER_TEXT_MODEL: "m" })).toBeNull();
  });

  it("uses the documented default base URL and sane limits", () => {
    expect(getOpenRouterConfig(OPENROUTER)).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "vendor/model:free",
      briefsPerHour: 5,
      dailyRequestCap: 40,
      timeoutMs: 30_000,
      referer: null,
      reasoningEffort: null,
    });
  });

  it("reads OPENROUTER_TEXT_REASONING_EFFORT from a short list and fails closed on anything else", () => {
    expect(getOpenRouterConfig({ ...OPENROUTER, OPENROUTER_TEXT_REASONING_EFFORT: " None " })?.reasoningEffort).toBe("none");
    expect(getOpenRouterConfig({ ...OPENROUTER, OPENROUTER_TEXT_REASONING_EFFORT: "minimal" })?.reasoningEffort).toBe("minimal");
    expect(getOpenRouterConfig({ ...OPENROUTER, OPENROUTER_TEXT_REASONING_EFFORT: "" })?.reasoningEffort).toBeNull();
    for (const bad of ["high", "xhigh", "off", "0"]) expect(getOpenRouterConfig({ ...OPENROUTER, OPENROUTER_TEXT_REASONING_EFFORT: bad })).toBeNull();
  });

  it("accepts only the OpenRouter host over https, with no credentials or port", () => {
    expect(getOpenRouterConfig({ ...OPENROUTER, OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/" })?.baseUrl).toBe("https://openrouter.ai/api/v1");
    for (const bad of ["http://openrouter.ai/api/v1", "https://evil.example/api/v1", "https://openrouter.ai.evil.example/v1", "https://user:pw@openrouter.ai/api/v1", "https://openrouter.ai:8443/api/v1", "not a url"]) {
      expect(getOpenRouterConfig({ ...OPENROUTER, OPENROUTER_BASE_URL: bad }), bad).toBeNull();
    }
  });

  it("bounds the per-customer and daily limits", () => {
    expect(getOpenRouterConfig({ ...OPENROUTER, AI_BRIEFS_PER_HOUR: "0", OPENROUTER_DAILY_REQUEST_CAP: "99999" })).toMatchObject({ briefsPerHour: 1, dailyRequestCap: 1000 });
    expect(getOpenRouterConfig({ ...OPENROUTER, AI_BRIEFS_PER_HOUR: "x" })?.briefsPerHour).toBe(5);
  });
});

describe("Gnani readiness: voice is OFF unless everything is configured", () => {
  it("is not ready by default and lists what is missing by name only", () => {
    const result = getGnaniReadiness({});
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.missing).toContain("GNANI_VOICE_ENABLED=true");
      expect(result.missing).toContain("GNANI_BUDGET_CREDITS");
      expect(result.missing).toContain("GNANI_CREDITS_PER_STT_SECOND");
    }
  });

  it("is ready only with the explicit switch and every safeguard", () => {
    expect(getGnaniReadiness(GNANI).ready).toBe(true);
  });

  it.each(Object.keys(GNANI))("is not ready when %s is missing", (name) => {
    const env: Record<string, string> = { ...GNANI };
    delete env[name];
    expect(getGnaniReadiness(env).ready).toBe(false);
  });

  it("does not treat a mere key as enablement", () => {
    expect(getGnaniReadiness({ ...GNANI, GNANI_VOICE_ENABLED: "yes" }).ready).toBe(false);
    expect(getGnaniReadiness({ ...GNANI, GNANI_VOICE_ENABLED: "false" }).ready).toBe(false);
  });

  it("never reports a value, only variable names", () => {
    const result = getGnaniReadiness({ ...GNANI, GNANI_BUDGET_CREDITS: "" });
    expect(JSON.stringify(result)).not.toContain("gnani-test-not-real");
  });

  it("caps the budget at the owner's 5,000 credits whatever is configured", () => {
    const high = getGnaniReadiness({ ...GNANI, GNANI_BUDGET_CREDITS: "999999" });
    expect(high.ready && high.config.budgetCredits).toBe(GNANI_HARD_CEILING_CREDITS);
    const low = getGnaniReadiness({ ...GNANI, GNANI_BUDGET_CREDITS: "250" });
    expect(low.ready && low.config.budgetCredits).toBe(250);
    expect(GNANI_HARD_CEILING_CREDITS).toBe(5000);
  });

  it("requires positive credit figures: zero, negative or text means not ready", () => {
    for (const name of ["GNANI_CREDITS_PER_STT_SECOND", "GNANI_CREDITS_PER_TTS_CHAR", "GNANI_MAX_CREDITS_PER_REQUEST", "GNANI_CUSTOMER_CREDITS_PER_HOUR", "GNANI_BUDGET_CREDITS"]) {
      for (const bad of ["0", "-1", "lots", "NaN"]) {
        expect(getGnaniReadiness({ ...GNANI, [name]: bad }).ready, `${name}=${bad}`).toBe(false);
      }
    }
  });

  it("allows only the documented host over https", () => {
    for (const bad of ["https://api.gnani.ai", "http://api.vachana.ai", "https://api.vachana.ai.evil.example", "https://u:p@api.vachana.ai", "https://api.vachana.ai:9443", "api.vachana.ai"]) {
      expect(getGnaniReadiness({ ...GNANI, GNANI_BASE_URL: bad }).ready, bad).toBe(false);
    }
  });

  it("allows only plain endpoint paths", () => {
    for (const bad of ["stt/v3", "//evil.example/x", "/a/../b", "/a b", "https://evil.example/x", "/x?y=1"]) {
      expect(getGnaniReadiness({ ...GNANI, GNANI_STT_ENDPOINT: bad }).ready, bad).toBe(false);
    }
  });

  it("offers only documented languages and bounds the clip and text lengths", () => {
    const result = getGnaniReadiness({ ...GNANI, GNANI_LANGUAGES: "hi-IN, xx-XX ,en-IN,hi-IN", GNANI_STT_MAX_SECONDS: "600", GNANI_TTS_MAX_CHARS: "999999" });
    expect(result.ready && result.config.languages).toEqual(["hi-IN", "en-IN"]);
    expect(result.ready && result.config.maxSttSeconds).toBe(30);
    expect(result.ready && result.config.maxTtsChars).toBe(2000);
    expect(getGnaniReadiness({ ...GNANI, GNANI_LANGUAGES: "xx-XX" }).ready).toBe(false);
  });
});
