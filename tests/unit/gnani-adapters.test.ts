import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGnaniReadiness, type GnaniConfig } from "@/lib/providers/config";
import { createGnaniSttProvider, createGnaniTtsProvider, STT_MAX_BYTES } from "@/lib/providers/gnani";
import { ProviderError } from "@/lib/providers/interfaces";

const KEY = "gnani-test-NOT-A-REAL-KEY";
const ENV = {
  GNANI_VOICE_ENABLED: "true",
  GNANI_API_KEY: KEY,
  GNANI_BASE_URL: "https://api.vachana.ai",
  GNANI_STT_ENDPOINT: "/stt/v3",
  GNANI_TTS_ENDPOINT: "/api/v1/tts/inference",
  GNANI_TTS_MODEL: "timbre-v2.5",
  GNANI_TTS_VOICE: "voice-x",
  GNANI_LANGUAGES: "hi-IN,en-IN",
  GNANI_CREDITS_PER_STT_SECOND: "1",
  GNANI_CREDITS_PER_TTS_CHAR: "1",
  GNANI_MAX_CREDITS_PER_REQUEST: "100",
  GNANI_CUSTOMER_CREDITS_PER_HOUR: "300",
  GNANI_BUDGET_CREDITS: "1000",
};
const config = (): GnaniConfig => {
  const r = getGnaniReadiness(ENV);
  if (!r.ready) throw new Error("fixture must be ready");
  return r.config;
};

type Seen = { url: string; init: RequestInit };
function fakeFetch(respond: (seen: Seen) => Response | never) {
  const calls: Seen[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const seen = { url: String(url), init };
    calls.push(seen);
    return respond(seen);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
const REQUEST_ID = "9b2f7f0e-3c1e-4c5e-8d2b-1a2b3c4d5e6f";
const stt = (override: Partial<{ audio: Uint8Array; mimeType: string; language: string; requestId: string }> = {}) => ({ audio: WAV, mimeType: "audio/wav", language: "hi-IN", requestId: REQUEST_ID, ...override });
const okStt = () => new Response(JSON.stringify({ success: true, request_id: "r-1", timestamp: "20261018_100000.000", transcript: "  three bedrooms  " }), { status: 200 });
const audio = (bytes = 64, type = "audio/wav") => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } });

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("speech-to-text adapter (documented shape, mocked network)", () => {
  it("posts multipart audio_file and language_code to the configured endpoint with X-API-Key-ID", async () => {
    const { fn, calls } = fakeFetch(okStt);
    const result = await createGnaniSttProvider(config(), { fetch: fn }).transcribe(stt());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.vachana.ai/stt/v3");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "X-API-Key-ID": KEY, "X-API-Request-ID": REQUEST_ID });
    const form = calls[0].init.body as FormData;
    expect(form.get("language_code")).toBe("hi-IN");
    const file = form.get("audio_file") as File;
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(WAV.length);
    expect(result).toEqual({ transcript: "three bedrooms", provider: "gnani", requestId: "r-1" });
  });

  it("omits the request id header unless it is a UUID", async () => {
    const { fn, calls } = fakeFetch(okStt);
    await createGnaniSttProvider(config(), { fetch: fn }).transcribe(stt({ requestId: "not-a-uuid" }));
    expect(calls[0].init.headers).toEqual({ "X-API-Key-ID": KEY });
  });

  it.each([
    ["an unsupported language", { language: "fr-FR" }],
    ["a language that is documented but not offered", { language: "ta-IN" }],
    ["WebM audio (not a documented format)", { mimeType: "audio/webm" }],
    ["an unknown type", { mimeType: "application/octet-stream" }],
    ["empty audio", { audio: new Uint8Array(0) }],
    ["oversized audio", { audio: new Uint8Array(STT_MAX_BYTES + 1) }],
  ])("refuses %s before any request is made", async (_n, patch) => {
    const { fn, calls } = fakeFetch(okStt);
    const onNotSent = vi.fn();
    await expect(createGnaniSttProvider(config(), { fetch: fn }).transcribe(stt(patch), { onNotSent })).rejects.toMatchObject({ code: "unsupported_input" });
    expect(calls).toHaveLength(0);
    expect(onNotSent).toHaveBeenCalledTimes(1);
  });

  it("does not report a request as sent when it refuses the input", async () => {
    const onSent = vi.fn();
    await createGnaniSttProvider(config(), { fetch: fakeFetch(okStt).fn }).transcribe(stt({ language: "xx-XX" }), { onSent }).catch(() => undefined);
    expect(onSent).not.toHaveBeenCalled();
  });

  it("reports that it sent a request, and passes on the request id but no invented usage", async () => {
    const onSent = vi.fn();
    const onUsage = vi.fn();
    await createGnaniSttProvider(config(), { fetch: fakeFetch(okStt).fn }).transcribe(stt(), { onSent, onUsage });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ requestId: "r-1", model: null, units: null });
  });

  it("allows an empty transcript (silence)", async () => {
    const { fn } = fakeFetch(() => new Response(JSON.stringify({ success: true, transcript: "" }), { status: 200 }));
    expect((await createGnaniSttProvider(config(), { fetch: fn }).transcribe(stt())).transcript).toBe("");
  });

  it.each([
    [400, "bad_request"],
    [401, "auth"],
    [402, "auth"],
    [403, "auth"],
    [422, "bad_request"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [504, "server"],
  ])("maps HTTP %i to %s and makes no retry", async (status, code) => {
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ success: false, error: { type: "X", message: `bad ${KEY}` } }), { status }));
    const error = await createGnaniSttProvider(config(), { fetch: fn }).transcribe(stt()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain(KEY);
    expect(calls).toHaveLength(1);
    const logged = info.mock.calls.flat().join("\n");
    expect(logged).toContain(`"httpStatus":${status}`);
    expect(logged).not.toContain(KEY);
  });

  it("maps a timeout and a network failure, with no retry", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const a = fakeFetch(() => { throw timeout; });
    await expect(createGnaniSttProvider(config(), { fetch: a.fn }).transcribe(stt())).rejects.toMatchObject({ code: "timeout" });
    const b = fakeFetch(() => { throw new TypeError("fetch failed"); });
    await expect(createGnaniSttProvider(config(), { fetch: b.fn }).transcribe(stt())).rejects.toMatchObject({ code: "server" });
    expect(a.calls.length + b.calls.length).toBe(2);
  });

  it.each([
    ["success false", { success: false, transcript: "x" }],
    ["a missing transcript", { success: true }],
    ["a non-string transcript", { success: true, transcript: 42 }],
    ["an over-long transcript", { success: true, transcript: "a".repeat(5001) }],
    ["an array", []],
  ])("rejects a response with %s", async (_n, body) => {
    const { fn } = fakeFetch(() => new Response(JSON.stringify(body), { status: 200 }));
    await expect(createGnaniSttProvider(config(), { fetch: fn }).transcribe(stt())).rejects.toMatchObject({ code: "bad_response" });
  });

  it("rejects a response that is not JSON", async () => {
    const { fn } = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(createGnaniSttProvider(config(), { fetch: fn }).transcribe(stt())).rejects.toMatchObject({ code: "bad_response" });
  });

  it("logs provider, operation, request id and status only: no key, no transcript", async () => {
    await createGnaniSttProvider(config(), { fetch: fakeFetch(okStt).fn }).transcribe(stt());
    const line = String(info.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ event: "provider_call", provider: "gnani", operation: "stt", requestId: "r-1", status: "ok" });
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("three bedrooms");
  });
});

describe("text-to-speech adapter (documented shape, mocked network)", () => {
  const tts = (patch: Partial<{ text: string; language: string; requestId: string }> = {}) => ({ text: "Your brief is ready.", language: "en-IN", requestId: REQUEST_ID, ...patch });

  it("posts the documented JSON body and returns the raw audio with its type", async () => {
    const { fn, calls } = fakeFetch(() => audio(100));
    const result = await createGnaniTtsProvider(config(), { fetch: fn }).synthesize(tts());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.vachana.ai/api/v1/tts/inference");
    expect(calls[0].init.headers).toMatchObject({ "X-API-Key-ID": KEY, "Content-Type": "application/json" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      text: "Your brief is ready.",
      model: "timbre-v2.5",
      voice: "voice-x",
      language: "en-IN",
      speed: 1,
      audio_config: { sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: "linear_pcm", container: "wav" },
    });
    expect(result).toMatchObject({ mimeType: "audio/wav", provider: "gnani", model: "timbre-v2.5" });
    expect(result.audio.byteLength).toBe(100);
  });

  it.each([
    ["an empty text", { text: "   " }],
    ["a text over the limit", { text: "a".repeat(601) }],
    ["an unsupported language", { language: "fr-FR" }],
    ["a language that is not offered", { language: "ta-IN" }],
  ])("refuses %s before any request is made", async (_n, patch) => {
    const { fn, calls } = fakeFetch(() => audio());
    const onNotSent = vi.fn();
    await expect(createGnaniTtsProvider(config(), { fetch: fn }).synthesize(tts(patch), { onNotSent })).rejects.toMatchObject({ code: "unsupported_input" });
    expect(calls).toHaveLength(0);
    expect(onNotSent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "bad_request"],
    [402, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [500, "server"],
  ])("maps HTTP %i to %s and makes no retry", async (status, code) => {
    const { fn, calls } = fakeFetch(() => new Response("{}", { status }));
    await expect(createGnaniTtsProvider(config(), { fetch: fn }).synthesize(tts())).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(1);
  });

  it("rejects a response that is not audio, is empty, or is too large", async () => {
    for (const respond of [
      () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      () => audio(0),
      () => new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "audio/wav", "content-length": String(50 * 1024 * 1024) } }),
    ]) {
      await expect(createGnaniTtsProvider(config(), { fetch: fakeFetch(respond).fn }).synthesize(tts())).rejects.toMatchObject({ code: "bad_response" });
    }
  });

  it("maps a timeout", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    await expect(createGnaniTtsProvider(config(), { fetch: fakeFetch(() => { throw timeout; }).fn }).synthesize(tts())).rejects.toMatchObject({ code: "timeout" });
  });

  it("logs without the key or the text that was spoken", async () => {
    await createGnaniTtsProvider(config(), { fetch: fakeFetch(() => audio()).fn }).synthesize(tts({ text: "SECRET-BRIEF-TEXT" }));
    const line = String(info.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ provider: "gnani", operation: "tts", model: "timbre-v2.5", status: "ok" });
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("SECRET-BRIEF-TEXT");
  });
});

describe("no accidental network use", () => {
  it("the default test environment blocks the real fetch", () => {
    expect(() => fetch("https://api.vachana.ai/stt/v3")).toThrow(/blocked/);
  });
});
