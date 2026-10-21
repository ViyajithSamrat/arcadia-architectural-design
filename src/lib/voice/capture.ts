import { WAV_MIN_SECONDS } from "@/lib/providers/wav";
import { containsMockTranscript } from "@/lib/providers/mock-speech";
import type { TranscriptionOutcome } from "./client";
import { RecorderError, type RecorderErrorCode, type RecorderOptions } from "./recorder";
import { encodedSeconds } from "./wav-encode";

/**
 * The voice capture screen's operations, kept out of the component so every race can be tested
 * without a browser. Exactly one operation runs at a time: starting the microphone, recording,
 * or sending. Every operation gets a token; cancel, a new operation and teardown change it, and
 * anything that finishes with an old token (a late microphone grant, an auto-stop, an upload
 * answer) changes nothing. Each change of phase happens synchronously, before any await, so a
 * click that arrives before the screen re-renders sees the real phase.
 */

export type CapturePhase = "idle" | "starting" | "recording" | "sending" | "result";

export type CaptureResult = { transcript: string; mock: boolean; sourceLanguage: string | null; truncated: boolean; provenance: string | null };

export type CaptureState = { phase: CapturePhase; elapsed: number; error: string | null; result: CaptureResult | null };

/** The part of WavRecorder the controller uses. */
export type RecorderLike = { readonly recording: boolean; start(): Promise<void>; stop(): Uint8Array | null; cancel(): void; dispose(): void };

export type CaptureDeps = {
  maxSeconds: number;
  /** An upload still unanswered after this long is aborted and reported, so the screen never stays stuck. */
  uploadTimeoutMs: number;
  createRecorder: (options: RecorderOptions) => RecorderLike;
  /** Sends one recording; reads the current language and consent itself. */
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<TranscriptionOutcome>;
  onChange: (state: CaptureState) => void;
};

export const RECORDER_MESSAGES: Record<RecorderErrorCode, string> = {
  unsupported: "This browser cannot record audio here. Choose a WAV file instead, or type your description.",
  permission_denied: "Microphone access was blocked. Allow it in your browser settings, choose a WAV file, or type your description.",
  no_microphone: "No microphone was found. Choose a WAV file instead, or type your description.",
  not_running: "The browser did not start the microphone audio. Try again, choose a WAV file, or type your description.",
  failed: "Recording could not start. Try again, choose a WAV file, or type your description.",
};

export const NOTHING_RECORDED = "Nothing was recorded. Check your microphone and try again, choose a WAV file, or type your description.";
export const TOO_SHORT = "The recording is too short. Record at least half a second.";
export const UPLOAD_TIMED_OUT = "The recording took too long to process and was cancelled. Try again, or type your description.";
const SEND_FAILED = "The recording could not be sent. Check your connection and try again, or type your description.";

const BUSY: readonly CapturePhase[] = ["starting", "recording", "sending"];

export class VoiceCaptureController {
  private snapshot: CaptureState = { phase: "idle", elapsed: 0, error: null, result: null };
  private token = 0;
  private recorder: RecorderLike | null = null;
  private upload: AbortController | null = null;

  constructor(private readonly deps: CaptureDeps) {}

  get state(): CaptureState {
    return this.snapshot;
  }

  get busy(): boolean {
    return BUSY.includes(this.snapshot.phase);
  }

  async start(): Promise<void> {
    if (this.busy) return;
    const token = ++this.token;
    this.recorder?.dispose();
    const recorder = this.deps.createRecorder({
      maxSeconds: this.deps.maxSeconds,
      onProgress: (seconds) => {
        if (token === this.token) this.set({ elapsed: seconds });
      },
      onAutoStop: (wav) => {
        if (token === this.token) this.recorded(wav, token);
      },
    });
    this.recorder = recorder;
    this.set({ phase: "starting", elapsed: 0, error: null, result: null });
    try {
      await recorder.start();
    } catch (error) {
      if (token !== this.token) return;
      this.recorder = null;
      this.set({ phase: "idle", error: RECORDER_MESSAGES[error instanceof RecorderError ? error.code : "failed"] });
      return;
    }
    if (token !== this.token) {
      recorder.dispose(); // cancelled or torn down while the browser was asking
      return;
    }
    if (recorder.recording) this.set({ phase: "recording" });
    else this.set({ phase: "idle", error: RECORDER_MESSAGES.failed });
  }

  /** "Stop and send". Does nothing unless recording: an auto-stop may already have sent it. */
  stop(): void {
    if (this.snapshot.phase !== "recording") return;
    const wav = this.recorder?.stop() ?? null;
    if (wav) this.recorded(wav, this.token);
  }

  /** Throws away a recording that is starting or running. An upload is not cancelled here. */
  cancel(): void {
    if (this.snapshot.phase !== "starting" && this.snapshot.phase !== "recording") return;
    this.token++;
    this.recorder?.cancel();
    this.recorder = null;
    this.set({ phase: "idle", elapsed: 0 });
  }

  sendFile(file: Blob): void {
    if (this.busy) return;
    const token = ++this.token;
    this.set({ result: null });
    void this.send(file, token);
  }

  /** Unmount: stop the microphone and the upload. The controller can be used again (React may remount). */
  teardown(): void {
    this.token++;
    this.upload?.abort();
    this.upload = null;
    this.recorder?.dispose();
    this.recorder = null;
    this.snapshot = { phase: "idle", elapsed: 0, error: null, result: null };
  }

  private recorded(wav: Uint8Array, token: number): void {
    this.recorder = null;
    const seconds = encodedSeconds(wav);
    // Refused here, before any upload: an empty or tiny recording only produces a server refusal.
    if (seconds === 0) return this.set({ phase: "idle", error: NOTHING_RECORDED });
    if (seconds < WAV_MIN_SECONDS) return this.set({ phase: "idle", error: TOO_SHORT });
    void this.send(new Blob([wav as BlobPart], { type: "audio/wav" }), token);
  }

  private async send(audio: Blob, token: number): Promise<void> {
    const upload = new AbortController();
    this.upload = upload;
    this.set({ phase: "sending", error: null });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), this.deps.uploadTimeoutMs)));
    const answer = this.deps.transcribe(audio, upload.signal).catch((): TranscriptionOutcome => ({ ok: false, message: SEND_FAILED }));
    const outcome = await Promise.race([answer, timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") upload.abort(); // whatever comes back later is ignored
    if (token !== this.token) return; // replaced, cancelled or unmounted: an old answer changes nothing
    this.upload = null;
    if (outcome === "timeout") return this.set({ phase: "idle", error: UPLOAD_TIMED_OUT });
    if (!outcome.ok) return this.set({ phase: "idle", error: outcome.message });
    // A placeholder stays marked as mock even if the server forgot to say so.
    const mock = outcome.mock || containsMockTranscript(outcome.transcript);
    this.set({
      phase: "result",
      result: { transcript: outcome.transcript, mock, sourceLanguage: outcome.sourceLanguage, truncated: outcome.truncated, provenance: outcome.provenance },
    });
  }

  private set(patch: Partial<CaptureState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.deps.onChange(this.snapshot);
  }
}
