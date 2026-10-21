import { describe, expect, it, vi } from "vitest";
import { parseWav } from "@/lib/providers/wav";
import { requestTranscription } from "@/lib/voice/client";
import { RecorderError, RESUME_TIMEOUT_MS, WavRecorder, type AudioContextLike, type MediaStreamLike, type RecorderEnv } from "@/lib/voice/recorder";
import { encodedSeconds } from "@/lib/voice/wav-encode";

type ResumeBehaviour = "runs" | "stays_suspended" | "rejects" | "never_settles";

/** Fake microphone and audio graph that record what was opened and released. */
function fakeBrowser(sampleRate = 48_000, initialState = "running", resume: ResumeBehaviour = "runs") {
  const tracks = [{ stop: vi.fn() }];
  const stream: MediaStreamLike = { getTracks: () => tracks };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as null | ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) };
  const ctx: AudioContextLike & { state: string } = {
    sampleRate,
    destination: {},
    state: initialState,
    resume: vi.fn(async () => {
      if (resume === "runs") ctx.state = "running";
      if (resume === "rejects") throw new Error("not allowed");
      if (resume === "never_settles") await new Promise(() => undefined);
    }),
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    close: vi.fn(async () => undefined),
  };
  let grant: (s: MediaStreamLike) => void = () => undefined;
  const env: RecorderEnv = { getUserMedia: vi.fn(async () => stream), createAudioContext: () => ctx };
  const slowEnv: RecorderEnv = { getUserMedia: vi.fn(() => new Promise<MediaStreamLike>((resolve) => (grant = resolve))), createAudioContext: () => ctx };
  /** Feeds `seconds` of a quiet tone in 4096-sample buffers. */
  const feed = (seconds: number) => {
    let left = Math.round(seconds * sampleRate);
    while (left > 0 && processor.onaudioprocess) {
      const n = Math.min(4096, left);
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(n).fill(0.1) } });
      left -= n;
    }
  };
  const released = () => tracks.every((t) => t.stop.mock.calls.length > 0) && processor.disconnect.mock.calls.length > 0 && source.disconnect.mock.calls.length > 0 && vi.mocked(ctx.close).mock.calls.length > 0;
  return { env, slowEnv, grant: () => grant(stream), feed, tracks, processor, ctx, released };
}

const durationOf = (wav: Uint8Array | null) => {
  const r = wav ? parseWav(wav, { maxSeconds: 30 }) : null;
  return r && r.ok ? r.wav : null;
};

describe("WavRecorder", () => {
  it("reports an unsupported browser and a refused or missing microphone", async () => {
    await expect(new WavRecorder({}, { maxSeconds: 30 }).start()).rejects.toMatchObject({ code: "unsupported" });
    const denied = Object.assign(new Error("no"), { name: "NotAllowedError" });
    const missing = Object.assign(new Error("no"), { name: "NotFoundError" });
    const browser = fakeBrowser();
    await expect(new WavRecorder({ ...browser.env, getUserMedia: async () => Promise.reject(denied) }, { maxSeconds: 30 }).start()).rejects.toMatchObject({ code: "permission_denied" });
    await expect(new WavRecorder({ ...browser.env, getUserMedia: async () => Promise.reject(missing) }, { maxSeconds: 30 }).start()).rejects.toBeInstanceOf(RecorderError);
  });

  it("records 16 kHz mono 16-bit WAV that the server accepts, then releases the microphone and audio graph", async () => {
    const b = fakeBrowser(48_000);
    const progress: number[] = [];
    const rec = new WavRecorder(b.env, { maxSeconds: 30, onProgress: (s) => progress.push(s) });
    await rec.start();
    expect(rec.recording).toBe(true);
    expect(b.env.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ channelCount: 1 }) });
    b.feed(2);
    const wav = rec.stop();
    expect(durationOf(wav)).toMatchObject({ sampleRate: 16_000, seconds: 2 });
    expect(progress.at(-1)).toBeCloseTo(2, 1);
    expect(rec.recording).toBe(false);
    expect(b.released()).toBe(true);
    expect(rec.stop()).toBeNull(); // stopping twice gives nothing
  });

  it("stops by itself at the limit, exactly at the limit, and hands over the recording once", async () => {
    const b = fakeBrowser(44_100);
    const onAutoStop = vi.fn();
    const rec = new WavRecorder(b.env, { maxSeconds: 3, onAutoStop });
    await rec.start();
    b.feed(5);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    const wav = durationOf(onAutoStop.mock.calls[0][0]);
    expect(wav?.seconds).toBeLessThanOrEqual(3);
    expect(wav?.seconds).toBeGreaterThan(2.99);
    expect(b.released()).toBe(true);
  });

  it("cancel throws the recording away and releases everything", async () => {
    const b = fakeBrowser();
    const rec = new WavRecorder(b.env, { maxSeconds: 30 });
    await rec.start();
    b.feed(1);
    rec.cancel();
    expect(rec.recording).toBe(false);
    expect(rec.stop()).toBeNull();
    expect(b.released()).toBe(true);
  });

  it("can record again after a stop (re-record)", async () => {
    const b = fakeBrowser();
    const rec = new WavRecorder(b.env, { maxSeconds: 30 });
    await rec.start();
    b.feed(1);
    rec.stop();
    await rec.start();
    b.feed(0.75);
    expect(durationOf(rec.stop())?.seconds).toBe(0.75);
  });

  it("lets go of a microphone granted after the component was unmounted, and never starts again", async () => {
    const b = fakeBrowser();
    const rec = new WavRecorder(b.slowEnv, { maxSeconds: 30 });
    const starting = rec.start();
    rec.dispose();
    b.grant();
    await starting;
    expect(rec.recording).toBe(false);
    expect(b.tracks[0].stop).toHaveBeenCalled();
    await rec.start();
    expect(rec.recording).toBe(false);
  });

  it("resumes a context that starts suspended, then records normally", async () => {
    const b = fakeBrowser(48_000, "suspended", "runs");
    const rec = new WavRecorder(b.env, { maxSeconds: 30 });
    await rec.start();
    expect(b.ctx.resume).toHaveBeenCalledTimes(1);
    expect(rec.recording).toBe(true);
    b.feed(1);
    expect(durationOf(rec.stop())?.seconds).toBe(1);
  });

  it("does not resume a context that is already running", async () => {
    const b = fakeBrowser();
    await new WavRecorder(b.env, { maxSeconds: 30 }).start();
    expect(b.ctx.resume).not.toHaveBeenCalled();
  });

  it.each(["stays_suspended", "rejects"] as const)("refuses to record when the context will not run (%s) and releases everything", async (behaviour) => {
    const b = fakeBrowser(48_000, "suspended", behaviour);
    const rec = new WavRecorder(b.env, { maxSeconds: 30 });
    await expect(rec.start()).rejects.toMatchObject({ code: "not_running" });
    expect(rec.recording).toBe(false);
    expect(b.tracks[0].stop).toHaveBeenCalled();
    expect(b.ctx.close).toHaveBeenCalled();
    expect(b.ctx.createScriptProcessor).not.toHaveBeenCalled();
  });

  it("gives up on a resume that never settles after the time limit", async () => {
    vi.useFakeTimers();
    try {
      const b = fakeBrowser(48_000, "suspended", "never_settles");
      const refused = expect(new WavRecorder(b.env, { maxSeconds: 30 }).start()).rejects.toMatchObject({ code: "not_running" });
      await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS);
      await refused;
      expect(b.tracks[0].stop).toHaveBeenCalled();
      expect(b.ctx.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of everything when cancelled while the context is resuming", async () => {
    vi.useFakeTimers();
    try {
      const b = fakeBrowser(48_000, "suspended", "never_settles");
      const rec = new WavRecorder(b.env, { maxSeconds: 30 });
      const starting = rec.start();
      await vi.advanceTimersByTimeAsync(0); // past the microphone grant, into the resume
      expect(b.ctx.resume).toHaveBeenCalled();
      rec.cancel();
      await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS);
      await expect(starting).resolves.toBeUndefined(); // a cancel is not an error
      expect(rec.recording).toBe(false);
      expect(b.tracks[0].stop).toHaveBeenCalled();
      expect(b.ctx.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a recording with no samples encodes as zero seconds, which the screen refuses before upload", async () => {
    const b = fakeBrowser();
    const rec = new WavRecorder(b.env, { maxSeconds: 30 });
    await rec.start();
    const wav = rec.stop();
    expect(wav).not.toBeNull();
    expect(encodedSeconds(wav as Uint8Array)).toBe(0);
    expect(encodedSeconds(new Uint8Array(10))).toBe(0);
  });

  it("starting twice does not open a second microphone", async () => {
    const b = fakeBrowser();
    const rec = new WavRecorder(b.env, { maxSeconds: 30 });
    await rec.start();
    await rec.start();
    expect(b.env.getUserMedia).toHaveBeenCalledTimes(1);
    rec.dispose();
  });
});

describe("requestTranscription", () => {
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });

  it("sends nothing without consent", async () => {
    const doFetch = vi.fn();
    expect(await requestTranscription("p1", { audio, language: "ta-IN", consent: false }, doFetch)).toMatchObject({ ok: false, message: expect.stringMatching(/agree/) });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("posts the recording, the language and consent to the project's route", async () => {
    const doFetch = vi.fn(async () => Response.json({ ok: true, transcript: "hello", mock: true, language: "ta-IN", sourceLanguage: "ta-IN", seconds: 1, truncated: false }));
    const out = await requestTranscription("33333333-3333-4333-8333-333333333333", { audio, language: "ta-IN", consent: true }, doFetch as unknown as typeof fetch);
    expect(out).toEqual({ ok: true, transcript: "hello", mock: true, language: "ta-IN", sourceLanguage: "ta-IN", seconds: 1, truncated: false, provenance: null });
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/33333333-3333-4333-8333-333333333333/transcribe");
    const form = init.body as FormData;
    expect(form.get("language")).toBe("ta-IN");
    expect(form.get("consent")).toBe("true");
    expect(form.get("audio")).toBeInstanceOf(Blob);
  });

  it("passes the server's provenance token through untouched, and drops an oversized one", async () => {
    const answer = (provenance: string) => vi.fn(async () => Response.json({ ok: true, transcript: "hello", provenance }));
    const ok = await requestTranscription("p", { audio, language: "ta-IN", consent: true }, answer("v1.abc.def") as unknown as typeof fetch);
    expect(ok).toMatchObject({ ok: true, provenance: "v1.abc.def" });
    const huge = await requestTranscription("p", { audio, language: "ta-IN", consent: true }, answer("x".repeat(3000)) as unknown as typeof fetch);
    expect(huge).toMatchObject({ ok: true, provenance: null });
  });

  it("passes the abort signal on, so an unmount can cancel the upload", async () => {
    const doFetch = vi.fn(async () => Response.json({ ok: true, transcript: "hello" }));
    const signal = new AbortController().signal;
    await requestTranscription("p", { audio, language: "ta-IN", consent: true, signal }, doFetch as unknown as typeof fetch);
    expect((doFetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(signal);
  });

  it("passes on the server's customer-safe message, and has its own for a network failure", async () => {
    const refused = vi.fn(async () => Response.json({ ok: false, error: { code: "BAD_AUDIO", message: "This file is not a valid WAV recording." } }, { status: 422 }));
    expect(await requestTranscription("p", { audio, language: "ta-IN", consent: true }, refused as unknown as typeof fetch)).toEqual({ ok: false, message: "This file is not a valid WAV recording." });
    const offline = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    expect(await requestTranscription("p", { audio, language: "ta-IN", consent: true }, offline as unknown as typeof fetch)).toMatchObject({ ok: false, message: expect.stringMatching(/could not be sent/) });
  });
});
