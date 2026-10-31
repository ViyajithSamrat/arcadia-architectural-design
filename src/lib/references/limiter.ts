import { RequestLimiter, type LimitOptions } from "@/lib/voice/rate-limit";

/**
 * Per signed-in user: 20 uploads a minute, two at a time. Per server process only (counters live
 * in memory), so it guards against a runaway client, not as a production quota; the per-project
 * file count and the 5 MiB limit are enforced by the service and the database.
 */
export const REFERENCE_UPLOAD_LIMITS: LimitOptions = { windowMs: 60_000, maxPerWindow: 20, maxConcurrent: 2, maxKeys: 10_000 };

export function referenceLimiter(): RequestLimiter {
  const holder = globalThis as typeof globalThis & { __referenceUploadLimiter?: RequestLimiter };
  holder.__referenceUploadLimiter ??= new RequestLimiter(REFERENCE_UPLOAD_LIMITS);
  return holder.__referenceUploadLimiter;
}
