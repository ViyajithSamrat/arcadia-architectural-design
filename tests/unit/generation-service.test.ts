import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/auth/errors";
import { clearStaleJob, isMockJob, isStaleJob, releaseProject, startGeneration, STALE_JOB_AFTER_MS } from "@/lib/generation/service";
import { mockBriefProvider } from "@/lib/journeys/brief";
import type { ImageGenerationProvider, ImageGenerationResult } from "@/lib/providers/images";
import { ProviderError } from "@/lib/providers/interfaces";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { FakeDb } from "./support/fake-supabase";
import { REQUIREMENTS } from "./support/journey-fixtures";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const KEY = "key-0123456789abcdef";
const KEY2 = "key-second-0123456789";
const SECRET_WORDS = "PRIVATE-CUSTOMER-WORDS-MARKER";

let db: FakeDb;
let brief: unknown;

/** The caller's own session: signed in, and the database says whether they are an administrator. */
const session = (opts: { admin?: boolean; signedIn?: boolean } = {}) =>
  ({
    auth: { getUser: async () => (opts.signedIn === false ? { data: { user: null }, error: { message: "no" } } : { data: { user: { id: ADMIN } }, error: null }) },
    rpc: async (name: string) => (name === "is_admin" ? { data: opts.admin !== false, error: null } : { data: null, error: { message: "unexpected" } }),
  }) as unknown as SupabaseClient;

const project = (patch: Record<string, unknown> = {}) => ({
  id: PROJECT, customer_id: CUSTOMER, status: "PAYMENT_VERIFIED", project_type: "EMPTY_PLOT",
  english_brief_json: brief, english_brief_text: `Approved brief. ${SECRET_WORDS}`, ...patch,
});

/** Counts calls so a test can prove the provider ran once, or not at all. */
function spyProvider(inner: Partial<ImageGenerationProvider> = {}) {
  const base = createMockImageProvider();
  const calls: unknown[] = [];
  const provider: ImageGenerationProvider = {
    ...base,
    ...inner,
    generate: async (request, hooks) => {
      calls.push(request);
      return (inner.generate ?? base.generate)(request, hooks);
    },
  };
  return { provider, calls };
}

const start = (provider: ImageGenerationProvider, key = KEY, env: Record<string, string | undefined> = {}, who = session()) =>
  startGeneration(who, db.client(), { projectId: PROJECT, idempotencyKey: key }, { provider, env, newRequestId: () => "req-test" });

const row = (table: string) => db.rows(table);
const projectStatus = () => (row("projects").find((r) => r.id === PROJECT) as { status: string }).status;
const jobs = () => row("generation_jobs") as { id: string; status: string; error_code?: string; error_summary?: string; provider: string; prompt_json: unknown; idempotency_key: string }[];
const nonSelectWrites = () => db.writes.length;

beforeEach(async () => {
  brief = await mockBriefProvider.generate({ projectType: "EMPTY_PLOT", sourceLanguage: "en", requirements: REQUIREMENTS.EMPTY_PLOT });
  db = new FakeDb().seed("projects", [project()]);
  db.defaults.generation_jobs = { status: "QUEUED", attempt_count: 0 };
  db.defaults.design_assets = { is_released: false };
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("startGeneration: the happy path (mock provider)", () => {
  it("creates unreleased, private assets and leaves the project ready for review, not released", async () => {
    const { provider, calls } = spyProvider();
    const result = await start(provider);
    expect(result).toMatchObject({ ok: true, replayed: false, mock: true });
    expect(calls).toHaveLength(1);
    expect(projectStatus()).toBe("READY_FOR_REVIEW");
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ status: "SUCCEEDED", provider: "mock", idempotency_key: KEY });

    const assets = row("design_assets") as { asset_type: string; storage_path: string; is_released: boolean; mime_type: string; width: number; height: number; generation_job_id: string }[];
    expect(assets.map((a) => a.asset_type).sort()).toEqual(["EXTERIOR_CONCEPT", "INTERIOR_CONCEPT"]);
    expect(assets.every((a) => a.is_released === false && a.mime_type === "image/png" && a.width === 640 && a.height === 360)).toBe(true);
    expect(assets.every((a) => a.storage_path.startsWith(`${PROJECT}/generated/`) && a.storage_path.endsWith(".png"))).toBe(true);
    expect(db.uploads.map((u) => u.path).sort()).toEqual(assets.map((a) => a.storage_path).sort());
    expect(db.uploads.every((u) => u.contentType === "image/png")).toBe(true);
    // no write ever sets a release flag
    expect(db.writes.some((w) => "is_released" in w.payload && w.payload.is_released === true)).toBe(false);
    expect(db.writes.some((w) => w.table === "projects" && w.payload.status === "RELEASED")).toBe(false);
  });

  it("claims the project before creating the job, and only then stores anything", async () => {
    await start(spyProvider().provider);
    const order = db.writes.map((w) => `${w.table}.${w.op}`);
    expect(order.indexOf("projects.update")).toBeLessThan(order.indexOf("generation_jobs.insert"));
    expect(order.indexOf("generation_jobs.insert")).toBeLessThan(order.indexOf("design_assets.insert"));
    expect(db.writes.filter((w) => w.table === "projects").map((w) => w.payload.status)).toEqual(["GENERATING", "READY_FOR_REVIEW"]);
  });

  it("records who started it, and keeps the customer's words off the job and out of the logs", async () => {
    await start(spyProvider().provider);
    expect(row("audit_events")).toMatchObject([{ actor_id: ADMIN, action: "generation.admin_started", project_id: PROJECT }]);
    expect(JSON.stringify(jobs()[0].prompt_json)).not.toContain(SECRET_WORDS);
    expect(JSON.stringify(row("audit_events"))).not.toContain(SECRET_WORDS);
    const logged = (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join("\n");
    expect(logged).not.toContain(SECRET_WORDS);
    expect(logged).toContain("generation.ready_for_review");
  });

  it("sends the customer's words only as data, never inside the instructions", async () => {
    const { provider, calls } = spyProvider();
    await start(provider);
    const request = calls[0] as { instructions: string; customerData: { summary: string } };
    expect(request.customerData.summary).toContain(SECRET_WORDS);
    expect(request.instructions).not.toContain(SECRET_WORDS);
  });

  it("honours a lower image cap", async () => {
    const { provider } = spyProvider();
    await start(provider, KEY, { MAX_GENERATION_IMAGES: "1" });
    expect(row("design_assets")).toHaveLength(1);
  });

  it("can retry after a failure with a new key", async () => {
    const failing = spyProvider({ generate: async () => { throw new ProviderError("server", "x"); } });
    expect(await start(failing.provider)).toMatchObject({ ok: false, code: "failed" });
    expect(projectStatus()).toBe("GENERATION_FAILED");
    expect(await start(spyProvider().provider, KEY2)).toMatchObject({ ok: true });
    expect(projectStatus()).toBe("READY_FOR_REVIEW");
    expect(jobs().map((j) => j.status)).toEqual(["FAILED", "SUCCEEDED"]);
  });
});

describe("startGeneration: who and when", () => {
  it("throws for a caller who is not signed in or not an administrator, and writes nothing", async () => {
    const { provider, calls } = spyProvider();
    await expect(start(provider, KEY, {}, session({ admin: false }))).rejects.toMatchObject({ status: 403 });
    await expect(start(provider, KEY, {}, session({ signedIn: false }))).rejects.toBeInstanceOf(AuthError);
    expect(calls).toHaveLength(0);
    expect(nonSelectWrites()).toBe(0);
    expect(projectStatus()).toBe("PAYMENT_VERIFIED");
  });

  it.each(["not-a-uuid", "", "1; drop table projects"])("rejects a malformed project id (%j)", async (projectId) => {
    const { provider, calls } = spyProvider();
    const result = await startGeneration(session(), db.client(), { projectId, idempotencyKey: KEY }, { provider, env: {} });
    expect(result).toMatchObject({ ok: false, code: "bad_request" });
    expect(calls).toHaveLength(0);
  });

  it.each(["", "short", "has spaces in it 12345", "x".repeat(65), "bad/key/0123456789"])("rejects a malformed idempotency key (%j)", async (key) => {
    const { provider, calls } = spyProvider();
    expect(await start(provider, key)).toMatchObject({ ok: false, code: "bad_request" });
    expect(calls).toHaveLength(0);
    expect(nonSelectWrites()).toBe(0);
  });

  it("reports an unknown project", async () => {
    db = new FakeDb();
    expect(await start(spyProvider().provider)).toMatchObject({ ok: false, code: "not_found" });
  });

  it.each(["DRAFT", "BRIEF_APPROVED", "QUOTED", "AWAITING_PAYMENT", "PAYMENT_PROOF_SUBMITTED", "PAYMENT_REJECTED", "READY_FOR_REVIEW", "RELEASED", "CANCELLED"])(
    "refuses a project in status %s, with no write and no provider call",
    async (status) => {
      db = new FakeDb().seed("projects", [project({ status })]);
      const { provider, calls } = spyProvider();
      expect(await start(provider)).toMatchObject({ ok: false, code: "not_eligible" });
      expect(calls).toHaveLength(0);
      expect(nonSelectWrites()).toBe(0);
    },
  );

  it("refuses when the database says the payment is not verified (client status is irrelevant), before any job exists", async () => {
    db.failNext = { table: "projects", op: "update", code: "42501" };
    const { provider, calls } = spyProvider();
    expect(await start(provider)).toMatchObject({ ok: false, code: "not_eligible" });
    expect(calls).toHaveLength(0);
    expect(jobs()).toHaveLength(0);
    expect(row("design_assets")).toHaveLength(0);
  });

  it("refuses while a job is already queued or running, with no second call", async () => {
    for (const status of ["QUEUED", "RUNNING"]) {
      db = new FakeDb().seed("projects", [project({ status: "GENERATING" })]).seed("generation_jobs", [{ id: "j1", project_id: PROJECT, status, idempotency_key: "other-key-0123456789" }]);
      const { provider, calls } = spyProvider();
      expect(await start(provider)).toMatchObject({ ok: false, code: "in_progress" });
      expect(calls).toHaveLength(0);
      expect(nonSelectWrites()).toBe(0);
    }
  });

  it("refuses a project that already holds generated files (release would publish them all)", async () => {
    db.seed("design_assets", [{ id: "a1", project_id: PROJECT, generation_job_id: "old", storage_path: `${PROJECT}/generated/old.png` }]);
    const { provider, calls } = spyProvider();
    expect(await start(provider)).toMatchObject({ ok: false, code: "not_eligible" });
    expect(calls).toHaveLength(0);
    expect(nonSelectWrites()).toBe(0);
  });

  it("refuses an invalid stored brief before changing anything", async () => {
    db = new FakeDb().seed("projects", [project({ english_brief_json: { englishBrief: "only this" } })]);
    const { provider, calls } = spyProvider();
    expect(await start(provider)).toMatchObject({ ok: false, code: "brief_invalid" });
    expect(calls).toHaveLength(0);
    expect(nonSelectWrites()).toBe(0);
    expect(projectStatus()).toBe("PAYMENT_VERIFIED");
  });
});

describe("startGeneration: idempotency and recovery", () => {
  it("never runs the provider twice for the same key", async () => {
    const { provider, calls } = spyProvider();
    const first = await start(provider);
    const writesAfterFirst = db.writes.length;
    const again = await start(provider);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(again).toMatchObject({ ok: true, replayed: true, mock: true });
    expect(again.ok && first.ok && again.jobId === first.jobId && again.assetIds.length === 2).toBe(true);
    expect(calls).toHaveLength(1);
    expect(db.writes.length).toBe(writesAfterFirst);
    expect(jobs()).toHaveLength(1);
  });

  it("does not retry a failed attempt under the same key", async () => {
    const failing = spyProvider({ generate: async () => { throw new ProviderError("server", "x"); } });
    await start(failing.provider);
    const ok = spyProvider();
    expect(await start(ok.provider)).toMatchObject({ ok: false, code: "failed" });
    expect(ok.calls).toHaveLength(0);
  });

  it("finishes a project left in GENERATING after a succeeded job without calling the provider", async () => {
    db = new FakeDb()
      .seed("projects", [project({ status: "GENERATING" })])
      .seed("generation_jobs", [{ id: "j1", project_id: PROJECT, status: "SUCCEEDED", provider: "mock", idempotency_key: "old-key-0123456789ab" }])
      .seed("design_assets", [{ id: "a1", project_id: PROJECT, generation_job_id: "j1" }]);
    const { provider, calls } = spyProvider();
    expect(await start(provider, KEY2)).toMatchObject({ ok: true, replayed: true, jobId: "j1", mock: true });
    expect(projectStatus()).toBe("READY_FOR_REVIEW");
    expect(calls).toHaveLength(0);
  });

  it("resumes a project left in GENERATING with no job, but only once it has sat that way for a minute", async () => {
    const seed = (updated_at: string) => {
      db = new FakeDb().seed("projects", [project({ status: "GENERATING", updated_at })]);
      db.defaults.generation_jobs = { status: "QUEUED", attempt_count: 0 };
      db.defaults.design_assets = { is_released: false };
    };
    const now = Date.parse("2026-10-20T12:00:00Z");
    const run = (provider: ImageGenerationProvider) =>
      startGeneration(session(), db.client(), { projectId: PROJECT, idempotencyKey: KEY }, { provider, env: {}, now: () => now });

    seed("2026-10-20T11:59:30Z"); // 30 seconds ago: another request is probably still claiming it
    const fresh = spyProvider();
    expect(await run(fresh.provider)).toMatchObject({ ok: false, code: "in_progress" });
    expect(fresh.calls).toHaveLength(0);
    expect(nonSelectWrites()).toBe(0);

    seed("2026-10-20T11:00:00Z");
    expect(await run(spyProvider().provider)).toMatchObject({ ok: true, replayed: false });
    expect(projectStatus()).toBe("READY_FOR_REVIEW");
    expect(db.writes.filter((w) => w.table === "projects").map((w) => w.payload.status)).toEqual(["READY_FOR_REVIEW"]);
  });

  it("reports, without losing the work, when the final status change fails; the same request completes it", async () => {
    const { provider, calls } = spyProvider();
    let projectUpdates = 0;
    const original = db.client();
    const flaky = new Proxy(original, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const q = (target.from as unknown as (t: string) => Record<string, (...a: unknown[]) => unknown>)(table);
          if (table !== "projects") return q;
          return new Proxy(q, {
            get(qt, qp) {
              if (qp === "update") {
                return (payload: { status?: string }) => {
                  projectUpdates += 1;
                  if (payload.status === "READY_FOR_REVIEW" && projectUpdates === 2) db.failNext = { table: "projects", op: "update" };
                  return qt.update(payload);
                };
              }
              const v = (qt as Record<string | symbol, unknown>)[qp];
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(qt) : v;
            },
          });
        };
      },
    });
    const first = await startGeneration(session(), flaky as SupabaseClient, { projectId: PROJECT, idempotencyKey: KEY }, { provider, env: {} });
    expect(first).toMatchObject({ ok: false, code: "finalize_failed" });
    expect(jobs()[0].status).toBe("SUCCEEDED");
    expect(row("design_assets")).toHaveLength(2);
    expect(projectStatus()).toBe("GENERATING");
    expect(await start(provider)).toMatchObject({ ok: true, replayed: true });
    expect(projectStatus()).toBe("READY_FOR_REVIEW");
    expect(calls).toHaveLength(1);
  });
});

describe("startGeneration: provider and output failures", () => {
  const expectCleanFailure = (errorCode: string) => {
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]).toMatchObject({ status: "FAILED", error_code: errorCode });
    expect(JSON.stringify(jobs()[0])).not.toContain(SECRET_WORDS);
    expect(projectStatus()).toBe("GENERATION_FAILED");
    expect(row("design_assets")).toHaveLength(0);
    expect(db.objects.size).toBe(0);
  };

  it.each([
    ["timeout", "PROVIDER_TIMEOUT"],
    ["rate_limited", "PROVIDER_RATE_LIMITED"],
    ["server", "PROVIDER_SERVER"],
    ["bad_response", "PROVIDER_BAD_RESPONSE"],
  ] as const)("records a %s from the provider as FAILED, calls it once and shows nothing", async (code, errorCode) => {
    const { provider, calls } = spyProvider({ generate: async () => { throw new ProviderError(code, "provider said: secret detail"); } });
    const result = await start(provider);
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(JSON.stringify(result)).not.toContain("secret detail");
    expect(calls).toHaveLength(1);
    expectCleanFailure(errorCode);
  });

  it("treats an unexpected exception as a failure too", async () => {
    const { provider } = spyProvider({ generate: async () => { throw new Error("boom with details"); } });
    const result = await start(provider);
    expect(JSON.stringify(result)).not.toContain("boom");
    expectCleanFailure("PROVIDER_ERROR");
  });

  it("gives up on a provider that never answers", async () => {
    const hang = spyProvider({ generate: () => new Promise<ImageGenerationResult>(() => undefined) });
    const result = await start(hang.provider, KEY, { PROVIDER_TIMEOUT_MS: "1000" });
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(hang.calls).toHaveLength(1);
    expectCleanFailure("PROVIDER_TIMEOUT");
  }, 10_000);

  it.each([
    ["an empty result", () => ({ outputs: [] }), "OUTPUT_EMPTY"],
    ["a partial result", () => ({ outputs: [{ viewKey: "exterior_front", mimeType: "image/png", bytes: new Uint8Array([1]) }] }), "OUTPUT_WRONG_COUNT"],
    ["a result that is not a picture", () => ({ outputs: ["exterior_front", "interior_main"].map((viewKey) => ({ viewKey, mimeType: "image/png", bytes: new TextEncoder().encode("<svg onload=alert(1)></svg>") })) }), "OUTPUT_UNSUPPORTED_TYPE"],
    ["an oversized result", () => ({ outputs: ["exterior_front", "interior_main"].map((viewKey) => ({ viewKey, mimeType: "image/png", bytes: new Uint8Array(6 * 1024 * 1024) })) }), "OUTPUT_TOO_LARGE"],
  ])("rejects %s without storing anything", async (_name, make, errorCode) => {
    const { provider, calls } = spyProvider({ generate: async () => ({ ...make(), provider: "mock", model: "m", mock: true }) as ImageGenerationResult });
    expect(await start(provider)).toMatchObject({ ok: false, code: "failed" });
    expect(calls).toHaveLength(1);
    expectCleanFailure(errorCode);
  });

  it("removes everything and marks the job failed when storage fails", async () => {
    db.failUpload = true;
    expect(await start(spyProvider().provider)).toMatchObject({ ok: false, code: "failed" });
    expectCleanFailure("STORAGE_FAILED");
  });

  it("removes files and records when saving the second asset fails", async () => {
    const original = db.client();
    let inserts = 0;
    const flaky = new Proxy(original, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          if (table === "design_assets" && ++inserts === 2) db.failNext = { table: "design_assets", op: "insert" };
          return (target.from as (t: string) => unknown)(table);
        };
      },
    });
    // count only asset inserts: the first from("design_assets") is the "existing assets" read
    const result = await startGeneration(session(), flaky as SupabaseClient, { projectId: PROJECT, idempotencyKey: KEY }, { provider: createMockImageProvider(), env: {} });
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(row("design_assets")).toHaveLength(0);
    expect(db.objects.size).toBe(0);
    expect(jobs()[0].status).toBe("FAILED");
    expect(projectStatus()).toBe("GENERATION_FAILED");
  });

  it("when cleanup itself fails, flags it and blocks a retry until an administrator clears the files", async () => {
    const original = db.client();
    let inserts = 0;
    const flaky = new Proxy(original, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          if (table === "design_assets" && ++inserts === 3) db.failNext = { table: "design_assets", op: "insert" };
          if (table === "design_assets" && inserts > 3) db.failNext = { table: "design_assets", op: "delete" };
          return (target.from as (t: string) => unknown)(table);
        };
      },
    });
    const result = await startGeneration(session(), flaky as SupabaseClient, { projectId: PROJECT, idempotencyKey: KEY }, { provider: createMockImageProvider(), env: {} });
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(jobs()[0].error_summary).toContain("Cleanup incomplete");
    expect(row("design_assets").length).toBeGreaterThan(0);
    expect(row("design_assets").every((a) => (a as { is_released: boolean }).is_released === false)).toBe(true);
    const retry = spyProvider();
    expect(await start(retry.provider, KEY2)).toMatchObject({ ok: false, code: "not_eligible" });
    expect(retry.calls).toHaveLength(0);
  });

  it("reports live mode as unavailable instead of using the mock, and changes nothing", async () => {
    const result = await startGeneration(session(), db.client(), { projectId: PROJECT, idempotencyKey: KEY }, { env: { PROVIDER_MODE: "live" } });
    expect(result).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(nonSelectWrites()).toBe(0);
    expect(projectStatus()).toBe("PAYMENT_VERIFIED");
  });

  it("uses the labelled mock only when no live mode is requested", async () => {
    const result = await startGeneration(session(), db.client(), { projectId: PROJECT, idempotencyKey: KEY }, { env: {} });
    expect(result).toMatchObject({ ok: true, mock: true });
    expect(jobs()[0]).toMatchObject({ provider: "mock" });
    expect((jobs()[0] as unknown as { usage_json?: { mock?: boolean } }).usage_json).toMatchObject({ mock: true });
  });
});

describe("startGeneration: usage reservation (for a future metered provider)", () => {
  const plan = {
    provider: "openrouter" as const, operation: "brief" as const, model: "m", unit: "request" as const, units: 1,
    limits: { customerLimit: 5, customerWindowMinutes: 60, globalLimit: 40, globalWindowMinutes: 1440, maxInFlight: null },
  };

  it("reserves before the call and records the outcome", async () => {
    db.rpcHandlers.ai_usage_reserve = () => ({ data: "usage-1" });
    db.rpcHandlers.ai_usage_finish = () => ({ data: null });
    const { provider, calls } = spyProvider({ usage: plan });
    expect(await start(provider)).toMatchObject({ ok: true });
    expect(db.rpcCalls.map((c) => c.name)).toEqual(["ai_usage_reserve", "ai_usage_finish"]);
    expect(db.rpcCalls[1].args).toMatchObject({ p_status: "SUCCEEDED" });
    expect(calls).toHaveLength(1);
  });

  it("makes no provider call when the reservation is refused or the guard is unreachable", async () => {
    for (const handler of [() => ({ error: { code: "AI002", message: "x" } }), () => ({ error: { message: "db down" } })]) {
      db = new FakeDb().seed("projects", [project()]);
      db.defaults.generation_jobs = { status: "QUEUED", attempt_count: 0 };
      db.rpcHandlers.ai_usage_reserve = handler;
      const { provider, calls } = spyProvider({ usage: plan });
      expect(await start(provider)).toMatchObject({ ok: false, code: "reservation_refused" });
      expect(calls).toHaveLength(0);
      expectFailedRefusal();
    }
    function expectFailedRefusal() {
      expect(jobs()[0]).toMatchObject({ status: "FAILED", error_code: "RESERVATION_REFUSED" });
      expect(projectStatus()).toBe("GENERATION_FAILED");
      expect(row("design_assets")).toHaveLength(0);
    }
  });

  it("counts a failed metered call as used (FAILED, never released)", async () => {
    db.rpcHandlers.ai_usage_reserve = () => ({ data: "usage-1" });
    db.rpcHandlers.ai_usage_finish = () => ({ data: null });
    const { provider } = spyProvider({ usage: plan, generate: async () => { throw new ProviderError("server", "x"); } });
    await start(provider);
    expect(db.rpcCalls[1].args).toMatchObject({ p_status: "FAILED" });
  });
});

describe("the mock never reaches the network", () => {
  it("makes no fetch call during a whole generation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await start(spyProvider().provider);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** The administrator's own session over a fake database: it can read, and records its rpc calls. */
function adminSession(fake: FakeDb, opts: { rpcError?: { code?: string }; admin?: boolean } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const client = {
    ...fake.client(),
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name === "is_admin") return { data: opts.admin !== false, error: null };
      return opts.rpcError ? { data: null, error: opts.rpcError } : { data: {}, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("releaseProject", () => {
  const ready = (jobPatch: Record<string, unknown> = {}) =>
    new FakeDb()
      .seed("projects", [{ id: PROJECT, status: "READY_FOR_REVIEW" }])
      .seed("generation_jobs", [{ id: "j1", project_id: PROJECT, status: "SUCCEEDED", provider: "mock", ...jobPatch }])
      .seed("design_assets", [
        { id: "a1", project_id: PROJECT, generation_job_id: "j1" },
        { id: "a2", project_id: PROJECT, generation_job_id: "j1" },
      ]);
  const release = (fake: FakeDb, options?: Parameters<typeof releaseProject>[2], rpcError?: { code?: string }) => {
    const { client, calls } = adminSession(fake, { rpcError });
    return releaseProject(client, PROJECT, options).then((result) => ({ result, calls }));
  };

  it("calls the database release function with the administrator's own session, once the checks pass", async () => {
    const { result, calls } = await release(ready(), { acknowledgeMock: true });
    expect(result).toEqual({ ok: true });
    expect(calls.map((c) => c.name)).toEqual(["is_admin", "admin_release_project"]);
    expect(calls[1].args).toEqual({ p_project_id: PROJECT });
  });

  it("needs an explicit acknowledgement for mock output, and does not call the database without it", async () => {
    for (const options of [undefined, {}, { acknowledgeMock: false }]) {
      const { result, calls } = await release(ready(), options);
      expect(result).toMatchObject({ ok: false, message: expect.stringContaining("MOCK") });
      expect(calls.map((c) => c.name)).toEqual(["is_admin"]);
    }
  });

  it("does not ask for the mock acknowledgement when the job was not made by the mock", async () => {
    const { result } = await release(ready({ provider: "openrouter" }));
    expect(result).toEqual({ ok: true });
  });

  it("treats a job whose usage says mock as mock, whatever its provider name, exactly as the screen does", async () => {
    const flagged = () => ready({ provider: "other", usage_json: { mock: true } });
    const refused = await release(flagged());
    expect(refused.result).toMatchObject({ ok: false, message: expect.stringContaining("MOCK") });
    expect(refused.calls.map((c) => c.name)).toEqual(["is_admin"]);
    expect((await release(flagged(), { acknowledgeMock: true })).result).toEqual({ ok: true });
    expect(isMockJob({ provider: "other", usage_json: { mock: true } })).toBe(true);
    expect(isMockJob({ provider: "other", usage_json: { mock: "yes" } })).toBe(false);
    expect(isMockJob({ provider: "other", usage_json: null })).toBe(false);
  });

  it("refuses non-administrators and malformed ids before calling the release function", async () => {
    await expect(releaseProject(adminSession(ready(), { admin: false }).client, PROJECT, { acknowledgeMock: true })).rejects.toMatchObject({ status: 403 });
    await expect(releaseProject(session({ admin: false }), PROJECT)).rejects.toMatchObject({ status: 403 });
    const { client, calls } = adminSession(ready());
    expect(await releaseProject(client, "nope")).toMatchObject({ ok: false });
    expect(calls.map((c) => c.name)).toEqual(["is_admin"]);
  });

  it.each([
    ["the project is not ready for review", (f: FakeDb) => void (f.tables.projects[0].status = "GENERATING"), /not ready/],
    ["a job is still running", (f: FakeDb) => void f.seed("generation_jobs", [{ id: "j2", project_id: PROJECT, status: "RUNNING", provider: "mock" }]), /still running/],
    ["there are no files", (f: FakeDb) => void (f.tables.design_assets = []), /no generated files/],
    ["no job succeeded", (f: FakeDb) => void (f.tables.generation_jobs[0].status = "FAILED"), /no generated files|failed or unfinished/],
    [
      "a file belongs to a failed attempt",
      (f: FakeDb) => void f.seed("generation_jobs", [{ id: "j0", project_id: PROJECT, status: "FAILED", provider: "mock" }]).seed("design_assets", [{ id: "a0", project_id: PROJECT, generation_job_id: "j0" }]),
      /failed or unfinished/,
    ],
    ["a file belongs to a job that does not exist", (f: FakeDb) => void f.seed("design_assets", [{ id: "a0", project_id: PROJECT, generation_job_id: "ghost" }]), /failed or unfinished/],
  ])("refuses to release when %s, and never calls the database release function", async (_name, arrange, message) => {
    const fake = ready();
    arrange(fake);
    const { result, calls } = await release(fake, { acknowledgeMock: true });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(message) });
    expect(calls.map((c) => c.name)).toEqual(["is_admin"]);
  });

  it("explains refusals from the database without detail", async () => {
    expect((await release(ready(), { acknowledgeMock: true }, { code: "P0002" })).result).toEqual({ ok: false, message: "This project is not ready for release." });
    expect((await release(ready(), { acknowledgeMock: true }, { code: "42501" })).result).toEqual({ ok: false, message: "You do not have access to this action." });
    expect((await release(ready(), { acknowledgeMock: true }, { code: "XX000" })).result).toEqual({ ok: false, message: "Release could not be completed. Please try again." });
  });
});

describe("isStaleJob", () => {
  const MIN = 60_000;
  const now = Date.parse("2026-10-20T12:00:00Z");
  const at = (minutes: number) => new Date(now - minutes * MIN).toISOString();
  it("is stale only for an active job with no progress for ten minutes", () => {
    expect(isStaleJob({ status: "RUNNING", created_at: at(30), started_at: at(10) }, now)).toBe(true);
    expect(isStaleJob({ status: "RUNNING", created_at: at(30), started_at: at(9.9) }, now)).toBe(false);
    expect(isStaleJob({ status: "QUEUED", created_at: at(10) }, now)).toBe(true);
    expect(isStaleJob({ status: "QUEUED", created_at: at(5) }, now)).toBe(false);
    expect(STALE_JOB_AFTER_MS).toBe(10 * MIN);
  });
  it("is never stale when finished or when the time cannot be read", () => {
    expect(isStaleJob({ status: "SUCCEEDED", created_at: at(500) }, now)).toBe(false);
    expect(isStaleJob({ status: "FAILED", created_at: at(500) }, now)).toBe(false);
    expect(isStaleJob({ status: "RUNNING", created_at: null, started_at: null }, now)).toBe(false);
    expect(isStaleJob({ status: "RUNNING", created_at: "garbage" }, now)).toBe(false);
  });
});

describe("clearStaleJob: an abandoned job never blocks a project for ever, a slow one is never cut off", () => {
  const MIN = 60_000;
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
  const stuck = (jobPatch: Record<string, unknown> = {}) => {
    const fake = new FakeDb()
      .seed("projects", [project({ status: "GENERATING" })])
      .seed("generation_jobs", [
        { id: "old", project_id: PROJECT, status: "FAILED", created_at: ago(120), idempotency_key: "k-old-0123456789abcd" },
        { id: "j1", project_id: PROJECT, status: "RUNNING", created_at: ago(30), started_at: ago(25), idempotency_key: "k-j1-0123456789abcde", ...jobPatch },
      ])
      .seed("design_assets", [{ id: "own", project_id: PROJECT, generation_job_id: "j1", storage_path: `${PROJECT}/generated/own.png` }]);
    fake.defaults.generation_jobs = { status: "QUEUED", attempt_count: 0 };
    fake.defaults.design_assets = { is_released: false };
    fake.objects.set(`project-files/${PROJECT}/generated/own.png`, new Uint8Array([1]));
    return fake;
  };
  const clear = (fake: FakeDb, at = NOW, who: SupabaseClient = session()) => clearStaleJob(who, fake.client(), PROJECT, { now: () => at });

  it("clears an abandoned job: removes only its own files, marks it failed, frees the project and records who did it", async () => {
    const fake = stuck();
    fake.seed("design_assets", [{ id: "other", project_id: PROJECT, generation_job_id: "old", storage_path: `${PROJECT}/generated/other.png` }]);
    expect(await clear(fake)).toEqual({ ok: true });
    expect(fake.rows("generation_jobs").find((j) => j.id === "j1")).toMatchObject({ status: "FAILED", error_code: "STALE_ABANDONED" });
    expect(fake.rows("design_assets").map((a) => a.id)).toEqual(["other"]); // another attempt's file is left alone
    expect(fake.removals).toEqual([`${PROJECT}/generated/own.png`]);
    expect((fake.rows("projects")[0] as { status: string }).status).toBe("GENERATION_FAILED");
    expect(fake.rows("audit_events")).toMatchObject([{ actor_id: ADMIN, action: "generation.admin_cleared_stale", project_id: PROJECT }]);
    expect(fake.writes.some((w) => w.payload.is_released === true || w.payload.status === "RELEASED")).toBe(false);
  });

  it("refuses a job that may still be running, and writes nothing", async () => {
    const fake = stuck({ started_at: ago(9) });
    expect(await clear(fake)).toMatchObject({ ok: false, message: expect.stringContaining("may still be running") });
    expect(fake.writes).toHaveLength(0);
    expect(fake.removals).toHaveLength(0);
  });

  it("treats a queued job by when it was created", async () => {
    expect(await clear(stuck({ status: "QUEUED", started_at: null, created_at: ago(11) }))).toEqual({ ok: true });
    const fresh = stuck({ status: "QUEUED", started_at: null, created_at: ago(2) });
    expect(await clear(fresh)).toMatchObject({ ok: false });
    expect(fresh.writes).toHaveLength(0);
  });

  it("refuses anything that is not a single interrupted job in a generating project", async () => {
    const notGenerating = stuck();
    notGenerating.tables.projects[0].status = "READY_FOR_REVIEW";
    expect(await clear(notGenerating)).toMatchObject({ ok: false, message: expect.stringContaining("no interrupted generation") });

    const done = stuck({ status: "SUCCEEDED" });
    expect(await clear(done)).toMatchObject({ ok: false, message: expect.stringContaining("no single interrupted job") });

    const two = stuck();
    two.seed("generation_jobs", [{ id: "j3", project_id: PROJECT, status: "QUEUED", created_at: ago(40) }]);
    expect(await clear(two)).toMatchObject({ ok: false });
    for (const fake of [notGenerating, done, two]) expect(fake.writes).toHaveLength(0);

    expect(await clearStaleJob(session(), new FakeDb().client(), PROJECT, { now: () => NOW })).toMatchObject({ ok: false });
    expect(await clearStaleJob(session(), stuck().client(), "nope", { now: () => NOW })).toMatchObject({ ok: false });
  });

  it("is for administrators only", async () => {
    const fake = stuck();
    await expect(clear(fake, NOW, session({ admin: false }))).rejects.toMatchObject({ status: 403 });
    await expect(clear(fake, NOW, session({ signedIn: false }))).rejects.toBeInstanceOf(AuthError);
    expect(fake.writes).toHaveLength(0);
  });

  it("changes nothing when the audit event cannot be written", async () => {
    const fake = stuck();
    fake.failNext = { table: "audit_events", op: "insert" };
    expect(await clear(fake)).toMatchObject({ ok: false, message: expect.stringContaining("could not be recorded") });
    expect(fake.writes.map((w) => `${w.table}.${w.op}`)).toEqual(["audit_events.insert"]);
    expect(fake.rows("generation_jobs").find((j) => j.id === "j1")).toMatchObject({ status: "RUNNING" });
    expect(fake.rows("design_assets").map((a) => a.id)).toEqual(["own"]);
    expect(fake.objects.has(`project-files/${PROJECT}/generated/own.png`)).toBe(true);
    expect(fake.removals).toHaveLength(0);
    expect((fake.rows("projects")[0] as { status: string }).status).toBe("GENERATING");
  });

  it("flags incomplete cleanup but still frees the project", async () => {
    const fake = stuck();
    fake.failNext = { table: "design_assets", op: "delete" };
    expect(await clear(fake)).toEqual({ ok: true });
    expect(fake.rows("generation_jobs").find((j) => j.id === "j1")?.error_summary).toContain("Cleanup incomplete");
    expect((fake.rows("projects")[0] as { status: string }).status).toBe("GENERATION_FAILED");
    // the leftover blocks a new run, so it cannot be published
    expect(await startGeneration(session(), fake.client(), { projectId: PROJECT, idempotencyKey: KEY }, { provider: createMockImageProvider(), env: {} })).toMatchObject({ ok: false, code: "not_eligible" });
  });

  it("makes generation possible again, with a new key and no provider call from the clearing itself", async () => {
    const fake = stuck();
    const spy = spyProvider();
    expect(await clear(fake)).toEqual({ ok: true });
    expect(spy.calls).toHaveLength(0);
    expect(await startGeneration(session(), fake.client(), { projectId: PROJECT, idempotencyKey: KEY2 }, { provider: spy.provider, env: {} })).toMatchObject({ ok: true });
    expect(spy.calls).toHaveLength(1);
    expect((fake.rows("projects")[0] as { status: string }).status).toBe("READY_FOR_REVIEW");
  });
});

describe("a request cleared as stale that is still running cannot corrupt a newer run", () => {
  /** A mock provider held at a gate: `reached` resolves once it is called, `open()` lets it answer. */
  function gatedProvider() {
    const base = createMockImageProvider();
    let open!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const provider: ImageGenerationProvider = {
      ...base,
      generate: async (request, hooks) => {
        entered();
        await gate;
        return base.generate(request, hooks);
      },
    };
    return { provider, open, reached };
  }
  // The clearing runs on a simulated clock eleven minutes ahead; nothing waits for real.
  const later = () => Date.now() + 11 * 60_000;
  const projectMoves = () => db.writes.filter((w) => w.table === "projects").map((w) => w.payload.status);

  /** Starts a request, parks it inside the provider, and clears its job as stale. */
  async function startAndAbandon() {
    const old = gatedProvider();
    const run = start(old.provider, KEY);
    await old.reached;
    expect(await clearStaleJob(session(), db.client(), PROJECT, { now: later })).toEqual({ ok: true });
    expect(projectStatus()).toBe("GENERATION_FAILED");
    const oldJobId = jobs()[0].id;
    return { old, run, oldJobId };
  }

  function expectOnlyTheNewerRun(newerJobId: string, oldJobId: string) {
    expect(projectStatus()).toBe("READY_FOR_REVIEW");
    expect(jobs().find((j) => j.id === oldJobId)).toMatchObject({ status: "FAILED", error_code: "STALE_ABANDONED" });
    expect(jobs().find((j) => j.id === newerJobId)).toMatchObject({ status: "SUCCEEDED" });
    const assets = row("design_assets") as { generation_job_id: string; storage_path: string; is_released: boolean }[];
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.generation_job_id === newerJobId && a.is_released === false)).toBe(true);
    // the late request uploaded its own files and removed them again; only the newer run's remain
    expect([...db.objects.keys()].sort()).toEqual(assets.map((a) => `project-files/${a.storage_path}`).sort());
    expect(db.uploads).toHaveLength(4);
    expect(db.writes.some((w) => w.payload.is_released === true || w.payload.status === "RELEASED")).toBe(false);
    expect(db.rpcCalls.some((c) => c.name === "admin_release_project")).toBe(false);
  }

  it("when the newer run has already finished: the late request fails and moves nothing", async () => {
    const { old, run, oldJobId } = await startAndAbandon();
    const newer = await start(spyProvider().provider, KEY2);
    expect(newer).toMatchObject({ ok: true, replayed: false });

    old.open();
    expect(await run).toMatchObject({ ok: false, code: "failed" });

    if (!newer.ok) throw new Error("the newer run should have succeeded");
    expectOnlyTheNewerRun(newer.jobId, oldJobId);
    // claim, clear, newer claim, newer finish: the late request attempted no project move at all
    expect(projectMoves()).toEqual(["GENERATING", "GENERATION_FAILED", "GENERATING", "READY_FOR_REVIEW"]);
  });

  it("when the newer run is still in progress: the late request leaves its project GENERATING and the newer run completes", async () => {
    const { old, run, oldJobId } = await startAndAbandon();
    const next = gatedProvider();
    const newerRun = start(next.provider, KEY2);
    await next.reached;
    expect(projectStatus()).toBe("GENERATING");

    old.open();
    expect(await run).toMatchObject({ ok: false, code: "failed" });
    expect(projectStatus()).toBe("GENERATING"); // not knocked into GENERATION_FAILED under the newer run
    expect(row("design_assets")).toHaveLength(0); // the late request removed what it wrote

    next.open();
    const newer = await newerRun;
    expect(newer).toMatchObject({ ok: true, replayed: false });
    if (!newer.ok) throw new Error("the newer run should have succeeded");
    expectOnlyTheNewerRun(newer.jobId, oldJobId);
    expect(projectMoves()).toEqual(["GENERATING", "GENERATION_FAILED", "GENERATING", "READY_FOR_REVIEW"]);
  });
});
