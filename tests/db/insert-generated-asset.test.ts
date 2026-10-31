import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, as, createAdmin, createDatabase, createUser, expectError, Scenario, service, superuser, user } from "./support/harness";

/**
 * public.insert_generated_asset (migration 20261022000300): the checked write path for generated
 * assets, applied through the real migrations in an in-memory database. This database has one
 * connection, so the locking is only shown to be asked for here (the function text) and is proven
 * under real concurrency in tests/live/insert-generated-asset.live.test.ts.
 */

const ROOT = process.cwd();
const FN = "public.insert_generated_asset(uuid, uuid, text, text, text, integer, integer)";

type Status = "QUEUED" | "RUNNING" | "FAILED" | "SUCCEEDED";

async function jobIn(db: PGlite, projectId: string, status: Status): Promise<string> {
  return as(db, service, async (q) => {
    const job = await q<{ id: string }>("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'v1') returning id", [projectId]);
    const id = job[0].id;
    if (status !== "QUEUED") await q("update public.generation_jobs set status = 'RUNNING' where id = $1", [id]);
    if (status === "FAILED") await q("update public.generation_jobs set status = 'FAILED', error_code = 'STALE_ABANDONED' where id = $1", [id]);
    if (status === "SUCCEEDED") await q("update public.generation_jobs set status = 'SUCCEEDED' where id = $1", [id]);
    return id;
  });
}

const call = (db: PGlite, actor: Parameters<typeof as>[1], projectId: string, jobId: string, over: Record<string, unknown> = {}) => {
  const a = { type: "EXTERIOR_CONCEPT", path: `${projectId}/generated/${crypto.randomUUID()}.png`, ...over };
  return as(db, actor, (q) =>
    q<{ insert_generated_asset: string }>("select public.insert_generated_asset($1, $2, $3, $4, 'image/png', 640, 360) as insert_generated_asset", [projectId, jobId, a.type, a.path]),
  );
};

const assetRows = (db: PGlite, projectId: string) => as(db, superuser, (q) => q<{ id: string }>("select id from public.design_assets where project_id = $1", [projectId]));

describe("insert_generated_asset", () => {
  let db: PGlite;
  let customer: string;
  let admin: string;
  beforeAll(async () => {
    db = await createDatabase();
    customer = await createUser(db, "iga1");
    admin = await createAdmin(db);
  });
  afterAll(async () => db.close());

  const generating = async () => {
    const s = await Scenario.advance(db, customer, admin, "verified");
    await s.startGeneration();
    return s;
  };

  it("stores an unreleased asset for a RUNNING job and returns its id", async () => {
    const s = await generating();
    const job = await jobIn(db, s.projectId, "RUNNING");
    const [{ insert_generated_asset: id }] = await call(db, service, s.projectId, job);
    const rows = await as(db, superuser, (q) => q<{ id: string; is_released: boolean; generation_job_id: string; width: number; height: number }>("select id, is_released, generation_job_id, width, height from public.design_assets where id = $1", [id]));
    expect(rows).toEqual([{ id, is_released: false, generation_job_id: job, width: 640, height: 360 }]);
  });

  it("lets several inserts for the same RUNNING job through, and the job can then succeed", async () => {
    const s = await generating();
    const job = await jobIn(db, s.projectId, "RUNNING");
    await call(db, service, s.projectId, job);
    await call(db, service, s.projectId, job);
    expect(await assetRows(db, s.projectId)).toHaveLength(2);
    await as(db, service, (q) => q("update public.generation_jobs set status = 'SUCCEEDED' where id = $1", [job]));
  });

  it.each(["QUEUED", "FAILED", "SUCCEEDED"] as const)("refuses a %s job and stores nothing", async (status) => {
    const s = await generating();
    const job = await jobIn(db, s.projectId, status);
    await expectError(call(db, service, s.projectId, job), /only to a running generation job/);
    expect(await assetRows(db, s.projectId)).toHaveLength(0);
  });

  it("refuses a late write after the job was cleared as stale, while a newer run's write works", async () => {
    const s = await generating();
    const stale = await jobIn(db, s.projectId, "FAILED");
    await s.setStatus(service, "GENERATION_FAILED");
    await s.setStatus(service, "GENERATING");
    const fresh = await jobIn(db, s.projectId, "RUNNING");
    await expectError(call(db, service, s.projectId, stale), /only to a running generation job/);
    await call(db, service, s.projectId, fresh);
    const rows = await as(db, superuser, (q) => q<{ generation_job_id: string }>("select generation_job_id from public.design_assets where project_id = $1", [s.projectId]));
    expect(rows.map((r) => r.generation_job_id)).toEqual([fresh]);
  });

  it("refuses a job of another project, an unknown job and missing arguments", async () => {
    const a = await generating();
    const b = await generating();
    const otherJob = await jobIn(db, b.projectId, "RUNNING");
    await expectError(call(db, service, a.projectId, otherJob), /belongs to a different project/);
    await expectError(call(db, service, a.projectId, crypto.randomUUID()), /different project/);
    await expectError(as(db, service, (q) => q("select public.insert_generated_asset(null, null, 'EXTERIOR_CONCEPT', 'x', 'image/png')")), /required/);
    expect(await assetRows(db, a.projectId)).toHaveLength(0);
    expect(await assetRows(db, b.projectId)).toHaveLength(0);
  });

  it("refuses when the payment is no longer verified", async () => {
    const s = await generating();
    const job = await jobIn(db, s.projectId, "RUNNING");
    await as(db, superuser, async (q) => {
      await q("set local session_replication_role = replica"); // simulate forged or corrupted data
      await q("update public.payments set status = 'REJECTED', confirmed_amount = null, rejection_reason = 'forged for this test' where project_id = $1", [s.projectId]);
    });
    await expectError(call(db, service, s.projectId, job), /require a verified payment/);
    expect(await assetRows(db, s.projectId)).toHaveLength(0);
  });

  it("refuses when the project is not GENERATING", async () => {
    const s = await generating();
    const job = await jobIn(db, s.projectId, "RUNNING");
    await as(db, superuser, async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.projects set status = 'GENERATION_FAILED' where id = $1", [s.projectId]);
    });
    await expectError(call(db, service, s.projectId, job), /only while the project is GENERATING/);
    expect(await assetRows(db, s.projectId)).toHaveLength(0);
  });

  it("accepts only generated asset types, and a path that matches the project (table constraint still applies)", async () => {
    const s = await generating();
    const job = await jobIn(db, s.projectId, "RUNNING");
    for (const type of ["REFERENCE", "PAYMENT_PROOF", "NOPE"]) {
      await expectError(call(db, service, s.projectId, job, { type, path: `${s.projectId}/references/x.png` }), /not a generated asset type/);
    }
    await expectError(call(db, service, s.projectId, job, { path: `${crypto.randomUUID()}/generated/x.png` }), /design_assets_path_matches_type/);
    expect(await assetRows(db, s.projectId)).toHaveLength(0);
  });

  it("refuses a duplicate storage path", async () => {
    const s = await generating();
    const job = await jobIn(db, s.projectId, "RUNNING");
    const p = `${s.projectId}/generated/dup.png`;
    await call(db, service, s.projectId, job, { path: p });
    await expectError(call(db, service, s.projectId, job, { path: p }), /duplicate key|unique/);
    expect(await assetRows(db, s.projectId)).toHaveLength(1);
  });

  it("can be executed by the service role only", async () => {
    const s = await generating();
    const job = await jobIn(db, s.projectId, "RUNNING");
    await expectError(call(db, anon, s.projectId, job), /permission denied/);
    await expectError(call(db, user(customer), s.projectId, job), /permission denied/);
    await expectError(call(db, user(admin), s.projectId, job), /permission denied/);
    expect(await assetRows(db, s.projectId)).toHaveLength(0);
    const acl = await as(db, superuser, (q) =>
      q<{ anon: boolean; authenticated: boolean; service: boolean; pub: boolean; definer: boolean; cfg: string | null }>(
        `select has_function_privilege('anon', '${FN}', 'execute') as anon,
                has_function_privilege('authenticated', '${FN}', 'execute') as authenticated,
                has_function_privilege('service_role', '${FN}', 'execute') as service,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = '${FN}'::regprocedure and a.grantee = 0) as pub,
                p.prosecdef as definer, array_to_string(p.proconfig, ',') as cfg
           from pg_proc p where p.oid = '${FN}'::regprocedure`,
      ),
    );
    expect(acl).toEqual([{ anon: false, authenticated: false, service: true, pub: false, definer: true, cfg: 'search_path=""' }]);
  });

  it("the function takes a row lock on the job, and the table trigger is unchanged (release-invariant keeps its meaning)", async () => {
    const src = readFileSync(path.join(ROOT, "supabase/migrations/20261022000300_insert_generated_asset.sql"), "utf8");
    expect(src).toMatch(/from public\.generation_jobs j where j\.id = p_job_id for share/);
    const trigger = await as(db, superuser, (q) => q<{ n: string }>("select count(*)::text as n from pg_trigger where tgrelid = 'public.design_assets'::regclass and not tgisinternal"));
    const original = readFileSync(path.join(ROOT, "supabase/migrations/20261017000300_workflow_guards.sql"), "utf8");
    const body = (await as(db, superuser, (q) => q<{ prosrc: string }>("select prosrc from pg_proc where oid = 'app_private.design_assets_guard()'::regprocedure")))[0].prosrc;
    expect(original.replace(/\r/g, "")).toContain(body.trim());
    expect(Number(trigger[0].n)).toBeGreaterThan(0);
  });

  it("the rollback removes the function and leaves direct inserts as they were", async () => {
    await db.exec(readFileSync(path.join(ROOT, "supabase/rollbacks/20261022000300_insert_generated_asset.down.sql"), "utf8"));
    const gone = await as(db, superuser, (q) => q<{ n: string }>("select count(*)::text as n from pg_proc where proname = 'insert_generated_asset'"));
    expect(gone[0].n).toBe("0");
    await db.exec(readFileSync(path.join(ROOT, "supabase/migrations/20261022000300_insert_generated_asset.sql"), "utf8"));
    const back = await as(db, superuser, (q) => q<{ n: string }>("select count(*)::text as n from pg_proc where proname = 'insert_generated_asset'"));
    expect(back[0].n).toBe("1");
  });
});
