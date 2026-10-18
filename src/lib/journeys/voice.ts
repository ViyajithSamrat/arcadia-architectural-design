import { getIntegrationStatuses } from "@/lib/integrations/status";

export type VoiceState = "not_configured" | "configured_not_enabled";

/**
 * Voice input is not built in this phase, whatever the settings say. This only chooses
 * the wording of the notice: it never reports voice as working.
 */
export function getVoiceState(env: Record<string, string | undefined> = process.env): VoiceState {
  const gnani = getIntegrationStatuses(env).find((s) => s.id === "gnani");
  return gnani?.state === "configured_unverified" ? "configured_not_enabled" : "not_configured";
}
