import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GnaniSttConfig } from "@/lib/providers/config";
import { createGnaniSttProvider } from "@/lib/providers/gnani";
import type { SpeechToTextProvider } from "@/lib/providers/interfaces";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import type { LiveSpeechDeps } from "./service";

/**
 * Builds what a live transcription needs: the Gnani adapter and the trusted client for the usage
 * ledger. Any failure (for example the server-side Supabase settings are missing) gives null, so
 * the route answers "unavailable" instead of failing with an unhandled error. Building them makes
 * no network call. The route only calls this in a complete live configuration.
 */
export function createLiveSpeechDeps(
  config: GnaniSttConfig,
  factories: { provider?: (config: GnaniSttConfig) => SpeechToTextProvider; service?: () => SupabaseClient } = {},
): LiveSpeechDeps | null {
  try {
    const provider = (factories.provider ?? createGnaniSttProvider)(config);
    const service = (factories.service ?? createSupabaseServiceClient)();
    return { provider, service };
  } catch {
    return null;
  }
}
