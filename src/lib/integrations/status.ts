import { isSet } from "@/lib/env/schema";
import { getVoiceMode, LIVE_STT_WIRED } from "@/lib/journeys/voice";
import { getGnaniTtsReadiness } from "@/lib/providers/config";

/**
 * Integration status for optional services (Phase 1 foundation).
 *
 * Reports whether the needed variables are PRESENT. It never reads or returns
 * a value, and it never claims an integration works. A configured service is
 * "configured_unverified" until a later phase tests it with the real provider.
 */

export type IntegrationId = "supabase" | "openrouter" | "gnani" | "voice_input" | "readback_audio" | "payment_display";

/**
 * "mock_only": a labelled mock answers instead of the real service.
 * "live_blocked": the live settings are complete but the live path is switched off in code.
 */
export type IntegrationState = "not_configured" | "partial" | "configured_unverified" | "mock_only" | "live_blocked";

export type IntegrationStatus = {
  id: IntegrationId;
  label: string;
  /** The phase that first needs this integration. */
  neededInPhase: number;
  state: IntegrationState;
  /** Variable NAMES still missing. Never values. */
  missing: string[];
  /** Plain-language, actionable message safe to show to anyone. */
  message: string;
};

type Definition = {
  id: IntegrationId;
  label: string;
  neededInPhase: number;
  /** Every variable listed here must be set. */
  allOf: string[];
  /** At least one variable listed here must be set (when the list is non-empty). */
  anyOf?: string[];
  /** Appended to the message when the settings are present. */
  note?: string;
};

const DEFINITIONS: Definition[] = [
  {
    id: "supabase",
    label: "Supabase (database, sign-in, private storage)",
    neededInPhase: 2,
    allOf: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (text and image models)",
    neededInPhase: 5,
    allOf: ["OPENROUTER_API_KEY", "OPENROUTER_TEXT_MODEL"],
  },
  {
    id: "gnani",
    label: "Gnani account settings (speech-to-text and text-to-speech)",
    neededInPhase: 5,
    allOf: ["GNANI_API_KEY"],
    note: "A key alone does not switch voice input on: see Voice input.",
  },
  {
    id: "payment_display",
    label: "Manual payment instructions (display only)",
    neededInPhase: 4,
    allOf: [],
    anyOf: ["PAYMENT_UPI_ID", "PAYMENT_INSTRUCTIONS"],
  },
];

function evaluate(def: Definition, raw: Record<string, string | undefined>): IntegrationStatus {
  const missingAll = def.allOf.filter((name) => !isSet(raw, name));
  const anyOfSatisfied = !def.anyOf || def.anyOf.some((name) => isSet(raw, name));
  const missing = [...missingAll, ...(anyOfSatisfied ? [] : [`one of: ${def.anyOf?.join(" / ")}`])];

  const requiredCount = def.allOf.length + (def.anyOf ? 1 : 0);
  const satisfiedCount = requiredCount - missing.length;

  let state: IntegrationState;
  if (missing.length === 0) state = "configured_unverified";
  else if (satisfiedCount === 0) state = "not_configured";
  else state = "partial";

  const message =
    state === "configured_unverified"
      ? `Settings are present. This does not confirm the service works; it is tested in Phase ${def.neededInPhase}.${def.note ? ` ${def.note}` : ""}`
      : state === "partial"
        ? `Partly configured. Still missing: ${missing.join(", ")}.`
        : `Not configured. Needed from Phase ${def.neededInPhase}. The app runs without it and related features stay off.`;

  return {
    id: def.id,
    label: def.label,
    neededInPhase: def.neededInPhase,
    state,
    missing,
    message,
  };
}

const VOICE_LABEL = "Voice input (speech-to-text)";

/**
 * Voice input as the transcribe route will actually behave, from the same voice mode and live
 * gate the route uses. Names of missing settings only; never a value.
 */
export function getVoiceInputStatus(raw: Record<string, string | undefined>): IntegrationStatus {
  const base = { id: "voice_input" as const, label: VOICE_LABEL, neededInPhase: 5 };
  const mode = getVoiceMode(raw);
  switch (mode.kind) {
    case "off":
      return { ...base, state: "not_configured", missing: ["GNANI_VOICE_ENABLED"], message: "Not configured. Voice input is off, so descriptions are typed." };
    case "invalid":
      return { ...base, state: "partial", missing: ["GNANI_VOICE_ENABLED (empty, false, mock or true)"], message: "GNANI_VOICE_ENABLED has a value that is not recognised, so voice input is unavailable." };
    case "mock":
      return {
        ...base,
        state: "mock_only",
        missing: [],
        message: "Mock only. Recordings are answered by a labelled MOCK transcriber: nothing is transcribed and no speech service is called.",
      };
    case "live_unavailable":
      return { ...base, state: "partial", missing: mode.missing, message: `Live speech-to-text was requested but is unavailable. Still missing: ${mode.missing.join(", ")}.` };
    case "live":
      return LIVE_STT_WIRED
        ? {
            ...base,
            state: "configured_unverified",
            missing: [],
            message: "Live speech-to-text is switched on. This does not confirm the service works; it has not been verified against Gnani.",
          }
        : {
            ...base,
            state: "live_blocked",
            missing: [],
            message: "Live settings are present, but live speech-to-text is switched off in this version of the code, so voice input is unavailable.",
          };
  }
}

const READBACK_LABEL = "Spoken read-back (text-to-speech)";

/**
 * Spoken read-back as the read-back route will actually behave. Names of missing settings only;
 * never a value. "configured_unverified" means the settings are complete, not that Gnani answered.
 */
export function getReadbackStatus(raw: Record<string, string | undefined>): IntegrationStatus {
  const base = { id: "readback_audio" as const, label: READBACK_LABEL, neededInPhase: 5 };
  const readiness = getGnaniTtsReadiness(raw);
  if (readiness.ready) {
    return { ...base, state: "configured_unverified", missing: [], message: "Spoken read-back is switched on (English only). This does not confirm the service works; it has not been verified against Gnani." };
  }
  const switchedOn = isSet(raw, "GNANI_VOICE_ENABLED") && String(raw.GNANI_VOICE_ENABLED).trim().toLowerCase() === "true";
  if (!switchedOn) {
    return { ...base, state: "not_configured", missing: ["GNANI_VOICE_ENABLED=true"], message: "Not configured. The brief summary is shown as text." };
  }
  return { ...base, state: "partial", missing: readiness.missing, message: `Spoken read-back was requested but is unavailable. Still missing: ${readiness.missing.join(", ")}.` };
}

/** Status of every optional integration. Safe to expose: names and states only. */
export function getIntegrationStatuses(raw: Record<string, string | undefined>): IntegrationStatus[] {
  const statuses = DEFINITIONS.map((def) => evaluate(def, raw));
  const gnani = statuses.findIndex((s) => s.id === "gnani");
  statuses.splice(gnani + 1, 0, getVoiceInputStatus(raw), getReadbackStatus(raw));
  return statuses;
}
