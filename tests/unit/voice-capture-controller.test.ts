import { describe, expect, it, vi } from "vitest";
import { MOCK_TRANSCRIPT } from "@/lib/providers/mock-speech";
import { NOTHING_RECORDED, RECORDER_MESSAGES, TOO_SHORT, UPLOAD_TIMED_OUT, VoiceCaptureController, type CaptureState, type RecorderLike } from "@/lib/voice/capture";
import type { TranscriptionOutcome } from "@/lib/voice/client";
import { RecorderError, type RecorderOptions } from "@/lib/voice/recorder";
import { encodeWav } from "@/lib/voice/wav-encode";

const wavOf = (seconds: number) => encodeWav(new Float32Array(Math.round(seconds * 16_000)).fill(0.1), 16_000);

/** A recorder whose microphone grant, stop result and auto-stop the test controls. */
class FakeRecorder implements RecorderLike {
  recording = false;
  disposed = false;
  cancelled = false;
  private grant: (() => void) | null = null;
  private refuse: ((error: unknown) => void) | null = null;
  constructor(
    readonly options: RecorderOptions,
    private readonly nextWav: () => Uint8Array,
  ) {}
  start() {
    return new Promise<void>((resolve, reject) => {
      this.grant = () => {
        if (!this.disposed && !this.cancelled) this.recording = true;
        resolve();
      };
      this.refuse = reject;
    });
  }
  allow() {
    this.grant?.();
  }
  deny(error: unknown) {
    this.refuse?.(error);
  }
  stop() {
    if (!this.recording) return null;
    this.recording = false;
    return this.nextWav();
  }
  /** The limit was reached: the recording stops itself and is handed over. */
  autoStop() {
    const wav = this.stop();
    if (wav) this.options.onAutoStop?.(wav);
  }
  cancel() {
    this.cancelled = true;
    this.recording = false;
  }
  dispose() {
    this.disposed = true;
    this.recording = false;
  }
}

const UPLOAD_TIMEOUT_MS = 45_000;

type Pending = { resolve: (o: TranscriptionOutcome) => void; signal: AbortSignal };

function setup(nextWav: () => Uint8Array = () => wavOf(2)) {
  const recorders: FakeRecorder[] = [];
  const pending: Pending[] = [];
  const states: CaptureState[] = [];
  const transcribe = vi.fn(
    (_audio: Blob, signal: AbortSignal) => new Promise<TranscriptionOutcome>((resolve) => pending.push({ resolve, signal })),
  );
  const controller = new VoiceCaptureController({
    maxSeconds: 30,
    uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
    createRecorder: (options) => {
      const r = new FakeRecorder(options, nextWav);
      recorders.push(r);
      return r;
    },
    transcribe,
    onChange: (s) => states.push(s),
  });
  const answer = (i: number, transcript: string) =>
    pending[i].resolve({ ok: true, transcript, mock: false, language: "en-IN", sourceLanguage: "en-IN", seconds: 2, truncated: false, provenance: `token-${i}` });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { controller, recorders, pending, states, transcribe, answer, settle };
}

/** Starts and grants the microphone, so the controller is recording. */
async function recording(t: ReturnType<typeof setup>) {
  const started = t.controller.start();
  t.recorders.at(-1)?.allow();
  await started;
  expect(t.controller.state.phase).toBe("recording");
}

describe("VoiceCaptureController: one operation at a time", () => {
  it("enters 'starting' before the permission prompt resolves, and nothing else can begin meanwhile", async () => {
    const t = setup();
    const started = t.controller.start();
    expect(t.controller.state.phase).toBe("starting");
    expect(t.controller.busy).toBe(true);
    void t.controller.start();
    t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
    expect(t.recorders).toHaveLength(1);
    expect(t.transcribe).not.toHaveBeenCalled();
    t.recorders[0].allow();
    await started;
    expect(t.controller.state.phase).toBe("recording");
  });

  it("an auto-stop followed by a late 'Stop and send' sends once and never resets the screen during the upload", async () => {
    const t = setup();
    await recording(t);
    t.recorders[0].autoStop();
    expect(t.controller.state.phase).toBe("sending");
    t.controller.stop(); // the click that raced the re-render
    expect(t.controller.state.phase).toBe("sending");
    expect(t.states.some((s, i) => i > 0 && s.phase === "idle" && t.states[i - 1].phase === "sending")).toBe(false);
    void t.controller.start(); // and no new recording can start under the upload
    expect(t.recorders).toHaveLength(1);
    expect(t.transcribe).toHaveBeenCalledTimes(1);
    t.answer(0, "hello");
    await t.settle();
    expect(t.controller.state).toMatchObject({ phase: "result", result: { transcript: "hello" } });
  });

  it("a manual stop followed by an auto-stop from the same recording sends once", async () => {
    const t = setup();
    await recording(t);
    t.controller.stop();
    t.recorders[0].autoStop();
    expect(t.transcribe).toHaveBeenCalledTimes(1);
  });

  it("a file cannot be sent while a recording is running or an upload is in flight", async () => {
    const t = setup();
    await recording(t);
    t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
    expect(t.transcribe).not.toHaveBeenCalled();
    t.controller.stop();
    t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
    expect(t.transcribe).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceCaptureController: cancel, teardown and stale answers", () => {
  it("cancel while the browser is asking for the microphone lets go of a late grant", async () => {
    const t = setup();
    const started = t.controller.start();
    t.controller.cancel();
    expect(t.controller.state.phase).toBe("idle");
    t.recorders[0].allow();
    await started;
    expect(t.controller.state.phase).toBe("idle");
    expect(t.recorders[0].recording).toBe(false);
    expect(t.recorders[0].disposed || t.recorders[0].cancelled).toBe(true);
  });

  it("an auto-stop from a cancelled recording changes nothing", async () => {
    const t = setup();
    await recording(t);
    const old = t.recorders[0];
    t.controller.cancel();
    old.options.onAutoStop?.(wavOf(2));
    old.options.onProgress?.(12);
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.controller.state).toMatchObject({ phase: "idle", elapsed: 0 });
  });

  it("teardown aborts the upload and stops the microphone; the late answer changes nothing", async () => {
    const t = setup();
    await recording(t);
    t.controller.stop();
    const seen = t.states.length;
    t.controller.teardown();
    expect(t.pending[0].signal.aborted).toBe(true);
    t.answer(0, "too late");
    await t.settle();
    expect(t.states).toHaveLength(seen);

    // Teardown during a recording releases the microphone.
    const u = setup();
    await recording(u);
    u.controller.teardown();
    expect(u.recorders[0].disposed).toBe(true);
  });

  it("an older answer cannot overwrite a newer result after a remount", async () => {
    const t = setup();
    t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
    t.controller.teardown(); // React unmounts and mounts again
    t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
    t.answer(1, "newer");
    await t.settle();
    t.answer(0, "older");
    await t.settle();
    expect(t.controller.state.result?.transcript).toBe("newer");
  });
});

describe("VoiceCaptureController: what is refused before upload", () => {
  it.each([
    [0, NOTHING_RECORDED],
    [0.2, TOO_SHORT],
  ])("a %s-second recording is not sent", async (seconds, message) => {
    const t = setup(() => wavOf(seconds));
    await recording(t);
    t.controller.stop();
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.controller.state).toMatchObject({ phase: "idle", error: message });
  });

  it("reports a context that would not run, and can try again", async () => {
    const t = setup();
    const started = t.controller.start();
    t.recorders[0].deny(new RecorderError("not_running"));
    await started;
    expect(t.controller.state).toMatchObject({ phase: "idle", error: RECORDER_MESSAGES.not_running });
    await recording(t);
    expect(t.controller.state.error).toBeNull();
  });

  it("keeps the mock placeholder marked as mock even if the server did not say so", async () => {
    const t = setup();
    t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
    t.answer(0, MOCK_TRANSCRIPT);
    await t.settle();
    expect(t.controller.state.result?.mock).toBe(true);
  });

  it("shows a failed upload as an error and returns to idle", async () => {
    const t = setup();
    t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
    t.pending[0].resolve({ ok: false, message: "This file is not a valid WAV recording." });
    await t.settle();
    expect(t.controller.state).toMatchObject({ phase: "idle", error: "This file is not a valid WAV recording." });
  });
});

describe("VoiceCaptureController: the upload time limit", () => {
  it("an upload that never answers is aborted at the limit, reported, and the screen can be used again", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
      expect(t.controller.state.phase).toBe("sending");
      await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS - 1);
      expect(t.controller.state.phase).toBe("sending");
      await vi.advanceTimersByTimeAsync(1);
      expect(t.pending[0].signal.aborted).toBe(true);
      expect(t.controller.state).toMatchObject({ phase: "idle", error: UPLOAD_TIMED_OUT });
      // a late answer to the timed-out upload changes nothing
      t.answer(0, "too late");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.controller.state).toMatchObject({ phase: "idle", result: null });
      // and a retry is a single new upload
      t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
      expect(t.transcribe).toHaveBeenCalledTimes(2);
      t.answer(1, "second try");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.controller.state).toMatchObject({ phase: "result", result: { transcript: "second try", provenance: "token-1" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answer in time clears the timer, so the limit never fires afterwards", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
      t.answer(0, "on time");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.controller.state.phase).toBe("result");
      await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS * 2);
      expect(t.controller.state).toMatchObject({ phase: "result", error: null });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmounting during an upload aborts it and stops its timer", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.controller.sendFile(new Blob([wavOf(1) as BlobPart]));
      const seen = t.states.length;
      t.controller.teardown();
      expect(t.pending[0].signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS);
      expect(t.states).toHaveLength(seen);
    } finally {
      vi.useRealTimers();
    }
  });
});
