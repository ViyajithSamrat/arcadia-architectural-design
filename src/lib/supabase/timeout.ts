/**
 * A fetch that gives every Supabase request a time limit. Passed to the server-side Supabase
 * clients as `global.fetch`, so PostgREST, Auth and Storage calls from this server can no longer
 * hang a request for ever.
 *
 * What a timeout means, and does not mean:
 *   - The caller sees a rejected request (a TimeoutError); it is an ordinary failure to the
 *     Supabase client, so existing error handling and the "failed means nothing was recorded"
 *     paths apply. It never turns into a success.
 *   - The server may still finish the work it was asked to do (an abort stops waiting, it does not
 *     undo). That is why every write path in this code base is ordered so that a missing answer
 *     leaves nothing misleading: a file is uploaded before its row exists, a row is removed before
 *     its file, a failed run deletes what it wrote, and a file without a row stays private.
 *   - Nothing here retries. A retry of a write could duplicate it; callers that need one use an
 *     idempotent operation (a conditional update, a unique key) and decide for themselves.
 *   - A caller's own AbortSignal still works: both signals are combined.
 */

export const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;
/** Uploads and downloads move file bytes, so they get longer. */
export const SUPABASE_STORAGE_TIMEOUT_MS = 60_000;

export function timeoutFor(url: string, overrides: { defaultMs?: number; storageMs?: number } = {}): number {
  const storage = /\/storage\/v1\/object\//.test(url);
  return storage ? (overrides.storageMs ?? SUPABASE_STORAGE_TIMEOUT_MS) : (overrides.defaultMs ?? SUPABASE_REQUEST_TIMEOUT_MS);
}

export function createTimeoutFetch(base?: typeof fetch, overrides: { defaultMs?: number; storageMs?: number } = {}): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const timeout = AbortSignal.timeout(timeoutFor(url, overrides));
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return (base ?? fetch)(input, { ...init, signal });
  };
}
