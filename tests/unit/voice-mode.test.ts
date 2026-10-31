import { afterEach, describe, expect, it, vi } from "vitest";
import { getVoiceMode, getVoiceView, isLiveTranscriptionWired, LIVE_STT_WIRED, MOCK_DEFAULT_LANGUAGES, TANGLISH_DEMO, UPLOAD_TIMEOUT_MARGIN_MS } from "@/lib/journeys/voice";
import { getGnaniReadiness, getGnaniSttReadiness, getProviderMode } from "@/lib/providers/config";
import { containsMockTranscript, createMockSpeechProvider, isMockTranscript, MOCK_TRANSCRIPT, MOCK_TRANSCRIPT_PREFIX } from "@/lib/providers/mock-speech";

const SECRET = "gnani-SECRET-value-never-shown";

/** Every speech-to-text setting and nothing for text-to-speech. */
const STT = {
  GNANI_VOICE_ENABLED: "true",
  GNANI_API_KEY: SECRET,
  GNANI_BASE_URL: "https://api.vachana.ai",
  GNANI_STT_ENDPOINT: "/stt/v3",
  GNANI_LANGUAGES: "ta-IN,en-IN",
  GNANI_CREDITS_PER_STT_SECOND: "2",
  GNANI_MAX_CREDITS_PER_REQUEST: "100",
  GNANI_CUSTOMER_CREDITS_PER_HOUR: "300",
  GNANI_BUDGET_CREDITS: "1000",
};
/** STT plus the transcript signing secret: everything live mode needs. */
const TRANSCRIPT_SECRET = "transcript-SECRET-value-never-shown-0123";
const LIVE = { ...STT, VOICE_TRANSCRIPT_SECRET: TRANSCRIPT_SECRET };

afterEach(() => vi.restoreAllMocks());

describe("getGnaniSttReadiness: speech-to-text on its own", () => {
  it("is ready with only speech-to-text settings, while the combined (TTS) readiness stays off", () => {
    const r = getGnaniSttReadiness(STT);
    expect(r).toMatchObject({ ready: true, config: { baseUrl: "https://api.vachana.ai", sttPath: "/stt/v3", languages: ["ta-IN", "en-IN"], maxSttSeconds: 30, creditsPerSttSecond: 2 } });
    expect(getGnaniReadiness(STT).ready).toBe(false); // unchanged: TTS still needs its own settings
  });

  it.each(Object.keys(STT))("is not ready without %s, and names it", (name) => {
    const env: Record<string, string> = { ...STT };
    delete env[name];
    const r = getGnaniSttReadiness(env);
    expect(r.ready).toBe(false);
    expect(!r.ready && r.missing.some((m) => m.startsWith(name))).toBe(true);
  });

  it("never returns or names a value, only setting names", () => {
    const r = getGnaniSttReadiness({ ...STT, GNANI_BUDGET_CREDITS: "" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(getGnaniSttReadiness({ GNANI_API_KEY: SECRET }))).not.toContain(SECRET);
  });

  it("does not widen the host allow-list, and refuses http, odd paths and undocumented languages", () => {
    for (const GNANI_BASE_URL of ["https://api.gnani.ai", "http://api.vachana.ai", "https://api.vachana.ai.evil.example", "https://user:pw@api.vachana.ai"]) {
      expect(getGnaniSttReadiness({ ...STT, GNANI_BASE_URL }).ready).toBe(false);
    }
    expect(getGnaniSttReadiness({ ...STT, GNANI_STT_ENDPOINT: "/../admin" }).ready).toBe(false);
    expect(getGnaniSttReadiness({ ...STT, GNANI_LANGUAGES: "ta-en,tanglish" }).ready).toBe(false);
  });

  it("caps the recording at 30 seconds and the budget at the 5,000-credit ceiling", () => {
    const r = getGnaniSttReadiness({ ...STT, GNANI_STT_MAX_SECONDS: "120", GNANI_BUDGET_CREDITS: "999999" });
    expect(r.ready && r.config.maxSttSeconds).toBe(30);
    expect(r.ready && r.config.budgetCredits).toBe(5000);
  });
});

describe("getVoiceMode: an independent switch that fails closed", () => {
  it("is off by default and when empty", () => {
    expect(getVoiceMode({})).toEqual({ kind: "off" });
    expect(getVoiceMode({ GNANI_VOICE_ENABLED: "  " })).toEqual({ kind: "off" });
    expect(getVoiceView({})).toEqual({ state: "off" });
  });

  it("mock works with no key, no TTS and no OpenRouter settings, offering the Tamil demo by default", () => {
    const mode = getVoiceMode({ GNANI_VOICE_ENABLED: "mock" });
    expect(mode.kind).toBe("mock");
    if (mode.kind !== "mock") return;
    expect(mode.maxSeconds).toBe(30);
    expect(mode.languages.map((l) => l.value)).toEqual([...MOCK_DEFAULT_LANGUAGES, TANGLISH_DEMO]);
    expect(getVoiceMode({ GNANI_VOICE_ENABLED: " MOCK " }).kind).toBe("mock");
  });

  it("offers Tanglish only as a labelled demo selection with no provider language code", () => {
    const mode = getVoiceMode({ GNANI_VOICE_ENABLED: "mock" });
    const tanglish = mode.kind === "mock" ? mode.languages.find((l) => l.value === TANGLISH_DEMO) : undefined;
    expect(tanglish).toMatchObject({ sourceLanguage: null, demoOnly: true });
    expect(tanglish?.label).toMatch(/demo selection, not a confirmed speech-service language/);
    const tamil = mode.kind === "mock" ? mode.languages.find((l) => l.value === "ta-IN") : undefined;
    expect(tamil).toMatchObject({ label: "Tamil", sourceLanguage: "ta-IN", demoOnly: false });
  });

  it("mock uses configured documented languages when given, dropping unknown codes", () => {
    const mode = getVoiceMode({ GNANI_VOICE_ENABLED: "mock", GNANI_LANGUAGES: "hi-IN, xx-XX" });
    expect(mode.kind === "mock" && mode.languages.map((l) => l.value)).toEqual(["hi-IN", TANGLISH_DEMO]);
  });

  it("live without every STT setting is unavailable, never the mock", () => {
    for (const env of [{ GNANI_VOICE_ENABLED: "true" }, { ...STT, GNANI_CREDITS_PER_STT_SECOND: "" }]) {
      const mode = getVoiceMode(env);
      expect(mode.kind).toBe("live_unavailable");
      expect(getVoiceView(env)).toEqual({ state: "unavailable" });
    }
  });

  it("a complete live configuration is live on screen, with no demo-only selection and no mock", () => {
    expect(LIVE_STT_WIRED).toBe(true);
    const mode = getVoiceMode(LIVE);
    expect(mode.kind).toBe("live");
    expect(mode.kind === "live" && mode.languages.some((l) => l.demoOnly)).toBe(false); // no demo selection when live
    expect(getVoiceView(LIVE)).toMatchObject({ state: "live", maxSeconds: expect.any(Number) });
    expect(JSON.stringify(getVoiceView(LIVE))).not.toContain(SECRET);
  });

  it("live without the transcript signing secret (or with a short one) is unavailable, naming the setting but never a value", () => {
    for (const env of [STT, { ...STT, VOICE_TRANSCRIPT_SECRET: "too-short" }]) {
      const mode = getVoiceMode(env);
      expect(mode).toMatchObject({ kind: "live_unavailable", missing: [expect.stringContaining("VOICE_TRANSCRIPT_SECRET")] });
      expect(JSON.stringify(mode)).not.toContain(SECRET);
      expect(JSON.stringify(mode)).not.toContain("too-short");
    }
    expect(JSON.stringify(getVoiceMode(LIVE))).not.toContain(TRANSCRIPT_SECRET);
  });

  it("gives the screen an upload time limit of the provider timeout plus a margin", () => {
    expect(getVoiceView({ GNANI_VOICE_ENABLED: "mock" })).toMatchObject({ state: "mock", uploadTimeoutMs: 30_000 + UPLOAD_TIMEOUT_MARGIN_MS });
    expect(getVoiceView({ GNANI_VOICE_ENABLED: "mock", PROVIDER_TIMEOUT_MS: "50000" })).toMatchObject({ uploadTimeoutMs: 50_000 + UPLOAD_TIMEOUT_MARGIN_MS });
  });

  it("treats a transcript as live only in a complete live configuration, so a mock or typed text can never set a project's language", () => {
    expect(isLiveTranscriptionWired(LIVE)).toBe(true);
    expect(isLiveTranscriptionWired({ ...LIVE, PROVIDER_MODE: "live" })).toBe(true);
    expect(isLiveTranscriptionWired({ ...LIVE, VOICE_TRANSCRIPT_SECRET: "short" })).toBe(false);
    expect(isLiveTranscriptionWired({ ...LIVE, GNANI_API_KEY: "" })).toBe(false);
    expect(isLiveTranscriptionWired({ GNANI_VOICE_ENABLED: "mock" })).toBe(false);
    expect(isLiveTranscriptionWired({})).toBe(false);
  });

  it.each(["false", "FALSE", " False "])("treats an explicit %j as off, like an empty value, even with a complete live configuration", (value) => {
    expect(getVoiceMode({ GNANI_VOICE_ENABLED: value })).toEqual({ kind: "off" });
    expect(getVoiceMode({ ...LIVE, GNANI_VOICE_ENABLED: value })).toEqual({ kind: "off" });
    expect(getVoiceView({ ...LIVE, GNANI_VOICE_ENABLED: value })).toEqual({ state: "off" });
    expect(isLiveTranscriptionWired({ ...LIVE, GNANI_VOICE_ENABLED: value })).toBe(false);
  });

  it.each(["yes", "1", "on", "no", "falsy", "false please", "live", "mock please"])("treats %j as invalid and unavailable", (value) => {
    expect(getVoiceMode({ GNANI_VOICE_ENABLED: value })).toEqual({ kind: "invalid" });
    expect(getVoiceView({ GNANI_VOICE_ENABLED: value })).toEqual({ state: "unavailable" });
  });

  it("is independent of PROVIDER_MODE in both directions", () => {
    expect(getVoiceMode({ GNANI_VOICE_ENABLED: "mock", PROVIDER_MODE: "live" }).kind).toBe("mock");
    expect(getVoiceMode({ PROVIDER_MODE: "live" }).kind).toBe("off");
    expect(getProviderMode({ GNANI_VOICE_ENABLED: "true" })).toBe("mock");
  });

  it("tells the screen nothing about settings, names or keys", () => {
    for (const env of [STT, { ...STT, GNANI_BUDGET_CREDITS: "" }, { GNANI_VOICE_ENABLED: "mock", GNANI_API_KEY: SECRET }]) {
      const view = JSON.stringify(getVoiceView(env));
      expect(view).not.toContain(SECRET);
      expect(view).not.toMatch(/GNANI_|missing|vachana/);
    }
  });
});

describe("the mock speech provider", () => {
  it("returns the fixed, labelled placeholder whatever it is given", async () => {
    const provider = createMockSpeechProvider();
    const a = await provider.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", language: "ta-IN", requestId: "r1" });
    const b = await provider.transcribe({ audio: new Uint8Array(5000), mimeType: "audio/wav", language: "en-IN", requestId: "r2" });
    expect(a).toEqual({ transcript: MOCK_TRANSCRIPT, provider: "mock", model: "mock-transcript-1" });
    expect(b).toEqual(a);
    expect(a.transcript.startsWith(MOCK_TRANSCRIPT_PREFIX)).toBe(true);
    expect(MOCK_TRANSCRIPT_PREFIX).toBe("[MOCK TRANSCRIPT — no speech service was used]");
    expect(a.transcript).toMatch(/nothing you said was transcribed/);
  });

  it("makes no network call and has no usage hooks to reserve credits", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onSent = vi.fn();
    await createMockSpeechProvider().transcribe({ audio: new Uint8Array(1), mimeType: "audio/wav", language: "ta-IN", requestId: "r" }, { onSent });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("is recognisable wherever its text ends up", () => {
    expect(isMockTranscript(`  ${MOCK_TRANSCRIPT}`)).toBe(true);
    expect(isMockTranscript("A three-bedroom house")).toBe(false);
    expect(isMockTranscript(undefined)).toBe(false);
    expect(containsMockTranscript(`Our house. ${MOCK_TRANSCRIPT}`)).toBe(true);
    expect(isMockTranscript(`Our house. ${MOCK_TRANSCRIPT}`)).toBe(false);
    expect(containsMockTranscript("[MOCK] a house")).toBe(false);
    expect(containsMockTranscript(null)).toBe(false);
  });
});
