import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EDITABLE_PROJECT_STATUSES } from "@/lib/db/schema";
import { getOwnedProject } from "@/lib/journeys/service";
import { DESCRIPTION_MAX_CHARS } from "@/lib/journeys/steps";
import { refusalMessage, withUsage } from "@/lib/providers/budget";
import { ProviderError } from "@/lib/providers/interfaces";
import { containsMockTranscript } from "@/lib/providers/mock-speech";
import { createOpenRouterTranslator, numbersToCheck, type Translator } from "@/lib/providers/openrouter-translate";
import { TRANSCRIPT_TOKEN_MAX_CHARS, transcriptVerificationKeys, verifyTranscriptToken, type TranscriptClaims } from "@/lib/voice/provenance";
import { getTranslationMode, isEnglishLanguage, type TranslationMode } from "./mode";

/**
 * Translates the customer's own reviewed transcript into English for their own project.
 * Nothing is stored here: the English text is returned as a suggestion, and becomes the
 * description only when the customer chooses to use it and saves the step (which re-verifies
 * the original transcript's provenance and stores the original unchanged).
 *
 * Checks, in order: (the route has authenticated the caller) translation is on, the project
 * belongs to the caller and can still be edited, the request carries a genuine, unexpired
 * provenance token for a LIVE speech-service transcript of this user and project in a
 * non-English language, and the text to translate is non-empty, bounded and not the mock
 * placeholder. Only then: a usage reservation and exactly one provider call (no retry).
 * A failure is reported as a failure; there is no mock translation.
 */

type Client = SupabaseClient;

export type TranslateErrorCode = "TRANSLATION_OFF" | "TRANSLATION_UNAVAILABLE" | "NOT_FOUND" | "NOT_EDITABLE" | "BAD_REQUEST" | "NOT_NEEDED" | "LIMIT" | "BUSY" | "PROVIDER_FAILED";

export type TranslateResult =
  | { ok: true; english: string; sourceLanguage: string; numbersToCheck: string[]; model: string }
  | { ok: false; status: number; code: TranslateErrorCode; message: string };

export type TranslateInput = { projectId: unknown; text: unknown; original: unknown; provenance: unknown };

export type TranslateDeps = {
  mode?: TranslationMode;
  translator?: Translator;
  /** Trusted client for the usage ledger. */
  service: Client;
  verifyTranscript?: (token: string, expected: { userId: string; projectId: string; transcript: string }) => TranscriptClaims | null;
};

const fail = (status: number, code: TranslateErrorCode, message: string): TranslateResult => ({ ok: false, status, code, message });

export const TRANSLATION_OFF_MESSAGE = "Automatic translation is not switched on. Type the English version yourself below.";
export const TRANSLATION_UNAVAILABLE_MESSAGE = "Automatic translation is unavailable right now. Type the English version yourself below.";
const PROVIDER_FAILED = "The translation did not work this time. You can try again, or type the English version yourself.";
const BAD = "That request was not valid.";

export async function translateForProject(supabase: Client, userId: string, input: TranslateInput, deps: TranslateDeps): Promise<TranslateResult> {
  const mode = deps.mode ?? getTranslationMode();
  if (mode.kind === "off") return fail(404, "TRANSLATION_OFF", TRANSLATION_OFF_MESSAGE);
  if (mode.kind !== "live") return fail(503, "TRANSLATION_UNAVAILABLE", TRANSLATION_UNAVAILABLE_MESSAGE);

  if (typeof input.projectId !== "string") return fail(404, "NOT_FOUND", "We could not find that project.");
  const project = await getOwnedProject(supabase, userId, input.projectId);
  if (!project) return fail(404, "NOT_FOUND", "We could not find that project.");
  if (!EDITABLE_PROJECT_STATUSES.includes(project.status)) return fail(409, "NOT_EDITABLE", "This project can no longer be edited.");

  if (typeof input.original !== "string" || input.original.length === 0 || input.original.length > DESCRIPTION_MAX_CHARS) return fail(400, "BAD_REQUEST", BAD);
  if (typeof input.provenance !== "string" || input.provenance.length === 0 || input.provenance.length > TRANSCRIPT_TOKEN_MAX_CHARS) return fail(400, "BAD_REQUEST", BAD);
  const verify = deps.verifyTranscript ?? ((token, expected) => verifyTranscriptToken(token, expected, transcriptVerificationKeys()));
  const claims = verify(input.provenance, { userId, projectId: project.id, transcript: input.original });
  // Only a real speech-service transcript of this user and project may be sent for translation.
  if (!claims || claims.source !== "gnani" || claims.sourceLanguage === null) return fail(400, "BAD_REQUEST", BAD);
  if (isEnglishLanguage(claims.sourceLanguage)) return fail(400, "NOT_NEEDED", "This transcript is already in English.");

  // The customer may have corrected the transcript first; that reviewed text is what is translated.
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length === 0 || text.length > DESCRIPTION_MAX_CHARS) return fail(400, "BAD_REQUEST", "There is no transcript text to translate.");
  if (containsMockTranscript(text)) return fail(400, "BAD_REQUEST", BAD);

  const translator = deps.translator ?? createOpenRouterTranslator(mode.config);
  const sourceLanguage = claims.sourceLanguage;
  try {
    const guarded = await withUsage(deps.service, { customerId: userId, projectId: project.id }, translator.usage, (hooks) =>
      translator.translate({ text, sourceLanguage, maxChars: DESCRIPTION_MAX_CHARS }, hooks),
    );
    if (!guarded.ok) {
      if (guarded.reason === "unavailable") return fail(503, "TRANSLATION_UNAVAILABLE", TRANSLATION_UNAVAILABLE_MESSAGE);
      return fail(429, guarded.reason === "busy" ? "BUSY" : "LIMIT", refusalMessage(guarded.reason));
    }
    const english = guarded.value.english;
    return { ok: true, english, sourceLanguage, numbersToCheck: numbersToCheck(text, english), model: guarded.value.model };
  } catch (error) {
    // The provider's own error stays out of the response; the adapter logged its code only.
    if (error instanceof ProviderError && (error.code === "auth" || error.code === "rate_limited")) {
      return fail(503, "TRANSLATION_UNAVAILABLE", TRANSLATION_UNAVAILABLE_MESSAGE);
    }
    return fail(502, "PROVIDER_FAILED", PROVIDER_FAILED);
  }
}
