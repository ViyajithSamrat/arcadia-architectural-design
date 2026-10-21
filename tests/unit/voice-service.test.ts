import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVoiceMode, TANGLISH_DEMO, type VoiceMode } from "@/lib/journeys/voice";
import type { SpeechToTextProvider } from "@/lib/providers/interfaces";
import { ProviderError } from "@/lib/providers/interfaces";
import { createMockSpeechProvider, MOCK_TRANSCRIPT_PREFIX } from "@/lib/providers/mock-speech";
import { encodeWav } from "@/lib/voice/wav-encode";
import { verifyTranscriptToken, type TranscriptKey } from "@/lib/voice/provenance";
import { readTranscriptInput } from "@/lib/journeys/service";
import { transcribeForProject, type TranscribeInput } from "@/lib/voice/service";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const MOCK_MODE = getVoiceMode({ GNANI_VOICE_ENABLED: "mock" });
const LIVE_ENV = {
  GNANI_VOICE_ENABLED: "true",
  GNANI_API_KEY: "gnani-test-not-real",
  GNANI_BASE_URL: "https://api.vachana.ai",
  GNANI_STT_ENDPOINT: "/stt/v3",
  GNANI_LANGUAGES: "ta-IN",
  GNANI_CREDITS_PER_STT_SECOND: "2",
  GNANI_MAX_CREDITS_PER_REQUEST: "100",
  GNANI_CUSTOMER_CREDITS_PER_HOUR: "300",
  GNANI_BUDGET_CREDITS: "1000",
  VOICE_TRANSCRIPT_SECRET: "service-test-transcript-secret-0123456789",
};
const LIVE_MODE = getVoiceMode(LIVE_ENV);
/** What VOICE_TRANSCRIPT_SECRET would give the route; injected because the tests' process.env has none. */
const KEY: TranscriptKey = { secret: Buffer.from(LIVE_ENV.VOICE_TRANSCRIPT_SECRET), mockOnly: false };

const wavBlob = (seconds: number) => new Blob([encodeWav(new Float32Array(Math.round(seconds * 16_000)), 16_000) as BlobPart], { type: "audio/wav" });

let db: FakeDb;
const seedProject = (patch: Record<string, unknown> = {}) =>
  db.seed("projects", [{ id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "DRAFT", requirements_json: { schemaVersion: 1 }, ...patch }]);

const input = (patch: Partial<TranscribeInput> = {}): TranscribeInput => ({ projectId: PROJECT, language: "ta-IN", consent: true, audio: wavBlob(1), ...patch });

/** Counts calls, so a test can prove a provider was or was not used. */
function spy(inner: SpeechToTextProvider = createMockSpeechProvider()) {
  const calls: unknown[] = [];
  const provider: SpeechToTextProvider = { id: inner.id, transcribe: async (i, h) => (calls.push(i), inner.transcribe(i, h)) };
  return { provider, calls };
}

const run = (mode: VoiceMode, patch: Partial<TranscribeInput> = {}, extra: Parameters<typeof transcribeForProject>[3] = {}, user = ME) =>
  transcribeForProject(db.client(), user, input(patch), { mode, newRequestId: () => "req-1", signingKey: KEY, ...extra });

beforeEach(() => {
  db = new FakeDb();
  seedProject();
});
afterEach(() => vi.restoreAllMocks());

describe("transcribeForProject in mock mode", () => {
  it("gives the owner the labelled mock transcript, with the measured duration, and stores nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mock = spy();
    const result = await run(MOCK_MODE, { audio: wavBlob(3.2) }, { mockProvider: mock.provider });
    expect(result).toMatchObject({ ok: true, mock: true, language: "ta-IN", sourceLanguage: "ta-IN", seconds: 3.2, truncated: false });
    expect(result.ok && result.transcript.startsWith(MOCK_TRANSCRIPT_PREFIX)).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(db.writes).toHaveLength(0); // no project write, no audio, no transcript
    expect(db.rpcCalls).toHaveLength(0); // the usage ledger is never touched
    expect(db.uploads).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts the Tanglish demo selection without inventing a provider code", async () => {
    const result = await run(MOCK_MODE, { language: TANGLISH_DEMO });
    expect(result).toMatchObject({ ok: true, mock: true, language: TANGLISH_DEMO, sourceLanguage: null });
  });

  it("refuses someone else's project, and an unknown one, before looking at the audio", async () => {
    const mock = spy();
    db = new FakeDb();
    seedProject({ customer_id: OTHER });
    expect(await run(MOCK_MODE, { audio: "not audio" }, { mockProvider: mock.provider })).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });
    expect(await run(MOCK_MODE, { projectId: "44444444-4444-4444-8444-444444444444" }, { mockProvider: mock.provider })).toMatchObject({ code: "NOT_FOUND" });
    expect(await run(MOCK_MODE, { projectId: 42 }, { mockProvider: mock.provider })).toMatchObject({ code: "NOT_FOUND" });
    expect(mock.calls).toHaveLength(0);
  });

  it.each(["QUOTED", "AWAITING_PAYMENT", "PAYMENT_VERIFIED", "RELEASED", "CANCELLED"])("refuses a project that can no longer be edited (%s)", async (status) => {
    db = new FakeDb();
    seedProject({ status });
    expect(await run(MOCK_MODE)).toMatchObject({ ok: false, status: 409, code: "NOT_EDITABLE" });
  });

  it.each([false, "true", undefined, 1])("requires consent to be exactly true (got %j), before the language or audio is looked at", async (consent) => {
    const mock = spy();
    expect(await run(MOCK_MODE, { consent, language: "fr-FR", audio: "x" }, { mockProvider: mock.provider })).toMatchObject({ ok: false, status: 400, code: "CONSENT_REQUIRED" });
    expect(mock.calls).toHaveLength(0);
  });

  it.each(["fr-FR", "", "TA-IN", null])("refuses a language that is not offered (%j)", async (language) => {
    expect(await run(MOCK_MODE, { language })).toMatchObject({ ok: false, status: 400, code: "BAD_LANGUAGE" });
  });

  it("refuses anything that is not a valid recording, before the provider is used", async () => {
    const mock = spy();
    const cases: unknown[] = [
      undefined,
      "a string",
      new Blob([new TextEncoder().encode("<svg onload=alert(1)>")], { type: "audio/wav" }), // declared type is ignored
      wavBlob(0.3),
      wavBlob(31),
      new Blob([encodeWav(new Float32Array(16_000), 16_000).slice(0, 30) as BlobPart]),
    ];
    for (const audio of cases) {
      expect(await run(MOCK_MODE, { audio }, { mockProvider: mock.provider })).toMatchObject({ ok: false, status: 422, code: "BAD_AUDIO" });
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("cuts a transcript longer than the description field and says so", async () => {
    const long: SpeechToTextProvider = { id: "mock", transcribe: async () => ({ transcript: "x".repeat(2500), provider: "mock" }) };
    const result = await run(MOCK_MODE, {}, { mockProvider: long });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.transcript.length).toBe(2000);
  });
});

describe("transcribeForProject when voice is off, invalid or live", () => {
  it("does nothing at all when voice is off or the setting is invalid", async () => {
    const mock = spy();
    expect(await run({ kind: "off" }, {}, { mockProvider: mock.provider })).toMatchObject({ ok: false, status: 404, code: "VOICE_OFF" });
    expect(await run({ kind: "invalid" }, {}, { mockProvider: mock.provider })).toMatchObject({ ok: false, status: 503, code: "VOICE_UNAVAILABLE" });
    expect(mock.calls).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("an incomplete live configuration is unavailable and never falls back to the mock", async () => {
    const mock = spy();
    const mode = getVoiceMode({ GNANI_VOICE_ENABLED: "true" });
    expect(await run(mode, {}, { mockProvider: mock.provider })).toMatchObject({ ok: false, status: 503, code: "VOICE_UNAVAILABLE" });
    expect(mock.calls).toHaveLength(0);
  });

  it("a complete live configuration without wired live dependencies (R1-A) is unavailable: no provider, no ledger, no network, no mock", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mock = spy();
    expect(LIVE_MODE.kind).toBe("live");
    expect(await run(LIVE_MODE, {}, { mockProvider: mock.provider })).toMatchObject({ ok: false, status: 503, code: "VOICE_UNAVAILABLE" });
    expect(mock.calls).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses the demo-only Tanglish selection in live mode", async () => {
    expect(await run(LIVE_MODE, { language: TANGLISH_DEMO })).toMatchObject({ ok: false, code: "BAD_LANGUAGE" });
  });
});

describe("the live path, with injected fakes only (for the future, unreachable from the route in R1-A)", () => {
  const ledger = () => {
    const service = new FakeDb();
    service.rpcHandlers.ai_usage_reserve = () => ({ data: "usage-1" });
    service.rpcHandlers.ai_usage_finish = () => ({ data: null });
    return service;
  };
  const live = (transcript = "oru moonu bedroom veedu venum") => spy({ id: "gnani", transcribe: async (_i, hooks) => (hooks?.onSent?.(), { transcript, provider: "gnani" }) });

  it("estimates credits from the server-measured duration, reserves first, then calls once", async () => {
    const service = ledger();
    const provider = live();
    const mock = spy();
    const result = await run(LIVE_MODE, { audio: wavBlob(3.2) }, { live: { provider: provider.provider, service: service.client() }, mockProvider: mock.provider });
    expect(result).toMatchObject({ ok: true, mock: false, transcript: "oru moonu bedroom veedu venum", sourceLanguage: "ta-IN" });
    expect(service.rpcCalls.map((c) => c.name)).toEqual(["ai_usage_reserve", "ai_usage_finish"]);
    // 3.2 s measured, rounded up to 4 s, at 2 credits per second
    expect(service.rpcCalls[0].args).toMatchObject({ p_provider: "gnani", p_operation: "stt", p_unit: "credit", p_units: 8, p_max_in_flight: 1, p_customer_id: ME, p_project_id: PROJECT });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ mimeType: "audio/wav", language: "ta-IN" });
    expect(mock.calls).toHaveLength(0);
  });

  it("makes no call when the reservation is refused", async () => {
    const service = ledger();
    service.rpcHandlers.ai_usage_reserve = () => ({ error: { code: "AI001", message: "limit" } });
    const provider = live();
    expect(await run(LIVE_MODE, {}, { live: { provider: provider.provider, service: service.client() } })).toMatchObject({ ok: false, status: 429, code: "LIMIT" });
    expect(provider.calls).toHaveLength(0);
  });

  it("reports a provider failure as a failure, without its detail, counts it, and never substitutes the mock", async () => {
    const service = ledger();
    const mock = spy();
    const failing: SpeechToTextProvider = {
      id: "gnani",
      transcribe: async (_i, hooks) => {
        hooks?.onSent?.();
        throw new ProviderError("server", "upstream said: internal detail");
      },
    };
    const result = await run(LIVE_MODE, {}, { live: { provider: failing, service: service.client() }, mockProvider: mock.provider });
    expect(result).toMatchObject({ ok: false, status: 502, code: "PROVIDER_FAILED" });
    expect(JSON.stringify(result)).not.toContain("internal detail");
    expect(service.rpcCalls[1].args).toMatchObject({ p_status: "FAILED" });
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses a recording whose estimate exceeds the per-request maximum, before reserving", async () => {
    const service = ledger();
    const mode = getVoiceMode({ ...LIVE_ENV, GNANI_MAX_CREDITS_PER_REQUEST: "5" });
    expect(await run(mode, { audio: wavBlob(3) }, { live: { provider: live().provider, service: service.client() } })).toMatchObject({ ok: false, code: "LIMIT" });
    expect(service.rpcCalls).toHaveLength(0);
  });
});

describe("transcript provenance from the transcribe service (R1-B)", () => {
  const MOCK_ONLY: TranscriptKey = { secret: Buffer.from("process-key-for-tests-0123456789abcdef"), mockOnly: true };

  it("signs every transcript it returns over the caller, the project and exactly that text, as a mock", async () => {
    const result = await run(MOCK_MODE);
    if (!result.ok) throw new Error("expected a transcript");
    expect(verifyTranscriptToken(result.provenance, { userId: ME, projectId: PROJECT, transcript: result.transcript }, [KEY])).toMatchObject({ source: "mock", sourceLanguage: "ta-IN" });
    expect(verifyTranscriptToken(result.provenance, { userId: OTHER, projectId: PROJECT, transcript: result.transcript }, [KEY])).toBeNull();
  });

  it("signs a live transcript as Gnani, with the provider language", async () => {
    const service = new FakeDb();
    service.rpcHandlers.ai_usage_reserve = () => ({ data: "usage-1" });
    service.rpcHandlers.ai_usage_finish = () => ({ data: null });
    const provider: SpeechToTextProvider = { id: "gnani", transcribe: async (_i, hooks) => (hooks?.onSent?.(), { transcript: "moonu bedroom", provider: "gnani" }) };
    const result = await run(LIVE_MODE, {}, { live: { provider, service: service.client() } });
    if (!result.ok) throw new Error("expected a transcript");
    expect(verifyTranscriptToken(result.provenance, { userId: ME, projectId: PROJECT, transcript: "moonu bedroom" }, [KEY])).toMatchObject({ source: "gnani", sourceLanguage: "ta-IN" });
  });

  it("refuses live transcription with no key or only a mock-only key, before any provider, ledger or audio work", async () => {
    const service = new FakeDb();
    const provider = spy({ id: "gnani", transcribe: async () => ({ transcript: "x", provider: "gnani" }) });
    for (const signingKey of [null, MOCK_ONLY]) {
      expect(await run(LIVE_MODE, {}, { live: { provider: provider.provider, service: service.client() }, signingKey })).toMatchObject({ ok: false, status: 503, code: "VOICE_UNAVAILABLE" });
    }
    expect(provider.calls).toHaveLength(0);
    expect(service.rpcCalls).toHaveLength(0);
  });

  it("a transcript cut at the description limit right after a space still verifies after the save path trims it", async () => {
    const long: SpeechToTextProvider = { id: "mock", transcribe: async () => ({ transcript: `${"a".repeat(1999)} ${"b".repeat(100)}`, provider: "mock" }) };
    const result = await run(MOCK_MODE, {}, { mockProvider: long });
    if (!result.ok) throw new Error("expected a transcript");
    expect(result.truncated).toBe(true);
    // The save path receives the transcript through readTranscriptInput, which trims it.
    const received = readTranscriptInput({ original: result.transcript, used: "x", provenance: result.provenance });
    expect(received).not.toBeNull();
    expect(verifyTranscriptToken(result.provenance, { userId: ME, projectId: PROJECT, transcript: received!.original }, [KEY])).not.toBeNull();
  });

  it("the mock can be signed with the process-only key", async () => {
    expect(await run(MOCK_MODE, {}, { signingKey: MOCK_ONLY })).toMatchObject({ ok: true, mock: true });
  });
});
