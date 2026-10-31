import { getOpenRouterImageConfig } from "@/lib/providers/config";
import { ImageProviderUnavailableError, type ImageGenerationProvider } from "@/lib/providers/images";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { createOpenRouterImageProvider } from "@/lib/providers/openrouter-image";

/**
 * Chooses the image provider.
 *
 *   PROVIDER_MODE unset or "mock"  the labelled MOCK placeholder generator.
 *   PROVIDER_MODE "live"           the OpenRouter Image API, only when its settings are complete
 *                                  (key, an image model, the OpenRouter host). Otherwise the
 *                                  service is reported unavailable.
 *
 * There is no fallback in either direction: a live configuration that is incomplete or wrong
 * can never produce a placeholder that looks like a real result, and a provider failure is a
 * failed job, never a quiet switch to the mock.
 */
export function getImageProvider(env: Record<string, string | undefined> = process.env, deps: { fetch?: typeof fetch } = {}): ImageGenerationProvider {
  if (env.PROVIDER_MODE?.trim().toLowerCase() === "live") {
    const config = getOpenRouterImageConfig(env);
    if (!config) throw new ImageProviderUnavailableError("Live image generation is not configured.");
    return createOpenRouterImageProvider(config, deps);
  }
  return createMockImageProvider();
}

/** What the image generator is on this server, for screens that must describe it truthfully. */
export type ImageGenerationMode = "mock" | "live" | "live_unavailable";

/**
 * Which generator getImageProvider would give, without building one (the same rule):
 *   PROVIDER_MODE not "live"                     "mock": the labelled placeholder generator, no network, no cost
 *   "live" with the OpenRouter image settings    "live": the AI image model, billed per image
 *   "live" with them incomplete or wrong         "live_unavailable": generation fails, it never becomes the mock
 * It reads no secret and returns no setting value.
 */
export function getImageGenerationMode(env: Record<string, string | undefined> = process.env): ImageGenerationMode {
  if (env.PROVIDER_MODE?.trim().toLowerCase() !== "live") return "mock";
  return getOpenRouterImageConfig(env) !== null ? "live" : "live_unavailable";
}

/** True when generation would call the live image model (and spend credits), for honest screen wording. */
export function isLiveImageGeneration(env: Record<string, string | undefined> = process.env): boolean {
  return env.PROVIDER_MODE?.trim().toLowerCase() === "live" && getOpenRouterImageConfig(env) !== null;
}

/**
 * Whether a project's reference photos would be sent to an outside image service: only in live
 * mode, with a complete OpenRouter image configuration whose owner switched references on. Used
 * to tell the customer the truth next to the upload control.
 */
export function referencesSentToImageService(env: Record<string, string | undefined> = process.env): boolean {
  if (env.PROVIDER_MODE?.trim().toLowerCase() !== "live") return false;
  return getOpenRouterImageConfig(env)?.sendReferences === true;
}
