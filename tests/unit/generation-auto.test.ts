import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoGenerationKey, AUTO_KICK_AFTER_MS, isAutoReleaseEnabled, reconcileGeneration, startAutomaticGeneration } from "@/lib/generation/auto";
import { mockBriefProvider } from "@/lib/journeys/brief";
import type { ImageGenerationProvider } from "@/lib/providers/images";
import { ProviderError } from "@/lib/providers/interfaces";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { FakeDb } from "./support/fake-supabase";
import { REQUIREMENTS } from "./support/journey-fixtures";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const PAYMENT = "44444444-4444-4444-8444-444444444444";
const VERIFIED_AT = Date.parse("2026-11-01T10:00:00Z");

let db: FakeDb;
let brief: unknown;

/** A stand-in for a real (non-placeholder) provider: the mock's valid images, labelled as live output. */
function liveProvider(over: Partial<ImageGenerationProvider> = {}) {
  const base = createMockImageProvider();
  const calls: unknown[] = [];
  const provider: ImageGenerationProvider = {
    ...base,
    id: "openrouter",
    mock: false,
    ...over,
    generate: async (request, hooks) => {
      calls.push(request);
      if (over.generate) return over.generate(request, hooks);
      const out = await base.generate(request, hooks);
      return { ...out, provider: "openrouter", mock: false };
    },
  };
  return { provider, calls };
}

const mockProvider = () => {
  const base = createMockImageProvider();
  const calls: unknown[] = [];
  return { provider: { ...base, generate: async (r: Parameters<typeof base.generate>[0]) => (calls.push(r), base.generate(r)) } as ImageGenerationProvider, calls };
};

const deps = (provider: ImageGenerationProvider, env: Record<string, string | undefined> = {}, now = VERIFIED_AT + 60_000) => ({ provider, env, newRequestId: () => "req-test", now: () => now });
const run = (provider: ImageGenerationProvider, env: Record<string, string | undefined> = {}) => startAutomaticGeneration(db.client(), { projectId: PROJECT, actorId: ADMIN }, deps(provider, env));

const row = (table: string) => db.rows(table);
const status = () => (row("projects").find((r) => r.id === PROJECT) as { status: string }).status;
const jobs = () => row("generation_jobs") as { status: string; provider: string; idempotency_key: string }[];
const releaseCalls = () => db.rpcCalls.filter((c) => c.name === "system_release_project");

/** The database function, as far as the fake can model it: READY_FOR_REVIEW -> RELEASED once, else P0002. */
function installRelease(refuse?: { code: string }) {
  db.rpcHandlers.system_release_project = (args) => {
    const p = db.rows("projects").find((r) => r.id === args.p_project_id) as { status: string } | undefined;
    if (refuse) return { error: { code: refuse.code, message: "refused" } };
    if (!p || p.status !== "READY_FOR_REVIEW") return { error: { code: "P0002", message: "not ready" } };
    p.status = "RELEASED";
    return { data: p };
  };
}

beforeEach(async () => {
  brief = await mockBriefProvider.generate({ projectType: "EMPTY_PLOT", sourceLanguage: "en", requirements: REQUIREMENTS.EMPTY_PLOT });
  db = new FakeDb().seed("projects", [
    { id: PROJECT, customer_id: CUSTOMER, status: "PAYMENT_VERIFIED", project_type: "EMPTY_PLOT", english_brief_json: brief, english_brief_text: "Approved brief.", updated_at: new Date(VERIFIED_AT).toISOString() },
  ]);
  db.seed("payments", [{ id: PAYMENT, project_id: PROJECT, status: "VERIFIED", verified_at: new Date(VERIFIED_AT).toISOString() }]);
  db.defaults.generation_jobs = { status: "QUEUED", attempt_count: 0 };
  db.defaults.design_assets = { is_released: false };
  installRelease();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the key and the setting", () => {
  it("derives the idempotency key from the verified payment, in the length the service accepts", () => {
    expect(autoGenerationKey(PAYMENT)).toBe(`auto-${PAYMENT}`);
    expect(autoGenerationKey(PAYMENT)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
  it("releases automatically unless GENERATION_AUTO_RELEASE is false", () => {
    expect(isAutoReleaseEnabled({})).toBe(true);
    expect(isAutoReleaseEnabled({ GENERATION_AUTO_RELEASE: "true" })).toBe(true);
    expect(isAutoReleaseEnabled({ GENERATION_AUTO_RELEASE: " FALSE " })).toBe(false);
  });
});

describe("startAutomaticGeneration: a verified payment starts exactly one generation", () => {
  it("runs the provider once, keys the job to the payment, records the verifying administrator and releases real output", async () => {
    const { provider, calls } = liveProvider();
    const outcome = await run(provider);
    expect(outcome).toMatchObject({ state: "released" });
    expect(calls).toHaveLength(1);
    expect(jobs()).toEqual([expect.objectContaining({ status: "SUCCEEDED", provider: "openrouter", idempotency_key: autoGenerationKey(PAYMENT) })]);
    expect(status()).toBe("RELEASED");
    expect(row("audit_events")).toMatchObject([{ actor_id: ADMIN, action: "generation.auto_started", project_id: PROJECT }]);
    expect(releaseCalls()).toHaveLength(1);
  });

  it("repeated and concurrent triggers never run the provider twice or create a second job", async () => {
    const { provider, calls } = liveProvider();
    const results = await Promise.all([run(provider), run(provider), run(provider)]);
    await run(provider);
    await run(provider);
    expect(calls).toHaveLength(1);
    expect(jobs()).toHaveLength(1);
    expect(status()).toBe("RELEASED");
    expect(results.filter((r) => r.state === "released").length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => ["released", "running"].includes(r.state))).toBe(true);
  });

  it("creates no job and calls no provider when no payment is verified", async () => {
    db.tables.payments = [{ id: PAYMENT, project_id: PROJECT, status: "PENDING_REVIEW" }];
    const { provider, calls } = liveProvider();
    expect(await run(provider)).toMatchObject({ state: "not_started", code: "not_eligible" });
    expect(calls).toHaveLength(0);
    expect(jobs()).toHaveLength(0);
    expect(status()).toBe("PAYMENT_VERIFIED");
    expect(db.writes).toHaveLength(0);
  });

  it("creates nothing for a project that is not awaiting generation", async () => {
    (row("projects")[0] as { status: string }).status = "PAYMENT_PROOF_SUBMITTED";
    const { provider, calls } = liveProvider();
    expect(await run(provider)).toMatchObject({ state: "not_started", code: "not_eligible" });
    expect(calls).toHaveLength(0);
    expect(jobs()).toHaveLength(0);
  });

  it("refuses a malformed project id without touching anything", async () => {
    const { provider, calls } = liveProvider();
    expect(await startAutomaticGeneration(db.client(), { projectId: "x; drop table projects", actorId: null }, deps(provider))).toMatchObject({ state: "not_started", code: "bad_request" });
    expect(calls).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });
});

describe("startAutomaticGeneration: release rules", () => {
  it("never auto-releases placeholder output: it waits for an administrator", async () => {
    const { provider } = mockProvider();
    expect(await run(provider)).toMatchObject({ state: "awaiting_review", reason: "placeholder" });
    expect(status()).toBe("READY_FOR_REVIEW");
    expect(releaseCalls()).toHaveLength(0);
    expect(row("design_assets").every((a) => (a as { is_released: boolean }).is_released === false)).toBe(true);
  });

  it("keeps real output for review when automatic release is switched off", async () => {
    const { provider } = liveProvider();
    expect(await run(provider, { GENERATION_AUTO_RELEASE: "false" })).toMatchObject({ state: "awaiting_review", reason: "auto_release_off" });
    expect(status()).toBe("READY_FOR_REVIEW");
    expect(releaseCalls()).toHaveLength(0);
  });

  it("leaves the project for review when the database refuses the release, and reports nothing as released", async () => {
    installRelease({ code: "23514" });
    const { provider } = liveProvider();
    expect(await run(provider)).toMatchObject({ state: "awaiting_review", reason: "release_blocked" });
    expect(status()).toBe("READY_FOR_REVIEW");
  });

  it("a later trigger finishes a release that did not happen, without running the provider again", async () => {
    installRelease({ code: "23514" });
    const { provider, calls } = liveProvider();
    await run(provider);
    installRelease();
    expect(await run(provider)).toMatchObject({ state: "released" });
    expect(calls).toHaveLength(1);
    expect(status()).toBe("RELEASED");
  });
});

describe("startAutomaticGeneration: failures are visible and safely retryable", () => {
  it("marks the project GENERATION_FAILED, releases nothing, and does not repeat the failed provider call on a re-trigger", async () => {
    const failing = liveProvider({ generate: async () => { throw new ProviderError("server", "x"); } });
    expect(await run(failing.provider)).toMatchObject({ state: "failed" });
    expect(status()).toBe("GENERATION_FAILED");
    expect(jobs()).toEqual([expect.objectContaining({ status: "FAILED" })]);
    expect(releaseCalls()).toHaveLength(0);
    expect(row("design_assets")).toHaveLength(0);

    expect(await run(failing.provider)).toMatchObject({ state: "failed" });
    expect(failing.calls).toHaveLength(1);
    expect(jobs()).toHaveLength(1);
  });

  it("reports a provider that is not available without claiming the project or creating a job", async () => {
    const outcome = await startAutomaticGeneration(db.client(), { projectId: PROJECT, actorId: ADMIN }, { env: { PROVIDER_MODE: "live" }, now: () => VERIFIED_AT + 60_000 });
    expect(outcome).toMatchObject({ state: "not_started", code: "provider_unavailable" });
    expect(status()).toBe("PAYMENT_VERIFIED");
    expect(jobs()).toHaveLength(0);
  });
});

describe("reconcileGeneration: the safety net behind the status poll", () => {
  const reconcile = (provider: ImageGenerationProvider, now: number, env: Record<string, string | undefined> = {}) => reconcileGeneration(db.client(), PROJECT, deps(provider, env, now));

  it("leaves a project alone while the run that follows the decision is probably still starting", async () => {
    const { provider, calls } = liveProvider();
    expect(await reconcile(provider, VERIFIED_AT + AUTO_KICK_AFTER_MS - 1)).toEqual({ state: "idle" });
    expect(calls).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  it("starts generation for a verified project that nothing picked up", async () => {
    const { provider, calls } = liveProvider();
    expect(await reconcile(provider, VERIFIED_AT + AUTO_KICK_AFTER_MS + 1)).toMatchObject({ state: "released" });
    expect(calls).toHaveLength(1);
    expect(row("audit_events")).toMatchObject([{ actor_id: null, action: "generation.auto_started" }]);
  });

  it("finishes the release of a project whose job already succeeded", async () => {
    installRelease({ code: "23514" });
    const { provider, calls } = liveProvider();
    await run(provider);
    installRelease();
    expect(await reconcile(provider, VERIFIED_AT + 120_000)).toMatchObject({ state: "released" });
    expect(calls).toHaveLength(1);
  });

  it.each(["DRAFT", "AWAITING_PAYMENT", "PAYMENT_PROOF_SUBMITTED", "GENERATING", "GENERATION_FAILED", "RELEASED", "CANCELLED"])("does nothing for a project in %s", async (state) => {
    (row("projects")[0] as { status: string }).status = state;
    const { provider, calls } = liveProvider();
    expect(await reconcile(provider, VERIFIED_AT + 600_000)).toEqual({ state: "idle" });
    expect(calls).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  it("does nothing for an unknown project or a malformed id", async () => {
    const { provider } = liveProvider();
    expect(await reconcileGeneration(db.client(), "55555555-5555-4555-8555-555555555555", deps(provider))).toEqual({ state: "idle" });
    expect(await reconcileGeneration(db.client(), "nope", deps(provider))).toEqual({ state: "idle" });
  });
});
