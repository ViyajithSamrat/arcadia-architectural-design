import { sniffImage } from "@/lib/payments/evidence";
import { ProviderError, type ProviderHooks } from "./interfaces";
import type { UsagePlan } from "./budget";

/**
 * Image-generation boundary (02_TRD.md section 2.5, 06_IMAGE_GENERATION_RELEASE.md).
 *
 * Only a labelled MOCK implements this today (mock-image.ts). There is deliberately no live
 * adapter: live image generation needs a verified provider/model, credentials, a price and
 * an owner-approved spending cap, none of which exist yet.
 *
 * Everything a provider returns is UNTRUSTED. `validateImageOutputs` is the only way output
 * becomes something the application stores: it checks count, size, real file type (magic
 * bytes, never the declared type or a name) and dimensions. A provider has no handle on
 * payment, ownership, status or release.
 */

/** A view the project needs, decided by the server from the project type. */
export type ImageView = {
  key: string;
  assetType: "EXTERIOR_CONCEPT" | "INTERIOR_CONCEPT" | "LANDSCAPE_CONCEPT";
  /** Short human label, used by the mock's caption. */
  label: string;
  /** Trusted, fixed instruction for this view (never contains customer text). */
  instruction: string;
};

/**
 * The request an adapter must send. `instructions` and the view instructions are trusted
 * constants. `customerData` is untrusted DATA: adapters must send it as a separate data
 * field/message, never concatenated into the instructions.
 */
export type ImageGenerationRequest = {
  promptVersion: string;
  instructions: string;
  views: ImageView[];
  customerData: Record<string, unknown>;
  /** Correlation id for logs and (later) provider idempotency. Not secret. */
  requestId: string;
  timeoutMs: number;
};

export type ImageOutput = { viewKey: string; bytes: Uint8Array; mimeType: string };

export type ImageGenerationResult = {
  outputs: ImageOutput[];
  provider: string;
  model: string;
  /** True for the placeholder generator. Persisted so a mock is never mistaken for a real result. */
  mock: boolean;
};

export interface ImageGenerationProvider {
  readonly id: string;
  readonly model: string;
  readonly mock: boolean;
  /** Set only by providers that cost something: the budget guard reserves this first. The mock has none. */
  readonly usage?: UsagePlan;
  generate(request: ImageGenerationRequest, hooks?: ProviderHooks): Promise<ImageGenerationResult>;
}

export class ImageProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageProviderUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

/** Equals the bucket limit (migration 6: 5 MiB JPEG/PNG/WebP). Raising it needs a new migration. */
export const GENERATED_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const GENERATED_IMAGE_MIN_DIMENSION = 64;
export const GENERATED_IMAGE_MAX_DIMENSION = 4096;

export type ValidImage = { viewKey: string; bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp"; ext: "png" | "jpg" | "webp"; width: number; height: number };

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

/** Pixel size read from the file's own header; null when the header is not understood. */
export function readImageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png") {
      // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
      if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    }
    if (mime === "image/jpeg") {
      let o = 2;
      while (o + 9 < bytes.length) {
        if (bytes[o] !== 0xff) return null;
        const marker = bytes[o + 1];
        if (marker === 0xff) {
          o += 1;
          continue;
        }
        // Start-of-frame markers (not DHT 0xC4, JPG 0xC8, DAC 0xCC) carry the size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: u16be(bytes, o + 5), width: u16be(bytes, o + 7) };
        }
        o += 2 + u16be(bytes, o + 2);
      }
      return null;
    }
    if (mime === "image/webp") {
      const kind = String.fromCharCode(...bytes.subarray(12, 16));
      if (kind === "VP8X" && bytes.length >= 30) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
      if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
        const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export type OutputCheck = { ok: true; images: ValidImage[] } | { ok: false; reason: "empty" | "wrong_count" | "unexpected_view" | "too_large" | "unsupported_type" | "bad_dimensions" };

/**
 * Accepts the provider's output only if there is exactly one valid image per requested view.
 * An empty, partial, oversized or unrecognised result is a failure, never a success.
 */
export function validateImageOutputs(outputs: unknown, views: ImageView[]): OutputCheck {
  if (!Array.isArray(outputs) || outputs.length === 0) return { ok: false, reason: "empty" };
  if (outputs.length !== views.length) return { ok: false, reason: "wrong_count" };
  const wanted = new Set(views.map((v) => v.key));
  const seen = new Set<string>();
  const images: ValidImage[] = [];
  for (const raw of outputs as Partial<ImageOutput>[]) {
    if (!raw || typeof raw.viewKey !== "string" || !wanted.has(raw.viewKey) || seen.has(raw.viewKey)) return { ok: false, reason: "unexpected_view" };
    seen.add(raw.viewKey);
    const bytes = raw.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { ok: false, reason: "empty" };
    if (bytes.length > GENERATED_IMAGE_MAX_BYTES) return { ok: false, reason: "too_large" };
    const sniffed = sniffImage(bytes); // the real type, from the first bytes
    if (!sniffed) return { ok: false, reason: "unsupported_type" };
    const size = readImageSize(bytes, sniffed.mime);
    if (
      !size ||
      size.width < GENERATED_IMAGE_MIN_DIMENSION || size.height < GENERATED_IMAGE_MIN_DIMENSION ||
      size.width > GENERATED_IMAGE_MAX_DIMENSION || size.height > GENERATED_IMAGE_MAX_DIMENSION
    ) {
      return { ok: false, reason: "bad_dimensions" };
    }
    images.push({ viewKey: raw.viewKey, bytes, mimeType: sniffed.mime, ext: sniffed.ext, width: size.width, height: size.height });
  }
  return { ok: true, images };
}

/** Runs `work` but gives up after `ms`. The work itself is not cancelled; the caller treats it as failed. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError("timeout", "image provider timed out")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
