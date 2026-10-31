import { describe, expect, it, vi } from "vitest";
import { createTimeoutFetch, SUPABASE_REQUEST_TIMEOUT_MS, SUPABASE_STORAGE_TIMEOUT_MS, timeoutFor } from "@/lib/supabase/timeout";

/** A fetch that never answers on its own and rejects only when it is aborted, like a hung connection. */
const hanging = (() => {
  const calls: { url: string; signal?: AbortSignal | null }[] = [];
  const fn = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      calls.push({ url: String(input), signal: init?.signal });
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  return Object.assign(fn, { calls });
})();

describe("timeoutFor", () => {
  it("gives database and auth calls the short limit and file transfers the long one", () => {
    expect(timeoutFor("http://x/rest/v1/projects?select=id")).toBe(SUPABASE_REQUEST_TIMEOUT_MS);
    expect(timeoutFor("http://x/auth/v1/user")).toBe(SUPABASE_REQUEST_TIMEOUT_MS);
    expect(timeoutFor("http://x/storage/v1/object/project-files/a/b.png")).toBe(SUPABASE_STORAGE_TIMEOUT_MS);
    expect(timeoutFor("http://x/storage/v1/object/sign/project-files/a/b.png")).toBe(SUPABASE_STORAGE_TIMEOUT_MS);
    expect(SUPABASE_STORAGE_TIMEOUT_MS).toBeGreaterThan(SUPABASE_REQUEST_TIMEOUT_MS);
  });
});

describe("createTimeoutFetch", () => {
  it("rejects a request that never answers, with a TimeoutError, instead of hanging", async () => {
    const f = createTimeoutFetch(hanging, { defaultMs: 30 });
    const started = Date.now();
    await expect(f("http://x/rest/v1/projects")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("uses the storage limit for file transfers", async () => {
    const f = createTimeoutFetch(hanging, { defaultMs: 20, storageMs: 120 });
    const started = Date.now();
    await expect(f("http://x/storage/v1/object/project-files/p/references/a.png", { method: "POST" })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("still honours the caller's own abort", async () => {
    const controller = new AbortController();
    const f = createTimeoutFetch(hanging, { defaultMs: 10_000 });
    const pending = f("http://x/rest/v1/projects", { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });

  it("passes a normal response through unchanged, with the request intact", async () => {
    const base = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    const f = createTimeoutFetch(base);
    const res = await f("http://x/rest/v1/projects", { method: "POST", headers: { a: "b" }, body: "{}" });
    expect(res.status).toBe(200);
    const [url, init] = (base as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/rest/v1/projects");
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never retries: a timed-out write is attempted exactly once", async () => {
    hanging.calls.length = 0;
    const f = createTimeoutFetch(hanging, { defaultMs: 20 });
    await expect(f("http://x/rest/v1/design_assets", { method: "POST" })).rejects.toBeDefined();
    expect(hanging.calls).toHaveLength(1);
  });
});
