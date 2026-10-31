import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, as, createAdmin, createDatabase, createUser, expectError, Scenario, service, superuser, user } from "./support/harness";

/**
 * Migration 20261022000400: public.end_interrupted_generation (the stale clearing's project move, one
 * transaction under a project-row lock) and the FOR KEY SHARE in generation_jobs_guard. This in-memory
 * database has one connection, so it proves the decisions and permissions; the lock protocol under real
 * concurrency is proven in tests/live/serialize-stale-clearing.live.test.ts.
 */

const ROOT = process.cwd();
const FN = "public.insert_generated_asset(uuid, uuid, text, text, text, integer, integer)";
const END = "public.end_interrupted_generation(uuid, timestamptz)";
const read = (dir: string, file: string) => readFileSync(path.join(ROOT, dir, file), "utf8");

type Status = "QUEUED" | "RUNNING" | "FAILED";

async function jobIn(db: PGlite, projectId: string, status: Status): Promise<string> {
  return as(db, service, async (q) => {
    const job = await q<{ id: string }>("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'v1') returning id", [projectId]);
    const id = job[0].id;
    if (status !== "QUEUED") await q("update public.generation_jobs set status = 'RUNNING' where id = $1", [id]);
    if (status === "FAILED") await q("update public.generation_jobs set status = 'FAILED', error_code = 'STALE_ABANDONED' where id = $1", [id]);
    return id;
  });
}

const stamp = async (db: PGlite, projectId: string) =>
  (await as(db, superuser, (q) => q<{ u: string }>("select updated_at::text as u from public.projects where id = $1", [projectId])))[0].u;
const status = async (db: PGlite, projectId: string) =>
  (await as(db, superuser, (q) => q<{ s: string }>("select status as s from public.projects where id = $1", [projectId])))[0].s;
const end = (db: PGlite, actor: Parameters<typeof as>[1], projectId: string | null, expect: string | null = null) =>
  as(db, actor, async (q) => (await q<{ r: string }>("select public.end_interrupted_generation($1, $2) as r", [projectId, expect]))[0].r);

describe("end_interrupted_generation and the job-insert lock", () => {
  let db: PGlite;
  let customer: string;
  let admin: string;
  beforeAll(async () => {
    db = await createDatabase();
    customer = await createUser(db, "sse1");
    admin = await createAdmin(db);
  });
  afterAll(async () => db.close());

  const generating = async () => {
    const s = await Scenario.advance(db, customer, admin, "verified");
    await s.startGeneration();
    return s;
  };

  it("moves a GENERATING project with no active job to GENERATION_FAILED, once", async () => {
    const s = await generating();
    await jobIn(db, s.projectId, "FAILED");
    expect(await end(db, service, s.projectId)).toBe("MOVED");
    expect(await status(db, s.projectId)).toBe("GENERATION_FAILED");
    expect(await end(db, service, s.projectId)).toBe("PROJECT_CHANGED"); // idempotent: a repeat changes nothing
    expect(await status(db, s.projectId)).toBe("GENERATION_FAILED");
  });

  it("leaves the project alone while a QUEUED or RUNNING job exists", async () => {
    for (const st of ["QUEUED", "RUNNING"] as const) {
      const s = await generating();
      await jobIn(db, s.projectId, st);
      expect(await end(db, service, s.projectId)).toBe("ACTIVE_JOB");
      expect(await status(db, s.projectId)).toBe("GENERATING");
    }
  });

  it("matches the updated_at the caller read, and refuses a different one", async () => {
    const s = await generating();
    await jobIn(db, s.projectId, "FAILED");
    const seen = await stamp(db, s.projectId);
    expect(await end(db, service, s.projectId, "2001-01-01 00:00:00+00")).toBe("PROJECT_CHANGED");
    expect(await status(db, s.projectId)).toBe("GENERATING");
    expect(await end(db, service, s.projectId, seen)).toBe("MOVED"); // the exact microsecond stamp compares equal
  });

  it("answers NOT_FOUND for an unknown project, PROJECT_CHANGED for one that is not GENERATING, and refuses null", async () => {
    expect(await end(db, service, crypto.randomUUID())).toBe("NOT_FOUND");
    const s = await Scenario.advance(db, customer, admin, "verified");
    expect(await end(db, service, s.projectId)).toBe("PROJECT_CHANGED");
    expect(await status(db, s.projectId)).toBe("PAYMENT_VERIFIED");
    await expectError(end(db, service, null), /a project is required/);
  });

  it("still enforces the project guard: a GENERATING project with no failed job cannot be moved", async () => {
    const s = await generating(); // no job at all
    await expectError(end(db, service, s.projectId), /GENERATION_FAILED requires a failed generation job/);
    expect(await status(db, s.projectId)).toBe("GENERATING");
  });

  it("is executable by the service role only, is SECURITY DEFINER with an empty search path", async () => {
    const s = await generating();
    await jobIn(db, s.projectId, "FAILED");
    for (const actor of [anon, user(customer), user(admin)]) await expectError(end(db, actor, s.projectId), /permission denied/);
    expect(await status(db, s.projectId)).toBe("GENERATING");
    const acl = await as(db, superuser, (q) =>
      q<{ anon: boolean; authenticated: boolean; service: boolean; pub: boolean; definer: boolean; cfg: string | null }>(
        `select has_function_privilege('anon', '${END}', 'execute') as anon,
                has_function_privilege('authenticated', '${END}', 'execute') as authenticated,
                has_function_privilege('service_role', '${END}', 'execute') as service,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = '${END}'::regprocedure and a.grantee = 0) as pub,
                p.prosecdef as definer, array_to_string(p.proconfig, ',') as cfg
           from pg_proc p where p.oid = '${END}'::regprocedure`,
      ),
    );
    expect(acl).toEqual([{ anon: false, authenticated: false, service: true, pub: false, definer: true, cfg: 'search_path=""' }]);
  });

  describe("generation_jobs_guard keeps its rules", () => {
    it("creates a job only while GENERATING with a verified payment, as QUEUED", async () => {
      const s = await generating();
      await jobIn(db, s.projectId, "RUNNING"); // allowed
      const idle = await Scenario.advance(db, customer, admin, "verified");
      await expectError(jobIn(db, idle.projectId, "QUEUED"), /only while the project is GENERATING/);
      await expectError(
        as(db, service, (q) => q("insert into public.generation_jobs (project_id, provider, prompt_version, status) values ($1, 'mock', 'v1', 'RUNNING')", [s.projectId])),
        /one active|must start as QUEUED|duplicate key/,
      );
    });

    it("the guard reads the project FOR KEY SHARE, and the rollback restores the original function exactly", async () => {
      const guard = () => as(db, superuser, async (q) => (await q<{ prosrc: string }>("select prosrc from pg_proc where oid = 'app_private.generation_jobs_guard()'::regprocedure"))[0].prosrc);
      expect(await guard()).toMatch(/for key share/);

      const body = (sql: string) => {
        const m = sql.replace(/\r/g, "").match(/function app_private\.generation_jobs_guard\(\)[\s\S]*?as \$\$([\s\S]*?)\n\$\$;/);
        if (!m) throw new Error("guard body not found");
        return m[1].replace(/\s+/g, " ").trim();
      };
      const original = body(read("supabase/migrations", "20261017000300_workflow_guards.sql"));
      const rolledBack = body(read("supabase/rollbacks", "20261022000400_serialize_stale_clearing.down.sql"));
      expect(rolledBack).toBe(original); // the rollback's text is the original function, nothing else

      await db.exec(read("supabase/rollbacks", "20261022000400_serialize_stale_clearing.down.sql"));
      expect(await guard()).not.toMatch(/key share/);
      const gone = await as(db, superuser, (q) => q<{ n: string }>("select count(*)::text as n from pg_proc where proname = 'end_interrupted_generation'"));
      expect(gone[0].n).toBe("0");
      expect(body(`function app_private.generation_jobs_guard() as $$${await guard()}\n$$;`)).toBe(original);

      await db.exec(read("supabase/migrations", "20261022000400_serialize_stale_clearing.sql"));
      expect(await guard()).toMatch(/for key share/);
      // and the checked asset path of migration 20261022000300 is untouched by all of this
      const fn = await as(db, superuser, (q) => q<{ n: string }>(`select count(*)::text as n from pg_proc where oid = '${FN}'::regprocedure`));
      expect(fn[0].n).toBe("1");
    });
  });
});
