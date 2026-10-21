import { z } from "zod";
import type { GnaniConfig } from "./config";
import { ProviderError, type ProviderHooks, type SpeechToTextProvider, type TextToSpeechProvider } from "./interfaces";
import { logProviderCall } from "./log";

/**
 * Gnani speech adapters, written from docs.gnani.ai (REST) and NOT verified against a live
 * account: no call to Gnani has been made from this code base. Rules that follow from the
 * owner's budget:
 *   - exactly one request per call: NO retries, and callers run one at a time (the budget
 *     guard caps calls in flight);
 *   - the request is made only after the budget guard has reserved credits;
 *   - nothing is logged except provider, operation, model, request id and status.
 *
 * Documented request shapes (docs.gnani.ai, read 2026-10-18):
 *   STT  POST {base}{sttPath}  multipart: audio_file, language_code;  header X-API-Key-ID
 *        200 JSON { success, transcript, request_id? }
 *   TTS  POST {base}{ttsPath}  JSON: { text, model, voice, language, speed, audio_config };
 *        header X-API-Key-ID;  200 raw audio bytes
 */

export const STT_AUDIO_TYPES: Readonly<Record<string, string>> = {
  "audio/wav": "audio.wav",
  "audio/x-wav": "audio.wav",
  "audio/mpeg": "audio.mp3",
  "audio/ogg": "audio.ogg",
  "audio/flac": "audio.flac",
  "audio/aac": "audio.aac",
  "audio/mp4": "audio.m4a",
};

/** Upper bound on audio accepted for one request; a 30 s mono 16 kHz WAV is about 1 MB. */
export const STT_MAX_BYTES = 4 * 1024 * 1024;
const TTS_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_MAX_CHARS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SttResponseSchema = z.object({
  success: z.literal(true),
  transcript: z.string(),
  request_id: z.string().max(200).optional(),
});

function statusError(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("auth", "provider refused the credentials or credits", status);
  if (status === 429) return new ProviderError("rate_limited", "provider rate limit", status);
  if (status >= 500) return new ProviderError("server", "provider server error", status);
  return new ProviderError("bad_request", "provider rejected the request", status);
}

async function send(doFetch: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new ProviderError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "server", "request did not complete");
  }
  if (!response.ok) throw statusError(response.status);
  return response;
}

export function createGnaniSttProvider(
  config: Pick<GnaniConfig, "apiKey" | "baseUrl" | "sttPath" | "timeoutMs" | "languages">,
  deps: { fetch?: typeof fetch } = {},
): SpeechToTextProvider {
  const doFetch = deps.fetch ?? fetch;
  return {
    id: "gnani",
    async transcribe(input, hooks?: ProviderHooks) {
      // Everything below is checked BEFORE a request is made.
      const refuse = (message: string) => {
        hooks?.onNotSent?.();
        return new ProviderError("unsupported_input", message);
      };
      if (!config.languages.includes(input.language)) throw refuse("language is not offered");
      const fileName = STT_AUDIO_TYPES[input.mimeType];
      if (!fileName) throw refuse("audio format is not supported");
      if (input.audio.byteLength === 0 || input.audio.byteLength > STT_MAX_BYTES) throw refuse("audio size is not allowed");

      const form = new FormData();
      form.append("audio_file", new Blob([input.audio as BlobPart], { type: input.mimeType }), fileName);
      form.append("language_code", input.language);
      const headers: Record<string, string> = { "X-API-Key-ID": config.apiKey };
      if (UUID.test(input.requestId)) headers["X-API-Request-ID"] = input.requestId;

      const started = Date.now();
      try {
        hooks?.onSent?.();
        const response = await send(doFetch, `${config.baseUrl}${config.sttPath}`, { method: "POST", headers, body: form }, config.timeoutMs);
        let parsed: z.infer<typeof SttResponseSchema>;
        try {
          const result = SttResponseSchema.safeParse(await response.json());
          if (!result.success) throw new Error("shape");
          parsed = result.data;
        } catch {
          throw new ProviderError("bad_response", "response was not the expected shape");
        }
        const transcript = parsed.transcript.trim();
        if (transcript.length > TRANSCRIPT_MAX_CHARS) throw new ProviderError("bad_response", "transcript too long");
        // Gnani reports no usage, so none is passed on: the guard keeps its own estimate.
        hooks?.onUsage?.({ requestId: parsed.request_id ?? null, model: null, units: null });
        logProviderCall({ provider: "gnani", operation: "stt", requestId: parsed.request_id ?? null, status: "ok", durationMs: Date.now() - started });
        return { transcript, provider: "gnani", requestId: parsed.request_id };
      } catch (error) {
        if (error instanceof ProviderError) {
          logProviderCall({ provider: "gnani", operation: "stt", status: "error", reason: error.code, durationMs: Date.now() - started });
        }
        throw error;
      }
    },
  };
}

export function createGnaniTtsProvider(config: GnaniConfig, deps: { fetch?: typeof fetch } = {}): TextToSpeechProvider {
  const doFetch = deps.fetch ?? fetch;
  return {
    id: "gnani",
    async synthesize(input, hooks?: ProviderHooks) {
      const refuse = (message: string) => {
        hooks?.onNotSent?.();
        return new ProviderError("unsupported_input", message);
      };
      if (!config.languages.includes(input.language)) throw refuse("language is not offered");
      const text = input.text.trim();
      if (text.length === 0 || text.length > config.maxTtsChars) throw refuse("text length is not allowed");

      const headers: Record<string, string> = { "X-API-Key-ID": config.apiKey, "Content-Type": "application/json" };
      if (UUID.test(input.requestId)) headers["X-API-Request-ID"] = input.requestId;
      const body = JSON.stringify({
        text,
        model: config.ttsModel,
        voice: config.ttsVoice,
        language: input.language,
        speed: 1.0,
        audio_config: { sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: "linear_pcm", container: "wav" },
      });

      const started = Date.now();
      try {
        hooks?.onSent?.();
        const response = await send(doFetch, `${config.baseUrl}${config.ttsPath}`, { method: "POST", headers, body }, config.timeoutMs);
        const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!mimeType.startsWith("audio/")) throw new ProviderError("bad_response", "response was not audio");
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > TTS_MAX_AUDIO_BYTES) throw new ProviderError("bad_response", "audio too large");
        const audio = new Uint8Array(await response.arrayBuffer());
        if (audio.byteLength === 0 || audio.byteLength > TTS_MAX_AUDIO_BYTES) throw new ProviderError("bad_response", "audio size is not allowed");
        hooks?.onUsage?.({ requestId: null, model: config.ttsModel, units: null });
        logProviderCall({ provider: "gnani", operation: "tts", model: config.ttsModel, status: "ok", durationMs: Date.now() - started });
        return { audio, mimeType, provider: "gnani", model: config.ttsModel };
      } catch (error) {
        if (error instanceof ProviderError) {
          logProviderCall({ provider: "gnani", operation: "tts", model: config.ttsModel, status: "error", reason: error.code, durationMs: Date.now() - started });
        }
        throw error;
      }
    },
  };
}
