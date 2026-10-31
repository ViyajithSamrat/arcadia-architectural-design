/**
 * One structured line per provider call. The type has no field for a prompt, a
 * transcript, audio, a customer's words or a key, so none can be logged by accident.
 */
export type ProviderLogEvent = {
  provider: "openrouter" | "gnani";
  /** "translate" is logged on its own here, but metered as a "brief" request (openrouter-translate.ts). */
  operation: "brief" | "image" | "stt" | "tts" | "translate";
  model?: string | null;
  requestId?: string | null;
  status: "ok" | "error" | "refused";
  /** A short machine code such as "rate_limited" or "customer_limit". */
  reason?: string;
  /** The provider's HTTP status code on a failed call (a number, never a body). */
  httpStatus?: number;
  durationMs?: number;
  units?: number | null;
  /** Cost in US dollars as the provider reported it, when it did. */
  costUsd?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
};

export function logProviderCall(event: ProviderLogEvent, now: () => Date = () => new Date()): void {
  const line = { event: "provider_call", at: now().toISOString(), ...event };
  console.info(JSON.stringify(line));
}
