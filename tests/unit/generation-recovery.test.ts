import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";
import { removeLeftoverFiles, startGeneration } from "@/lib/generation/service";
import { mockBriefProvider } from "@/lib/journeys/brief";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { FakeDb } from "./support/fake-supabase";
import { REQUIREMENTS } from "./support/journey-fixtures";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const KEY = "key-0123456789abcdef";
const folder = `project-files/${PROJECT}/generated`;

const session = (opts: { admin?: boolean } = {}) =>
  ({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
    rpc: async (name: string) => (name === "is_admin" ? { data: opts.admin !== false, error: null } : { data: null, error: { message: "unexpected" } }),
  }) as unknown as SupabaseClient;

let db: FakeDb;
const rows = (t: string) => db.rows(t);
const auditActions = () => rows("audit_events").map((r) => r.action);

function seedLeftoverScenario(status = "GENERATION_FAILED") {
  db = new FakeDb()
    .seed("projects", [{ id: PROJECT, customer_id: CUSTOMER, status, project_type: "EMPTY_PLOT" }])
    .seed("generation_jobs", [
      { id: "failed", project_id: PROJECT, status: "FAILED", provider: "mock" },
      { id: "good", project_id: PROJECT, status: "SUCCEEDED", provider: "mock" },
    ])
    .seed("design_assets", [
      { id: "bad-row", project_id: PROJECT, generation_job_id: "failed", storage_path: `${PROJECT}/generated/bad.png`, is_released: false },
      { id: "good-row", project_id: PROJECT, generation_job_id: "good", storage_path: `${PROJECT}/generated/good.png`, is_released: false },
    ]);
  for (const name of ["bad.png", "good.png", "orphan.png"]) db.objects.set(`${folder}/${name}`, new Uint8Array([1]));
}

describe("removeLeftoverFiles", () => {
  beforeEach(() => seedLeftoverScenario());

  it("removes files of a failed attempt and unreferenced objects, keeps a succeeded job's files, and audits first", async () => {
    const result = await removeLeftoverFiles(session(), db.client(), PROJECT);
    expect(result).toEqual({ ok: true, removedRows: 1, removedOrphans: 1 });
    expect(rows("design_assets").map((r) => r.id)).toEqual(["good-row"]);
    expect([...db.objects.keys()]).toEqual([`${folder}/good.png`]);
    expect(auditActions()).toEqual(["generation.admin_cleared_leftovers"]);
    expect(rows("audit_events")[0]).toMatchObject({ actor_id: ADMIN, project_id: PROJECT, metadata_json: { rows: 1, orphans: 1 } });
    expect(db.writes[0].table).toBe("audit_events"); // the audit event is the first write
  });

  it("is administrator-only and changes nothing for anyone else", async () => {
    await expect(removeLeftoverFiles(session({ admin: false }), db.client(), PROJECT)).rejects.toMatchObject({ status: 403 });
    expect(rows("design_assets")).toHaveLength(2);
    expect(db.removals).toHaveLength(0);
  });

  it.each(["RELEASED", "GENERATING", "BRIEF_APPROVED"])("refuses while the project is %s", async (status) => {
    seedLeftoverScenario(status);
    expect(await removeLeftoverFiles(session(), db.client(), PROJECT)).toMatchObject({ ok: false });
    expect(rows("design_assets")).toHaveLength(2);
    expect(db.removals).toHaveLength(0);
  });

  it.each(["QUEUED", "RUNNING"])("refuses while a job is %s (an object in flight would look like an orphan)", async (status) => {
    db.seed("generation_jobs", [{ id: "live", project_id: PROJECT, status, provider: "mock" }]);
    expect(await removeLeftoverFiles(session(), db.client(), PROJECT)).toMatchObject({ ok: false, message: expect.stringContaining("still running") });
    expect(db.removals).toHaveLength(0);
    expect(rows("design_assets")).toHaveLength(2);
  });

  it("changes nothing when the audit event cannot be written", async () => {
    db.failNext = { table: "audit_events", op: "insert" };
    expect(await removeLeftoverFiles(session(), db.client(), PROJECT)).toMatchObject({ ok: false, message: expect.stringContaining("nothing was changed") });
    expect(db.removals).toHaveLength(0);
    expect(rows("design_assets")).toHaveLength(2);
  });

  it("keeps the records when the stored files cannot be removed, so it can be tried again", async () => {
    db.failRemove = true;
    expect(await removeLeftoverFiles(session(), db.client(), PROJECT)).toMatchObject({ ok: false });
    expect(rows("design_assets")).toHaveLength(2);
    db.failRemove = false;
    expect(await removeLeftoverFiles(session(), db.client(), PROJECT)).toEqual({ ok: true, removedRows: 1, removedOrphans: 1 });
  });

  it("changes nothing when the files cannot be listed", async () => {
    db.failList = true;
    expect(await removeLeftoverFiles(session(), db.client(), PROJECT)).toMatchObject({ ok: false });
    expect(db.removals).toHaveLength(0);
    expect(rows("audit_events")).toHaveLength(0);
  });

  it("reports nothing to do when everything belongs to a succeeded job", async () => {
    db.tables.design_assets = rows("design_assets").filter((r) => r.id === "good-row");
    db.objects.delete(`${folder}/bad.png`);
    db.objects.delete(`${folder}/orphan.png`);
    expect(await removeLeftoverFiles(session(), db.client(), PROJECT)).toEqual({ ok: true, removedRows: 0, removedOrphans: 0 });
    expect(rows("audit_events")).toHaveLength(0);
  });
});

describe("cleanup order after a failed run", () => {
  let brief: unknown;
  beforeEach(async () => {
    brief = await mockBriefProvider.generate({ projectType: "EMPTY_PLOT", sourceLanguage: "en", requirements: REQUIREMENTS.EMPTY_PLOT });
    db = new FakeDb().seed("projects", [{ id: PROJECT, customer_id: CUSTOMER, status: "PAYMENT_VERIFIED", project_type: "EMPTY_PLOT", english_brief_json: brief, english_brief_text: "Approved brief." }]);
    db.defaults.generation_jobs = { status: "QUEUED", attempt_count: 0 };
    db.defaults.design_assets = { is_released: false };
  });

  /** The second asset row is refused by insert_generated_asset, as a late write or a database error would. */
  const failSecondAsset = () => {
    db.failAssetInsertAt = 2;
    return db.client();
  };

  it("removes the stored files and then the records when everything works", async () => {
    const result = await startGeneration(session(), failSecondAsset(), { projectId: PROJECT, idempotencyKey: KEY }, { provider: createMockImageProvider(), env: {} });
    expect(result).toMatchObject({ ok: false });
    expect(rows("design_assets")).toHaveLength(0);
    expect(db.objects.size).toBe(0);
    expect(rows("generation_jobs")[0]).toMatchObject({ status: "FAILED" });
    expect(rows("generation_jobs")[0].error_summary).not.toContain("Cleanup incomplete");
  });

  it("keeps the records (so the files stay visible as leftovers) when the stored files cannot be removed, and recovery then clears both", async () => {
    db.failRemove = true;
    const result = await startGeneration(session(), failSecondAsset(), { projectId: PROJECT, idempotencyKey: KEY }, { provider: createMockImageProvider(), env: {} });
    expect(result).toMatchObject({ ok: false });
    expect(rows("generation_jobs")[0].error_summary).toContain("Cleanup incomplete");
    expect(rows("design_assets").length).toBeGreaterThan(0); // not deleted: they are the only record of the files
    expect(db.objects.size).toBeGreaterThan(0);
    expect(rows("design_assets").every((r) => r.is_released === false)).toBe(true);
    // while they remain, a new run is blocked
    expect(await startGeneration(session(), db.client(), { projectId: PROJECT, idempotencyKey: "key-second-0123456789" }, { provider: createMockImageProvider(), env: {} })).toMatchObject({ ok: false, code: "not_eligible" });

    db.failRemove = false;
    expect(await removeLeftoverFiles(session(), db.client(), PROJECT)).toMatchObject({ ok: true });
    expect(rows("design_assets")).toHaveLength(0);
    expect(db.objects.size).toBe(0);
    // and generation can be tried again
    expect(await startGeneration(session(), db.client(), { projectId: PROJECT, idempotencyKey: "key-third-0123456789ab" }, { provider: createMockImageProvider(), env: {} })).toMatchObject({ ok: true });
  });

  it("a storage upload that fails leaves no record and no object", async () => {
    db.failUpload = true;
    expect(await startGeneration(session(), db.client(), { projectId: PROJECT, idempotencyKey: KEY }, { provider: createMockImageProvider(), env: {} })).toMatchObject({ ok: false });
    expect(rows("design_assets")).toHaveLength(0);
    expect(db.objects.size).toBe(0);
  });
});
