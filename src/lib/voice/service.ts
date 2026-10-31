import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EDITABLE_PROJECT_STATUSES } from "@/lib/db/schema";
import { getOwnedProject } from "@/lib/journeys/service";
import { DESCRIPTION_MAX_CHARS } from "@/lib/journeys/steps";
import { getVoiceMode, type VoiceMode } from "@/lib/journeys/voice";
import { planGnaniCall, refusalMessage, withUsage } from "@/lib/providers/budget";
import type { SpeechToTextProvider } from "@/lib/providers/interfaces";
import { createMockSpeechProvider } from "@/lib/providers/mock-speech";
import { parseWav, wavMaxBytes, wavRejectionMessage } from "@/lib/providers/wav";
import { signTranscriptToken, transcriptSigningKey, type TranscriptKey } from "./provenance";

/**
 * Turns one short recording into text for the owner's own project. Nothing is stored here:
 * not the audio, not the transcript. The customer reviews the text and saves it through the
 * normal step save, which has its own ownership checks.
 *
 * Checks, in order: (the route has authenticated the caller) the project belongs to the caller
 * and can still be edited, consent was given, voice is on and the language is offered, then
 * the actual WAV bytes and their server-measured duration. Only after all of that:
 *   - mock: the labelled mock provider; no network, no ledger, no credits;
 *   - live: a credit estimate from the measured duration, a reservation in the usage ledger,
 *     then exactly one provider call (no retry). A live failure is reported as a failure and
 *     never replaced by the mock.
 * The live branch runs only when the route supplies `live`, which it does only in a complete live
 * configuration (see LIVE_STT_WIRED in src/lib/journeys/voice.ts).
 *
 * Every transcript returned carries a provenance token signed over what was returned (see
 * provenance.ts); the description save trusts transcript metadata only with a valid token.
 * Without a key to sign with, nothing is transcribed.
 */

type Client = SupabaseClient;

export type VoiceErrorCode =
  | "VOICE_OFF"
  | "NO_SPEECH"
  | "VOICE_UNAVAILABLE"
  | "NOT_FOUND"
  | "NOT_EDITABLE"
  | "CONSENT_REQUIRED"
  | "BAD_LANGUAGE"
  | "BAD_AUDIO"
  | "LIMIT"
  | "BUSY"
  | "PROVIDER_FAILED";

export type TranscribeResult =
  | {
      ok: true;
      transcript: string;
      mock: boolean;
      language: string;
      sourceLanguage: string | null;
      seconds: number;
      truncated: boolean;
      /** Signed over the user, project, this exact transcript, its source and language. */
      provenance: string;
    }
  | { ok: false; status: number; code: VoiceErrorCode; message: string };

export type TranscribeInput = { projectId: unknown; language: unknown; consent: unknown; audio: unknown };

export type LiveSpeechDeps = { provider: SpeechToTextProvider; service: Client };

export type TranscribeDeps = {
  mode?: VoiceMode;
  mockProvider?: SpeechToTextProvider;
  /** Live provider and trusted client for the ledger. Supplied by the route in live mode only. */
  live?: LiveSpeechDeps;
  newRequestId?: () => string;
  /** The provenance signing key; by default VOICE_TRANSCRIPT_SECRET, or a process key for the mock. */
  signingKey?: TranscriptKey | null;
  now?: () => number;
};

const fail = (status: number, code: VoiceErrorCode, message: string): TranscribeResult => ({ ok: false, status, code, message });

export const VOICE_OFF_MESSAGE = "Voice input is not switched on. You can type your description instead.";
export const VOICE_UNAVAILABLE_MESSAGE = "Voice input is unavailable right now. You can type your description instead.";
const NOT_FOUND = "We could not find that project.";
const PROVIDER_FAILED = "The speech service could not turn this recording into text. You can try again later, or type your description.";

export async function transcribeForProject(supabase: Client, userId: string, input: TranscribeInput, deps: TranscribeDeps = {}): Promise<TranscribeResult> {
  const mode = deps.mode ?? getVoiceMode();
  if (mode.kind === "off") return fail(404, "VOICE_OFF", VOICE_OFF_MESSAGE);
  if (mode.kind !== "mock" && mode.kind !== "live") return fail(503, "VOICE_UNAVAILABLE", VOICE_UNAVAILABLE_MESSAGE);
  const source = mode.kind === "mock" ? "mock" : "gnani";
  const key = deps.signingKey !== undefined ? deps.signingKey : transcriptSigningKey(source);
  // A transcript that cannot be signed could never be saved as one: refuse before any work.
  if (!key || (key.mockOnly && source !== "mock")) return fail(503, "VOICE_UNAVAILABLE", VOICE_UNAVAILABLE_MESSAGE);

  if (typeof input.projectId !== "string") return fail(404, "NOT_FOUND", NOT_FOUND);
  const project = await getOwnedProject(supabase, userId, input.projectId);
  if (!project) return fail(404, "NOT_FOUND", NOT_FOUND);
  if (!EDITABLE_PROJECT_STATUSES.includes(project.status)) return fail(409, "NOT_EDITABLE", "This project can no longer be edited.");

  if (input.consent !== true) return fail(400, "CONSENT_REQUIRED", "Please agree to the recording notice before sending audio.");

  const option = typeof input.language === "string" ? mode.languages.find((l) => l.value === input.language) : undefined;
  if (!option) return fail(400, "BAD_LANGUAGE", "Choose one of the offered languages.");

  // The declared type and file name are ignored: only the bytes are checked.
  if (!(input.audio instanceof Blob)) return fail(422, "BAD_AUDIO", "Record your description or choose a WAV file.");
  if (input.audio.size > wavMaxBytes(mode.maxSeconds)) return fail(422, "BAD_AUDIO", wavRejectionMessage("too_large", mode.maxSeconds));
  const bytes = new Uint8Array(await input.audio.arrayBuffer());
  const checked = parseWav(bytes, { maxSeconds: mode.maxSeconds });
  if (!checked.ok) return fail(422, "BAD_AUDIO", wavRejectionMessage(checked.reason, mode.maxSeconds));
  const seconds = checked.wav.seconds;
  const requestId = (deps.newRequestId ?? randomUUID)();

  const done = (text: string, mock: boolean): TranscribeResult => {
    const trimmed = text.trim();
    const truncated = trimmed.length > DESCRIPTION_MAX_CHARS;
    // Trimmed again after cutting, so the signed text is exactly what the save path receives.
    const transcript = truncated ? trimmed.slice(0, DESCRIPTION_MAX_CHARS).trimEnd() : trimmed;
    const provenance = signTranscriptToken(
      { userId, projectId: project.id, transcript, source: mock ? "mock" : "gnani", sourceLanguage: option.sourceLanguage },
      key,
      (deps.now ?? Date.now)(),
    );
    return {
      ok: true,
      transcript,
      mock,
      language: option.value,
      sourceLanguage: option.sourceLanguage,
      seconds: Math.round(seconds * 10) / 10,
      truncated,
      provenance,
    };
  };

  if (mode.kind === "mock") {
    const provider = deps.mockProvider ?? createMockSpeechProvider();
    const out = await provider.transcribe({ audio: bytes, mimeType: "audio/wav", language: option.sourceLanguage ?? option.value, requestId });
    return done(out.transcript, true);
  }

  // Live. Reached only when the route supplied the provider and the ledger client.
  if (!deps.live || option.sourceLanguage === null) return fail(503, "VOICE_UNAVAILABLE", VOICE_UNAVAILABLE_MESSAGE);
  const planned = planGnaniCall("stt", seconds, mode.config);
  if (!planned.ok) {
    return planned.reason === "per_request"
      ? fail(422, "LIMIT", "This recording is too long to process. Try a shorter one.")
      : fail(503, "VOICE_UNAVAILABLE", VOICE_UNAVAILABLE_MESSAGE);
  }
  const { provider, service } = deps.live;
  const language = option.sourceLanguage;
  try {
    const guarded = await withUsage(service, { customerId: userId, projectId: project.id }, planned.plan, (hooks) =>
      provider.transcribe({ audio: bytes, mimeType: "audio/wav", language, requestId }, hooks),
    );
    if (!guarded.ok) {
      const status = guarded.reason === "unavailable" ? 503 : 429;
      return fail(status, guarded.reason === "busy" ? "BUSY" : guarded.reason === "unavailable" ? "VOICE_UNAVAILABLE" : "LIMIT", refusalMessage(guarded.reason));
    }
    // A silent or unintelligible recording comes back empty. That is not a result: saying "done"
    // would hand the customer a signed empty transcript.
    if (guarded.value.transcript.trim().length === 0) return fail(422, "NO_SPEECH", "We could not hear any words in that recording. Try again closer to the microphone, or type your description.");
    return done(guarded.value.transcript, false);
  } catch {
    // The provider's own error stays out of the response; the adapter logged its code only.
    return fail(502, "PROVIDER_FAILED", PROVIDER_FAILED);
  }
}
