/**
 * A small sliding-window rate limit with a concurrency cap, keyed by the signed-in user's id
 * (never by anything the browser sends). It protects the transcribe route in every mode,
 * including the mock, before the request body is read.
 *
 * LIMITATION: the counters live in this server process's memory. With several server processes
 * or instances each keeps its own counters, and a restart clears them, so this is a guard
 * against a runaway client, not a production-grade quota. The cross-process limits that matter
 * for cost (per-customer credits per hour, one live call in flight, the total budget) are
 * enforced by the usage ledger in the database before any live provider call.
 */

export type LimitOptions = {
  windowMs: number;
  maxPerWindow: number;
  maxConcurrent: number;
  /** Most keys tracked at once; the least recently used are forgotten first. */
  maxKeys: number;
  now?: () => number;
};

export type Acquired = { ok: true; release: () => void } | { ok: false; reason: "rate" | "concurrent"; retryAfterSeconds: number };

type Entry = { starts: number[]; active: number };

export class RequestLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: LimitOptions) {}

  acquire(key: string): Acquired {
    const now = (this.options.now ?? Date.now)();
    const entry = this.entries.get(key) ?? { starts: [], active: 0 };
    entry.starts = entry.starts.filter((t) => t > now - this.options.windowMs);
    // Re-inserted so the map's order is least recently used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict();

    if (entry.active >= this.options.maxConcurrent) return { ok: false, reason: "concurrent", retryAfterSeconds: 1 };
    if (entry.starts.length >= this.options.maxPerWindow) {
      const retryAfterMs = entry.starts[0] + this.options.windowMs - now;
      return { ok: false, reason: "rate", retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    entry.starts.push(now);
    entry.active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        entry.active = Math.max(0, entry.active - 1);
      },
    };
  }

  /** For tests. */
  reset(): void {
    this.entries.clear();
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxKeys) return;
      if (entry.active === 0) this.entries.delete(key);
    }
  }
}

/** Per signed-in user: 10 recordings a minute, one at a time. */
export const TRANSCRIBE_LIMITS: LimitOptions = { windowMs: 60_000, maxPerWindow: 10, maxConcurrent: 1, maxKeys: 10_000 };

/** One limiter per server process, shared through globalThis so a module reload keeps it. */
export function transcribeLimiter(): RequestLimiter {
  const holder = globalThis as typeof globalThis & { __voiceTranscribeLimiter?: RequestLimiter };
  holder.__voiceTranscribeLimiter ??= new RequestLimiter(TRANSCRIBE_LIMITS);
  return holder.__voiceTranscribeLimiter;
}

/** Spoken read-back costs credits per character: per signed-in user, 5 requests a minute, one at a time. */
export const READBACK_LIMITS: LimitOptions = { windowMs: 60_000, maxPerWindow: 5, maxConcurrent: 1, maxKeys: 10_000 };

/** Transcript translation is a paid text request: per signed-in user, 5 a minute, one at a time. */
export const TRANSLATE_LIMITS: LimitOptions = { windowMs: 60_000, maxPerWindow: 5, maxConcurrent: 1, maxKeys: 10_000 };

export function translateLimiter(): RequestLimiter {
  const holder = globalThis as typeof globalThis & { __voiceTranslateLimiter?: RequestLimiter };
  holder.__voiceTranslateLimiter ??= new RequestLimiter(TRANSLATE_LIMITS);
  return holder.__voiceTranslateLimiter;
}

export function readbackLimiter(): RequestLimiter {
  const holder = globalThis as typeof globalThis & { __voiceReadbackLimiter?: RequestLimiter };
  holder.__voiceReadbackLimiter ??= new RequestLimiter(READBACK_LIMITS);
  return holder.__voiceReadbackLimiter;
}
