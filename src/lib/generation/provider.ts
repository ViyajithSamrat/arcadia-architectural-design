import { ImageProviderUnavailableError, type ImageGenerationProvider } from "@/lib/providers/images";
import { createMockImageProvider } from "@/lib/providers/mock-image";

/**
 * Chooses the image provider. Only the labelled MOCK exists. "live" mode reports the
 * service unavailable instead of using the mock, so a live configuration can never produce
 * a placeholder that looks like a real result. There is no live image adapter in this code
 * base: adding one needs a verified provider/model, credentials, a price and an
 * owner-approved spending cap, and a deliberate change here.
 */
export function getImageProvider(env: Record<string, string | undefined> = process.env): ImageGenerationProvider {
  if (env.PROVIDER_MODE?.trim().toLowerCase() === "live") {
    throw new ImageProviderUnavailableError("Live image generation is not enabled.");
  }
  return createMockImageProvider();
}
