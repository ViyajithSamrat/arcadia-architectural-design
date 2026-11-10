import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOwnedProject, readStoredBrief } from "@/lib/journeys/service";
import { planGnaniCall, refusalMessage, withUsage } from "@/lib/providers/budget";
import { getGnaniTtsReadiness, READBACK_LANGUAGE, type GnaniTtsReadiness } from "@/lib/providers/config";
import { createGnaniTtsProvider } from "@/lib/providers/gnani";
import type { TextToSpeechProvider } from "@/lib/providers/interfaces";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * Spoken read-back of the brief summary through Gnani text-to-speech (PR-009).
 *
 * What is spoken is ALWAYS the summary the server stored with the customer's own brief
 * (`customerReadbackText`). The browser sends no text and no language, so this cannot be used
 * as a free text-to-speech service, and nothing the customer did not write about their own
 * project can be spoken. The language is fixed to en-IN because the stored summary is English;
 * speaking English text with an Indian-language voice would mispronounce it. A spoken summary
 * in Tamil needs a Tamil summary text first, which this version does not produce.
 *
 * Order of checks, nothing after a failed one: the speech service is configured; the caller is
 * the project's owner (checked through the caller's own session, so row level security applies);
 * a brief exists; the customer consented to sending the text to a third party; the call fits the
 * spending limits and is reserved in the usage ledger. Only then is Gnani called, once, with no
 * retry. A failure is reported as a failure: nothing is faked and the text stays on screen.
 *
 * Audio is returned to the caller and never stored. Nothing here logs the text or the audio.
 */

type Client = SupabaseClient;

export type ReadbackErrorCode = "READBACK_UNAVAILABLE" | "NOT_FOUND" | "NO_BRIEF" | "CONSENT_REQUIRED" | "LIMIT" | "BUSY" | "PROVIDER_FAILED";

export type ReadbackResult =
  | { ok: true; audio: Uint8Array; mimeType: string; chars: number; shortened: boolean }
  | { ok: false; status: number; code: ReadbackErrorCode; message: string };

export const READBACK_UNAVAILABLE_MESSAGE = "Spoken read-back is not available right now. The summary stays on screen as text.";
const NOT_FOUND = "We could not find that project.";
const PROVIDER_FAILED = "The speech service could not read this summary aloud. The summary stays on screen as text.";

const fail = (status: number, code: ReadbackErrorCode, message: string): ReadbackResult => ({ ok: false, status, code, message });

/** The summary, tidied and cut to what the speech service may be sent, preferably at a sentence end. */
export function fitForSpeech(text: string, max: number): { text: string; shortened: boolean } {
  const tidy = text.replace(/\s+/g, " ").trim();
  if (tidy.length <= max) return { text: tidy, shortened: false };
  const head = tidy.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("।"));
  if (sentence >= Math.floor(max * 0.5)) return { text: head.slice(0, sentence + 1).trim(), shortened: true };
  const space = head.lastIndexOf(" ");
  return { text: (space >= Math.floor(max * 0.5) ? head.slice(0, space) : head).trim(), shortened: true };
}

/** True when the bytes really are audio of the declared kind. The declared type alone proves nothing. */
export function looksLikeAudio(bytes: Uint8Array, mime: string): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave") return bytes.length > 44 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  if (mime === "audio/ogg") return bytes.length > 27 && ascii(0, 4) === "OggS";
  if (mime === "audio/mpeg") return bytes.length > 4 && (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  return false;
}

export type ReadbackDeps = {
  readiness?: GnaniTtsReadiness;
  provider?: TextToSpeechProvider;
  service?: () => Client;
  newRequestId?: () => string;
};

export async function synthesizeReadback(supabase: Client, userId: string, input: { projectId: unknown; consent: unknown }, deps: ReadbackDeps = {}): Promise<ReadbackResult> {
  const readiness = deps.readiness ?? getGnaniTtsReadiness();
  if (!readiness.ready) return fail(503, "READBACK_UNAVAILABLE", READBACK_UNAVAILABLE_MESSAGE);
  const config = readiness.config;

  if (typeof input.projectId !== "string") return fail(404, "NOT_FOUND", NOT_FOUND);
  const project = await getOwnedProject(supabase, userId, input.projectId);
  if (!project) return fail(404, "NOT_FOUND", NOT_FOUND);
  const brief = readStoredBrief(project);
  if (!brief) return fail(409, "NO_BRIEF", "Create the brief first.");
  if (input.consent !== true) return fail(400, "CONSENT_REQUIRED", "Please agree to send this summary to the speech service before listening.");

  const source = brief.customerReadbackText.trim() || brief.englishBrief;
  const spoken = fitForSpeech(source, config.maxTtsChars);
  if (spoken.text.length === 0) return fail(409, "NO_BRIEF", "There is no summary to read aloud.");

  const planned = planGnaniCall("tts", spoken.text.length, config);
  if (!planned.ok) return fail(503, "READBACK_UNAVAILABLE", READBACK_UNAVAILABLE_MESSAGE);

  let service: Client;
  try {
    service = (deps.service ?? createSupabaseServiceClient)();
  } catch {
    return fail(503, "READBACK_UNAVAILABLE", READBACK_UNAVAILABLE_MESSAGE);
  }
  const provider = deps.provider ?? createGnaniTtsProvider(config);
  const requestId = (deps.newRequestId ?? randomUUID)();

  try {
    const guarded = await withUsage(service, { customerId: userId, projectId: project.id }, planned.plan, (hooks) =>
      provider.synthesize({ text: spoken.text, language: READBACK_LANGUAGE, requestId }, hooks),
    );
    if (!guarded.ok) {
      const status = guarded.reason === "unavailable" ? 503 : 429;
      return fail(status, guarded.reason === "busy" ? "BUSY" : guarded.reason === "unavailable" ? "READBACK_UNAVAILABLE" : "LIMIT", refusalMessage(guarded.reason));
    }
    const { audio, mimeType } = guarded.value;
    // The call was made and is counted either way; audio that is not audio is still a failure.
    if (!looksLikeAudio(audio, mimeType)) return fail(502, "PROVIDER_FAILED", PROVIDER_FAILED);
    return { ok: true, audio, mimeType, chars: spoken.text.length, shortened: spoken.shortened };
  } catch {
    // The provider's own error stays out of the response; the adapter logged its code only.
    return fail(502, "PROVIDER_FAILED", PROVIDER_FAILED);
  }
}
