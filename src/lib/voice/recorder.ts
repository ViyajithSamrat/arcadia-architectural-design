import { concatSamples, downsample, encodeWav, RECORDING_SAMPLE_RATE } from "./wav-encode";

/**
 * Microphone recording to 16 kHz mono 16-bit WAV, in the browser, with no dependency.
 *
 * It uses the Web Audio API: the microphone stream feeds a ScriptProcessorNode that copies the
 * raw float samples. ScriptProcessorNode is deprecated in favour of AudioWorklet but is still
 * supported by current browsers, and unlike AudioWorklet it needs no separate module file.
 * MediaRecorder is NOT used: browsers encode it as WebM/Opus or MP4, which the speech service
 * does not document and the server refuses.
 *
 * Browser APIs are passed in, so the controller can be tested without a browser. Every way
 * out (stop, auto-stop at the limit, cancel, dispose) releases the microphone tracks, the
 * audio nodes and the audio context.
 */

export type RecorderErrorCode = "unsupported" | "permission_denied" | "no_microphone" | "not_running" | "failed";

/** How long a suspended audio context gets to start running before recording is refused. */
export const RESUME_TIMEOUT_MS = 3000;

export class RecorderError extends Error {
  constructor(readonly code: RecorderErrorCode) {
    super(code);
    this.name = "RecorderError";
  }
}

type AudioNodeLike = { connect(destination: unknown): void; disconnect(): void };
type AudioEventLike = { inputBuffer: { getChannelData(channel: number): Float32Array } };
type ProcessorLike = AudioNodeLike & { onaudioprocess: ((event: AudioEventLike) => void) | null };
export type MediaStreamLike = { getTracks(): { stop(): void }[] };
export type AudioContextLike = {
  readonly sampleRate: number;
  readonly destination: unknown;
  /** "suspended", "running" or "closed". */
  readonly state: string;
  resume(): Promise<void>;
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike;
  createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number): ProcessorLike;
  close(): Promise<void>;
};

export type RecorderEnv = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
  createAudioContext?: () => AudioContextLike;
};

/** The real browser APIs, or nothing when they are missing (the recorder then reports "unsupported"). */
export function browserRecorderEnv(): RecorderEnv {
  if (typeof window === "undefined") return {};
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return {
    getUserMedia: media?.getUserMedia ? (c) => media.getUserMedia(c) : undefined,
    createAudioContext: Ctor ? () => new Ctor() as unknown as AudioContextLike : undefined,
  };
}

export type RecorderOptions = {
  maxSeconds: number;
  /** Seconds captured so far. */
  onProgress?: (seconds: number) => void;
  /** Called with the WAV when the limit stops the recording by itself. */
  onAutoStop?: (wav: Uint8Array) => void;
};

type Session = { stream: MediaStreamLike; ctx: AudioContextLike; source: AudioNodeLike; processor: ProcessorLike };

export class WavRecorder {
  private session: Session | null = null;
  private chunks: Float32Array[] = [];
  private captured = 0;
  /** Bumped by every start, cancel and dispose, so a late microphone grant is released at once. */
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly env: RecorderEnv,
    private readonly options: RecorderOptions,
  ) {}

  get recording(): boolean {
    return this.session !== null;
  }

  async start(): Promise<void> {
    if (this.disposed || this.session) return;
    const { getUserMedia, createAudioContext } = this.env;
    if (!getUserMedia || !createAudioContext) throw new RecorderError("unsupported");
    const generation = ++this.generation;

    let stream: MediaStreamLike;
    try {
      stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") throw new RecorderError("permission_denied");
      if (name === "NotFoundError" || name === "OverconstrainedError") throw new RecorderError("no_microphone");
      throw new RecorderError("failed");
    }
    // Cancelled or unmounted while the permission prompt was open: let go of the microphone.
    if (generation !== this.generation || this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    let ctx: AudioContextLike;
    try {
      ctx = createAudioContext();
    } catch {
      for (const track of stream.getTracks()) track.stop();
      throw new RecorderError("failed");
    }
    const letGo = () => {
      for (const track of stream.getTracks()) track.stop();
      ctx.close().catch(() => undefined);
    };

    // A context created after the permission prompt can start suspended (autoplay rules, notably
    // in Safari) and would then deliver no audio at all, so it is resumed and checked. resume()
    // may never settle while the browser blocks it, hence the time limit.
    if (ctx.state !== "running") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ctx.resume(), new Promise<void>((resolve) => (timer = setTimeout(resolve, RESUME_TIMEOUT_MS)))]);
      } catch {
        // judged by the state below
      } finally {
        clearTimeout(timer);
      }
    }
    if (generation !== this.generation || this.disposed) {
      letGo();
      return;
    }
    if (ctx.state !== "running") {
      letGo();
      throw new RecorderError("not_running");
    }

    try {
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const limit = Math.floor(this.options.maxSeconds * ctx.sampleRate);
      this.chunks = [];
      this.captured = 0;
      processor.onaudioprocess = (event) => {
        if (!this.session) return;
        const input = event.inputBuffer.getChannelData(0);
        const room = limit - this.captured;
        if (room <= 0) return;
        const piece = input.length > room ? input.slice(0, room) : new Float32Array(input);
        this.chunks.push(piece);
        this.captured += piece.length;
        this.options.onProgress?.(this.captured / this.session.ctx.sampleRate);
        if (this.captured >= limit) {
          const wav = this.stop();
          if (wav) this.options.onAutoStop?.(wav);
        }
      };
      source.connect(processor);
      processor.connect(ctx.destination); // a processor only runs while connected to an output
      this.session = { stream, ctx, source, processor };
    } catch {
      letGo();
      throw new RecorderError("failed");
    }
  }

  /** Ends the recording and returns it as WAV, or null when nothing was recording. */
  stop(): Uint8Array | null {
    const session = this.session;
    if (!session) return null;
    const rate = session.ctx.sampleRate;
    this.release();
    const samples = concatSamples(this.chunks);
    this.chunks = [];
    const outputRate = Math.min(RECORDING_SAMPLE_RATE, rate);
    const down = downsample(samples, rate, outputRate);
    // Never more than the limit at the output rate, so rounding cannot push it over.
    const capped = down.length > Math.floor(this.options.maxSeconds * outputRate) ? down.slice(0, Math.floor(this.options.maxSeconds * outputRate)) : down;
    return encodeWav(capped, outputRate);
  }

  /** Throws the recording away. */
  cancel(): void {
    this.generation++;
    this.release();
    this.chunks = [];
    this.captured = 0;
  }

  /** For unmount: like cancel, and the recorder cannot start again. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private release(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.processor.onaudioprocess = null;
    try {
      session.processor.disconnect();
      session.source.disconnect();
    } catch {
      // already disconnected
    }
    for (const track of session.stream.getTracks()) track.stop();
    session.ctx.close().catch(() => undefined);
  }
}
