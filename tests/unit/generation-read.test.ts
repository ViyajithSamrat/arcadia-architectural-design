import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { describeGeneration, getCustomerResults, getGenerationDetail, listGenerationQueue, type PhaseInput } from "@/lib/generation/read";
import type { ProjectStatus } from "@/lib/db/schema";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const P2 = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const input = (patch: Partial<PhaseInput>): PhaseInput => ({ status: "PAYMENT_VERIFIED", updatedAt: ago(0), jobs: [], assets: [], now: NOW, ...patch });
const job = (id: string, status: string, patch: Record<string, unknown> = {}) => ({ id, project_id: P1, status, provider: "mock", prompt_version: "image-prompt-1", attempt_count: 1, error_code: null, error_summary: null, created_at: ago(30 * MIN), started_at: ago(29 * MIN), completed_at: null, duration_ms: null, usage_json: { mock: true }, ...patch });
const asset = (id: string, jobId: string | null, patch: Record<string, unknown> = {}) => ({ id, project_id: P1, generation_job_id: jobId, asset_type: "EXTERIOR_CONCEPT", width: 640, height: 360, is_released: false, storage_path: `${P1}/generated/${id}.png`, created_at: ago(20 * MIN), ...patch });
const project = (patch: Record<string, unknown> = {}) => ({ id: P1, customer_id: ME, project_type: "EMPTY_PLOT", status: "READY_FOR_REVIEW", created_at: ago(60 * MIN), updated_at: ago(5 * MIN), ...patch });

describe("describeGeneration: which step the screen offers", () => {
  const cases: [string, Partial<PhaseInput>, string][] = [
    ["payment verified, nothing yet", {}, "can_start"],
    ["a failed attempt that left nothing", { status: "GENERATION_FAILED", jobs: [{ id: "j", status: "FAILED", created_at: ago(MIN) }] }, "can_start"],
    ["a failed attempt that left a file", { status: "GENERATION_FAILED", jobs: [{ id: "j", status: "FAILED", created_at: ago(MIN) }], assets: [{ generation_job_id: "j" }] }, "blocked_leftovers"],
    ["just claimed, no job", { status: "GENERATING", updatedAt: ago(10_000) }, "starting"],
    ["claimed long ago, no job", { status: "GENERATING", updatedAt: ago(5 * MIN) }, "can_resume"],
    ["claimed with an unreadable time", { status: "GENERATING", updatedAt: null }, "starting"],
    ["a running job", { status: "GENERATING", jobs: [{ id: "j", status: "RUNNING", created_at: ago(2 * MIN), started_at: ago(2 * MIN) }] }, "running"],
    ["a running job for ten minutes", { status: "GENERATING", jobs: [{ id: "j", status: "RUNNING", created_at: ago(11 * MIN), started_at: ago(10 * MIN) }] }, "stale_job"],
    ["a queued job for eleven minutes", { status: "GENERATING", jobs: [{ id: "j", status: "QUEUED", created_at: ago(11 * MIN) }] }, "stale_job"],
    ["a succeeded job but the project was not advanced", { status: "GENERATING", jobs: [{ id: "j", status: "SUCCEEDED", created_at: ago(MIN) }] }, "can_finalize"],
    ["ready for review", { status: "READY_FOR_REVIEW", jobs: [{ id: "j", status: "SUCCEEDED", created_at: ago(MIN) }], assets: [{ generation_job_id: "j" }] }, "ready_for_review"],
    ["released", { status: "RELEASED" }, "released"],
    ["before payment", { status: "AWAITING_PAYMENT" }, "not_ready"],
    ["cancelled", { status: "CANCELLED" }, "not_ready"],
  ];
  it.each(cases)("%s", (_name, patch, phase) => {
    expect(describeGeneration(input(patch)).phase).toBe(phase);
  });

  it("names every reason a release is blocked", () => {
    const ok = describeGeneration(input({ status: "READY_FOR_REVIEW", jobs: [{ id: "j", status: "SUCCEEDED", created_at: ago(MIN) }], assets: [{ generation_job_id: "j" }] }));
    expect(ok.releaseBlockers).toEqual([]);
    const leftover = describeGeneration(input({ status: "READY_FOR_REVIEW", jobs: [{ id: "j", status: "SUCCEEDED", created_at: ago(MIN) }, { id: "k", status: "FAILED", created_at: ago(MIN) }], assets: [{ generation_job_id: "j" }, { generation_job_id: "k" }] }));
    expect(leftover.releaseBlockers).toEqual(["Files from a failed or unfinished attempt are still attached to this project."]);
    const empty = describeGeneration(input({ status: "READY_FOR_REVIEW" }));
    expect(empty.releaseBlockers).toEqual(["There are no generated files to release."]);
    const running = describeGeneration(input({ status: "READY_FOR_REVIEW", jobs: [{ id: "j", status: "SUCCEEDED", created_at: ago(MIN) }, { id: "k", status: "RUNNING", created_at: ago(MIN) }], assets: [{ generation_job_id: "j" }] }));
    expect(running.releaseBlockers).toEqual(["A generation job is still running."]);
  });
});

describe("listGenerationQueue", () => {
  it("lists paid-or-later projects with their phase, in three reads however many there are", async () => {
    const db = new FakeDb()
      .seed("projects", [project({ id: P1 }), project({ id: P2, status: "PAYMENT_VERIFIED", updated_at: ago(10 * MIN) }), project({ id: "55555555-5555-4555-8555-555555555555", status: "AWAITING_PAYMENT" })])
      .seed("generation_jobs", [job("j1", "SUCCEEDED")])
      .seed("design_assets", [asset("a1", "j1")]);
    const real = db.client();
    let reads = 0;
    const counted = new Proxy(real, { get: (t, p, r) => (p === "from" ? (table: string) => (reads++, (t.from as (x: string) => unknown)(table)) : Reflect.get(t, p, r)) }) as SupabaseClient;
    const rows = await listGenerationQueue(counted, NOW);
    expect(reads).toBe(3);
    expect(rows.map((r) => [r.projectId, r.phase, r.jobCount, r.assetCount])).toEqual([
      [P1, "ready_for_review", 1, 1],
      [P2, "can_start", 0, 0],
    ]);
    expect(JSON.stringify(rows)).not.toContain("/generated/");
  });

  it("returns an empty list on an empty or failing read", async () => {
    expect(await listGenerationQueue(new FakeDb().client(), NOW)).toEqual([]);
  });
});

describe("getGenerationDetail", () => {
  const seeded = () =>
    new FakeDb()
      .seed("projects", [project()])
      .seed("generation_jobs", [job("j0", "FAILED", { created_at: ago(50 * MIN), error_code: "STORAGE_FAILED", error_summary: "Failed." }), job("j1", "SUCCEEDED")])
      .seed("design_assets", [asset("leftover", "j0"), asset("a1", "j1"), asset("a2", "j1", { asset_type: "INTERIOR_CONCEPT" })]);

  it("previews only files of the succeeded job, counts the others, and never returns a storage path", async () => {
    const db = seeded();
    const detail = await getGenerationDetail(db.client(), P1, NOW);
    expect(detail).not.toBeNull();
    expect(detail!.previews.map((p) => p.id)).toEqual(["a1", "a2"]);
    expect(detail!.previews.every((p) => p.url?.startsWith("https://signed.test/") && p.released === false)).toBe(true);
    expect(detail!.leftoverCount).toBe(1);
    expect(detail!.mock).toBe(true);
    expect(detail!.phase).toBe("ready_for_review");
    expect(detail!.releaseBlockers).toEqual(["Files from a failed or unfinished attempt are still attached to this project."]);
    expect(db.signed.map((s) => s.seconds)).toEqual([60, 60]);
    expect(db.signed.some((s) => s.path.includes("leftover"))).toBe(false);
    // the object path appears only inside the signed link (the fake embeds it), never as a field
    expect(Object.keys(detail!.previews[0]).sort()).toEqual(["height", "id", "label", "released", "url", "width"]);
    expect(JSON.stringify({ ...detail, previews: [] })).not.toMatch(/generated|storage/);
  });

  it.each(["GENERATING", "GENERATION_FAILED", "PAYMENT_VERIFIED"] as ProjectStatus[])("creates no preview link while the project is %s", async (status) => {
    const db = seeded();
    db.tables.projects[0].status = status;
    const detail = await getGenerationDetail(db.client(), P1, NOW);
    expect(db.signed).toHaveLength(0);
    expect(detail!.previews.every((p) => p.url === null)).toBe(true);
  });

  it("shows failed attempts with only safe text", async () => {
    const detail = await getGenerationDetail(seeded().client(), P1, NOW);
    expect(detail!.jobs.map((j) => [j.status, j.errorCode, j.mock])).toEqual([["FAILED", "STORAGE_FAILED", true], ["SUCCEEDED", null, true]]);
  });

  it("returns null for an unknown or malformed project", async () => {
    expect(await getGenerationDetail(seeded().client(), "nope", NOW)).toBeNull();
    expect(await getGenerationDetail(new FakeDb().client(), P2, NOW)).toBeNull();
  });
});

describe("getCustomerResults: nothing before release, only the owner after", () => {
  const released = () =>
    new FakeDb()
      .seed("projects", [project({ status: "RELEASED" })])
      .seed("design_assets", [
        asset("r1", "j1", { is_released: true }),
        asset("r2", "j1", { is_released: true, asset_type: "INTERIOR_CONCEPT" }),
        asset("u1", "j2", { is_released: false }),
        asset("ref", null, { asset_type: "REFERENCE", is_released: false }),
      ]);

  it("tells a stranger the project does not exist, and reads no file", async () => {
    const db = released();
    expect(await getCustomerResults(db.client(), OTHER, P1)).toEqual({ state: "not_found" });
    expect(await getCustomerResults(db.client(), ME, "11111111-0000-4000-8000-000000000000")).toEqual({ state: "not_found" });
    expect(db.signed).toHaveLength(0);
  });

  it.each(["PAYMENT_VERIFIED", "GENERATING", "GENERATION_FAILED", "READY_FOR_REVIEW", "AWAITING_PAYMENT"] as ProjectStatus[])(
    "returns only the status while the project is %s: no asset, path or link",
    async (status) => {
      const db = released();
      db.tables.projects[0].status = status;
      const result = await getCustomerResults(db.client(), ME, P1);
      expect(result).toEqual({ state: "pending", status });
      expect(db.signed).toHaveLength(0);
      expect(JSON.stringify(result)).not.toMatch(/generated|signed|https/);
    },
  );

  it("after release lists only released generated assets, with short-lived links and no storage path", async () => {
    const db = released();
    const result = await getCustomerResults(db.client(), ME, P1);
    expect(result.state).toBe("released");
    if (result.state !== "released") return;
    expect(result.assets.map((a) => a.id)).toEqual(["r1", "r2"]);
    expect(result.assets.map((a) => a.label)).toEqual(["Exterior concept", "Interior concept"]);
    expect(result.unavailable).toBe(0);
    expect(db.signed.map((s) => s.seconds)).toEqual([300, 300]);
    expect(JSON.stringify(result)).not.toContain("storage_path");
    // the object path appears only inside the signed URL, never as a field of its own
    expect(Object.keys(result.assets[0]).sort()).toEqual(["height", "id", "label", "url", "width"]);
    expect(result.assets.every((a) => a.url.startsWith("https://signed.test/"))).toBe(true);
  });

  it("reports images it could not link instead of showing broken pictures", async () => {
    const db = released();
    const real = db.client();
    const failing = {
      ...real,
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "nope" } }) }) },
    } as unknown as SupabaseClient;
    // the fixture project has no saved answers, so its layout sketch is unavailable
    expect(await getCustomerResults(failing, ME, P1)).toEqual({ state: "released", assets: [], unavailable: 2, floorPlan: { state: "unavailable" } });
  });
});

/** Complete empty-plot answers, as the journey saves them. */
const ANSWERS = {
  schemaVersion: 1,
  space: { plotWidth: 30, plotLength: 40, unit: "ft", orientation: "E", floors: 2, location: "Chennai" },
  rooms: { bedrooms: 3, bathrooms: 2, parkingSpaces: 1, spaces: ["living", "kitchen"] },
  preferences: { style: "modern", budgetBand: "standard", vastu: "undecided", exteriorViews: 1, interiorViews: 1, frontGarden: false },
  description: {},
};

describe("the empty-plot layout sketch follows the image rules", () => {
  const db = (patch: Record<string, unknown>) =>
    new FakeDb()
      .seed("projects", [project({ requirements_json: ANSWERS, ...patch })])
      .seed("generation_jobs", [job("j1", "SUCCEEDED")])
      .seed("design_assets", [asset("a1", "j1", { is_released: patch.status === "RELEASED" })]);

  it.each(["READY_FOR_REVIEW", "RELEASED"] as ProjectStatus[])("is drawn for the administrator while the project is %s", async (status) => {
    const detail = await getGenerationDetail(db({ status }).client(), P1, NOW);
    expect(detail!.floorPlan?.state).toBe("ready");
  });

  it.each(["PAYMENT_VERIFIED", "GENERATING", "GENERATION_FAILED"] as ProjectStatus[])("is not drawn for the administrator while the project is %s", async (status) => {
    const detail = await getGenerationDetail(db({ status }).client(), P1, NOW);
    expect(detail!.floorPlan).toBeNull();
  });

  it("does not exist for interior and landscape projects", async () => {
    for (const project_type of ["INTERIOR", "LANDSCAPE"]) {
      expect((await getGenerationDetail(db({ project_type }).client(), P1, NOW))!.floorPlan).toBeNull();
      const result = await getCustomerResults(db({ project_type, status: "RELEASED" }).client(), ME, P1);
      expect(result.state === "released" && result.floorPlan).toBeNull();
    }
  });

  it("reaches the owner only once the project is RELEASED", async () => {
    const released = await getCustomerResults(db({ status: "RELEASED" }).client(), ME, P1);
    expect(released.state).toBe("released");
    if (released.state !== "released") return;
    expect(released.floorPlan?.state).toBe("ready");
    if (released.floorPlan?.state !== "ready") return;
    expect(released.floorPlan.floors).toHaveLength(2);
    expect(JSON.stringify(released.floorPlan)).not.toMatch(/storage_path|signed\.test|Chennai/);
  });

  it.each(["PAYMENT_VERIFIED", "GENERATING", "GENERATION_FAILED", "READY_FOR_REVIEW", "AWAITING_PAYMENT"] as ProjectStatus[])(
    "gives the owner nothing about the sketch while the project is %s",
    async (status) => {
      const result = await getCustomerResults(db({ status }).client(), ME, P1);
      expect(result).toEqual({ state: "pending", status });
      expect(JSON.stringify(result)).not.toMatch(/svg|floorPlan/i);
    },
  );

  it("gives another customer nothing, even after release", async () => {
    expect(await getCustomerResults(db({ status: "RELEASED" }).client(), OTHER, P1)).toEqual({ state: "not_found" });
  });
});
