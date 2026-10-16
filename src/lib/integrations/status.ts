import { isSet } from "@/lib/env/schema";

/**
 * Integration status for optional services (Phase 1 foundation).
 *
 * Reports whether the needed variables are PRESENT. It never reads or returns
 * a value, and it never claims an integration works. A configured service is
 * "configured_unverified" until a later phase tests it with the real provider.
 */

export type IntegrationId = "supabase" | "openrouter" | "gnani" | "payment_display";

export type IntegrationState = "not_configured" | "partial" | "configured_unverified";

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
    label: "Gnani (speech-to-text and text-to-speech)",
    neededInPhase: 5,
    allOf: ["GNANI_API_KEY"],
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
      ? `Settings are present. This does not confirm the service works; it is tested in Phase ${def.neededInPhase}.`
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

/** Status of every optional integration. Safe to expose: names and states only. */
export function getIntegrationStatuses(raw: Record<string, string | undefined>): IntegrationStatus[] {
  return DEFINITIONS.map((def) => evaluate(def, raw));
}
