import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, as, createAdmin, createDatabase, createUser, expectError, Scenario, service, superuser, user } from "./support/harness";

/**
 * public.system_release_project (migration 20261101000100): the service-role-only release path used by
 * automatic generation, applied through the real migrations in an in-memory database. It must release a
 * finished, non-placeholder project and refuse everything else, without changing admin_release_project.
 */

type Outcome = "SUCCEEDED" | "FAILED";

/** A project in GENERATING, with one job of the given provider and outcome and one stored asset. */
async function generated(db: PGlite, customer: string, admin: string, provider = "openrouter", outcome: Outcome = "SUCCEEDED", usage: Record<string, unknown> | null = null) {
  const s = await Scenario.advance(db, customer, admin, "generating");
  await as(db, service, async (q) => {
    const job = await q<{ id: string }>("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, $2, 'test-v1') returning id", [s.projectId, provider]);
    s.jobId = job[0].id;
    await q("update public.generation_jobs set status = 'RUNNING' where id = $1", [s.jobId]);
    await q(
      `insert into public.design_assets (project_id, generation_job_id, asset_type, storage_path, mime_type)
       values ($1, $2, 'EXTERIOR_CONCEPT', $3, 'image/png')`,
      [s.projectId, s.jobId, `${s.projectId}/generated/${crypto.randomUUID()}.png`],
    );
    if (outcome === "SUCCEEDED") await q("update public.generation_jobs set status = 'SUCCEEDED', usage_json = $2::jsonb where id = $1", [s.jobId, usage ? JSON.stringify(usage) : null]);
    else await q("update public.generation_jobs set status = 'FAILED', error_code = 'TEST' where id = $1", [s.jobId]);
  });
  return s;
}

const release = (db: PGlite, actor: Parameters<typeof as>[1], projectId: string) =>
  as(db, actor, (q) => q<{ id: string; status: string }>("select * from public.system_release_project($1)", [projectId]));

const state = (db: PGlite, projectId: string) =>
  as(db, superuser, async (q) => ({
    status: (await q<{ status: string }>("select status from public.projects where id = $1", [projectId]))[0].status,
    released: (await q<{ is_released: boolean }>("select is_released from public.design_assets where project_id = $1 order by created_at", [projectId])).map((r) => r.is_released),
  }));

describe("system_release_project", () => {
  let db: PGlite;
  let customer: string;
  let admin: string;
  beforeAll(async () => {
    db = await createDatabase();
    customer = await createUser(db, "sr1");
    admin = await createAdmin(db);
  });
  afterAll(async () => db.close());

  const ready = async (...args: Parameters<typeof generated> extends [unknown, unknown, unknown, ...infer R] ? R : never) => {
    const s = await generated(db, customer, admin, ...args);
    await s.markReadyForReview();
    return s;
  };

  it("releases a finished non-placeholder project, releases its files and writes an audit event", async () => {
    const s = await ready();
    const [row] = await release(db, service, s.projectId);
    expect(row.status).toBe("RELEASED");
    expect(await state(db, s.projectId)).toEqual({ status: "RELEASED", released: [true] });
    const audit = await as(db, superuser, (q) => q<{ action: string; actor_id: string | null }>("select action, actor_id from public.audit_events where project_id = $1 and action = 'release.automatic'", [s.projectId]));
    expect(audit).toEqual([{ action: "release.automatic", actor_id: null }]);
  });

  it("is repeatable without effect: a second call is refused and nothing changes", async () => {
    const s = await ready();
    await release(db, service, s.projectId);
    await expectError(release(db, service, s.projectId), /not ready for review/);
    expect(await state(db, s.projectId)).toEqual({ status: "RELEASED", released: [true] });
  });

  it("never releases placeholder output, whether the provider or the usage says mock", async () => {
    for (const s of [await ready("mock"), await ready("openrouter", "SUCCEEDED", { mock: true })]) {
      await expectError(release(db, service, s.projectId), /placeholder output is released only by an administrator/);
      expect(await state(db, s.projectId)).toEqual({ status: "READY_FOR_REVIEW", released: [false] });
    }
  });

  it("an administrator can still release placeholder output through the existing path (unchanged)", async () => {
    const s = await ready("mock");
    await s.release();
    expect(await state(db, s.projectId)).toEqual({ status: "RELEASED", released: [true] });
  });

  it("refuses to publish a file left by a failed attempt together with the good one", async () => {
    // A first attempt fails and leaves its file behind; a second attempt then succeeds.
    const s = await generated(db, customer, admin, "openrouter", "FAILED");
    await as(db, service, async (q) => {
      const job = await q<{ id: string }>("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'openrouter', 'test-v1') returning id", [s.projectId]);
      await q("update public.generation_jobs set status = 'RUNNING' where id = $1", [job[0].id]);
      await q("insert into public.design_assets (project_id, generation_job_id, asset_type, storage_path, mime_type) values ($1, $2, 'EXTERIOR_CONCEPT', $3, 'image/png')", [s.projectId, job[0].id, `${s.projectId}/generated/${crypto.randomUUID()}.png`]);
      await q("update public.generation_jobs set status = 'SUCCEEDED' where id = $1", [job[0].id]);
    });
    await s.markReadyForReview();
    await expectError(release(db, service, s.projectId), /failed or unfinished attempt/);
    expect((await state(db, s.projectId)).status).toBe("READY_FOR_REVIEW");
  });

  it("refuses a project that is not READY_FOR_REVIEW", async () => {
    const generating = await generated(db, customer, admin);
    await expectError(release(db, service, generating.projectId), /not ready for review/);
    expect((await state(db, generating.projectId)).status).toBe("GENERATING");
  });

  it("is callable only by the service role", async () => {
    const s = await ready();
    await expectError(release(db, anon, s.projectId), /permission denied/);
    await expectError(release(db, user(customer), s.projectId), /permission denied/);
    await expectError(release(db, user(admin), s.projectId), /permission denied/);
    expect((await state(db, s.projectId)).status).toBe("READY_FOR_REVIEW");
  });
});
