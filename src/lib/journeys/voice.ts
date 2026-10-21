import { isSet } from "@/lib/env/schema";
import { configuredGnaniLanguages, getGnaniSttReadiness, getProviderTimeoutMs, gnaniSttMaxSeconds, type GnaniSttConfig } from "@/lib/providers/config";
import { TRANSCRIPT_SECRET_ENV, TRANSCRIPT_SECRET_MIN_CHARS, transcriptSecretConfigured } from "@/lib/voice/provenance";

/**
 * Voice input mode, decided only by GNANI_VOICE_ENABLED and independent of PROVIDER_MODE (which
 * keeps deciding the brief writer):
 *   unset or empty  off: typing only
 *   "mock"          the labelled MOCK transcriber (no network, no credits)
 *   "true"          live Gnani speech-to-text, only when every STT setting and the
 *                   transcript signing secret are present; otherwise unavailable, never the mock
 *   anything else   invalid: unavailable (fail closed)
 */

/**
 * R1-A: no live speech call is wired anywhere. Even a complete live configuration reports
 * "unavailable" until this is changed, which needs the owner's approval of the live smoke
 * test (R1-C) after the account's endpoint, authentication and billing are confirmed.
 */
export const LIVE_STT_WIRED: boolean = false;

/** A demo-only selection for Tamil-English code-mixed speech. It has NO provider language code. */
export const TANGLISH_DEMO = "tanglish-demo";

/** Used in mock mode when GNANI_LANGUAGES lists nothing: the planned Tamil demo. */
export const MOCK_DEFAULT_LANGUAGES = ["ta-IN", "en-IN"] as const;

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  "bn-IN": "Bengali",
  "en-IN": "English (India)",
  "gu-IN": "Gujarati",
  "hi-IN": "Hindi",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "mr-IN": "Marathi",
  "pa-IN": "Punjabi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
};

export type VoiceLanguageOption = {
  /** What the form sends. */
  value: string;
  label: string;
  /** The code a speech service would receive and the project's source_language; null for a demo-only selection. */
  sourceLanguage: string | null;
  demoOnly: boolean;
};

const codeOption = (code: string): VoiceLanguageOption => ({ value: code, label: LANGUAGE_LABELS[code] ?? code, sourceLanguage: code, demoOnly: false });

const TANGLISH_OPTION: VoiceLanguageOption = {
  value: TANGLISH_DEMO,
  label: "Tanglish (Tamil–English mix): demo selection, not a confirmed speech-service language",
  sourceLanguage: null,
  demoOnly: true,
};

export type VoiceMode =
  | { kind: "off" }
  | { kind: "invalid" }
  | { kind: "mock"; languages: VoiceLanguageOption[]; maxSeconds: number }
  | { kind: "live"; config: GnaniSttConfig; languages: VoiceLanguageOption[]; maxSeconds: number }
  | { kind: "live_unavailable"; missing: string[] };

export function getVoiceMode(env: Record<string, string | undefined> = process.env): VoiceMode {
  const raw = isSet(env, "GNANI_VOICE_ENABLED") ? String(env.GNANI_VOICE_ENABLED).trim().toLowerCase() : "";
  if (raw === "") return { kind: "off" };
  if (raw === "mock") {
    const configured = configuredGnaniLanguages(env);
    const codes = configured.length > 0 ? configured : [...MOCK_DEFAULT_LANGUAGES];
    return { kind: "mock", languages: [...codes.map(codeOption), TANGLISH_OPTION], maxSeconds: gnaniSttMaxSeconds(env) };
  }
  if (raw === "true") {
    const readiness = getGnaniSttReadiness(env);
    // A live transcript must be signed with the configured secret (see provenance.ts).
    const missing = [
      ...(readiness.ready ? [] : readiness.missing),
      ...(transcriptSecretConfigured(env) ? [] : [`${TRANSCRIPT_SECRET_ENV} (at least ${TRANSCRIPT_SECRET_MIN_CHARS} characters)`]),
    ];
    if (!readiness.ready || missing.length > 0) return { kind: "live_unavailable", missing };
    // Live offers only documented, configured codes: no demo-only selection.
    return { kind: "live", config: readiness.config, languages: readiness.config.languages.map(codeOption), maxSeconds: readiness.config.maxSttSeconds };
  }
  return { kind: "invalid" };
}

/**
 * True only when transcripts can come from a live speech service. Until then (all of R1-A) a
 * transcript is the labelled mock, which says nothing about the language spoken, so it must
 * never set the project's language.
 */
export function isLiveTranscriptionWired(env: Record<string, string | undefined> = process.env): boolean {
  return LIVE_STT_WIRED && getVoiceMode(env).kind === "live";
}

/** Added to the provider timeout to give the browser's upload time limit. */
export const UPLOAD_TIMEOUT_MARGIN_MS = 15_000;

/** What the screen may know. No setting names, values or keys. */
export type VoiceView =
  | { state: "off" }
  | { state: "unavailable" }
  | { state: "mock" | "live"; languages: VoiceLanguageOption[]; maxSeconds: number; uploadTimeoutMs: number };

export function getVoiceView(env: Record<string, string | undefined> = process.env): VoiceView {
  const mode = getVoiceMode(env);
  switch (mode.kind) {
    case "off":
      return { state: "off" };
    case "mock":
      return { state: "mock", languages: mode.languages, maxSeconds: mode.maxSeconds, uploadTimeoutMs: getProviderTimeoutMs(env) + UPLOAD_TIMEOUT_MARGIN_MS };
    case "live":
      return LIVE_STT_WIRED
        ? { state: "live", languages: mode.languages, maxSeconds: mode.maxSeconds, uploadTimeoutMs: getProviderTimeoutMs(env) + UPLOAD_TIMEOUT_MARGIN_MS }
        : { state: "unavailable" };
    default:
      return { state: "unavailable" };
  }
}
