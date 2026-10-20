/**
 * One structured line per provider call. The type has no field for a prompt, a
 * transcript, audio, a customer's words or a key, so none can be logged by accident.
 */
export type ProviderLogEvent = {
  provider: "openrouter" | "gnani";
  operation: "brief" | "stt" | "tts";
  model?: string | null;
  requestId?: string | null;
  status: "ok" | "error" | "refused";
  /** A short machine code such as "rate_limited" or "customer_limit". */
  reason?: string;
  durationMs?: number;
  units?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
};

export function logProviderCall(event: ProviderLogEvent, now: () => Date = () => new Date()): void {
  const line = { event: "provider_call", at: now().toISOString(), ...event };
  console.info(JSON.stringify(line));
}
