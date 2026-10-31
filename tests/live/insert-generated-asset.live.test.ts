import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearStaleJob } from "@/lib/generation/service";
import { mockBriefProvider } from "@/lib/journeys/brief";
import { acceptQuote, createBrief, createDraftProject, createQuote, getLatestQuote, reviewBrief, saveStep } from "@/lib/journeys/service";
import { submitPayment, verifyPayment } from "@/lib/payments/service";
import { REQUIREMENTS } from "../unit/support/journey-fixtures";

/**
 * Real concurrency for the checked write path public.insert_generated_asset and for the stale
 * clearing order (end the job first, clean up after), against the LOCAL PostgreSQL. It needs the
 * migration 20261022000300 applied locally. Nothing is applied or rolled back by this file; it only
 * adds a synthetic user, project and jobs (the same footprint as the other live suites) and removes
 * the users afterwards. It does not touch pricing rows (demo rates load only into an empty table).
 *
 *   LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/insert-generated-asset.live.test.ts
 */

const ENABLED = process.env.LIVE_SUPABASE === "1";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_CONTAINER = "supabase_db_Gnani_intern";
const PASSWORD = "Live-test-" + randomUUID();
const RUN = randomUUID().slice(0, 8);
const DEMO_ENV = { PAYMENT_MODE: "manual", PAYMENT_UPI_ID: "DEMO-DO-NOT-PAY@demo", PAYMENT_INSTRUCTIONS: "DEMO — DO NOT TRANSFER MONEY.", PAYMENT_CURRENCY: "INR" };
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 64 }, (_, i) => i)]);

if (ENABLED && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) throw new Error("Refusing to run live tests: NEXT_PUBLIC_SUPABASE_URL is not a local address.");

function sql(query: string, input?: string): string {
  return execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", ...(input === undefined ? ["-c", query] : [])], { encoding: "utf8", input }).trim();
}

/** One psql session running a script as service_role (the role the application uses); resolves with its exit code, output and wall time. */
function session(script: string, delayMs = 0): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const started = Date.now();
      const child = spawn("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"]);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
      child.stdin.end(script);
    }, delayMs);
  });
}

describe.skipIf(!ENABLED)("live local PostgreSQL: insert_generated_asset and stale-clearing order", () => {
  let service: SupabaseClient;
  const users = {} as Record<"a" | "admin", { id: string; client: SupabaseClient }>;
  let projectId = "";

  const pathFor = () => `${projectId}/generated/${randomUUID()}.png`;
  const callFn = (jobId: string, p = pathFor()) =>
    `select public.insert_generated_asset('${projectId}', '${jobId}', 'INTERIOR_CONCEPT', '${p}', 'image/png', 640, 360);`;
  const asService = (stmt: string) => `set role service_role; ${stmt}`;
  const assetCount = (jobId: string) => Number(sql(`select count(*) from public.design_assets where generation_job_id = '${jobId}'`));
  const jobStatus = (jobId: string) => sql(`select status from public.generation_jobs where id = '${jobId}'`);

  const newJob = async (status: "RUNNING" | "FAILED") => {
    const inserted = await service.from("generation_jobs").insert({ project_id: projectId, provider: "mock", prompt_version: "image-prompt-1" }).select("id").single();
    expect(inserted.error).toBeNull();
    const id = (inserted.data as { id: string }).id;
    expect((await service.from("generation_jobs").update({ status: "RUNNING" }).eq("id", id)).error).toBeNull();
    if (status === "FAILED") expect((await service.from("generation_jobs").update({ status: "FAILED", error_code: "STALE_ABANDONED" }).eq("id", id)).error).toBeNull();
    return id;
  };
  /** Every job of the shared project must be ended before the next one can start (one active job per project). */
  const endActiveJobs = async () => {
    expect((await service.from("generation_jobs").update({ status: "FAILED", error_code: "TEST_CLEANUP" }).eq("project_id", projectId).in("status", ["QUEUED", "RUNNING"])).error).toBeNull();
  };

  beforeAll(async () => {
    expect(URL_ && ANON && SERVICE).toBeTruthy();
    service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const label of ["a", "admin"] as const) {
      const email = `live-iga-${label}-${RUN}@example.test`;
      const created = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
      expect(created.error).toBeNull();
      const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await client.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
      users[label] = { id: created.data.user!.id, client };
    }
    sql(`insert into public.admin_users (user_id) values ('${users.admin.id}')`);
    if (sql("select count(*) from public.pricing_rules") === "0") sql("", readFileSync(path.join(process.cwd(), "supabase/demo/pricing_rules.demo.sql"), "utf8"));
    expect(sql("select count(*) from pg_proc where proname = 'insert_generated_asset'")).toBe("1"); // migration 20261022000300 must be applied locally
    const a = users.a;
    const created = await createDraftProject(a.client, a.id, "EMPTY_PLOT");
    if (!created.ok) throw new Error("setup: draft");
    projectId = created.projectId;
    for (const [stepId, data] of Object.entries(REQUIREMENTS.EMPTY_PLOT)) await saveStep(a.client, a.id, projectId, stepId, data, undefined, { service: () => service });
    expect(await createBrief(a.client, service, a.id, projectId, mockBriefProvider)).toEqual({ ok: true });
    expect(await reviewBrief(a.client, service, a.id, projectId, "approve", "Approved brief for a synthetic test project.", true)).toEqual({ ok: true });
    expect(await createQuote(a.client, service, a.id, projectId)).toEqual({ ok: true });
    const quote = (await getLatestQuote(a.client, projectId))!;
    expect(await acceptQuote(a.client, service, a.id, projectId, quote.id)).toEqual({ ok: true });
    const fields = { utrReference: `IGA${RUN.toUpperCase()}${Math.floor(Math.random() * 1e6)}`, transferDate: new Date().toISOString().slice(0, 10), amount: quote.totalAmount.toFixed(2), method: "UPI" };
    const paid = await submitPayment(a.client, service, a.id, projectId, { ...fields, file: new File([PNG_BYTES], "receipt.png", { type: "image/png" }) }, { env: DEMO_ENV });
    if (!paid.ok) throw new Error("setup: payment");
    expect(await verifyPayment(users.admin.client, paid.paymentId, { confirmedAmount: quote.totalAmount.toFixed(2), note: "synthetic", acknowledged: true })).toMatchObject({ ok: true });
    expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", projectId)).error).toBeNull();
  });

  afterAll(async () => {
    if (!ENABLED) return;
    for (const u of Object.values(users)) await service.auth.admin.deleteUser(u.id).catch(() => undefined);
  });

  it("stores an asset for a RUNNING job through the service role (PostgREST), and refuses anon and a signed-in customer", async () => {
    const job = await newJob("RUNNING");
    const args = (p: string) => ({ p_project_id: projectId, p_job_id: job, p_asset_type: "INTERIOR_CONCEPT", p_storage_path: p, p_mime_type: "image/png", p_width: 640, p_height: 360 });
    const ok = await service.rpc("insert_generated_asset", args(pathFor()));
    expect(ok.error).toBeNull();
    expect(assetCount(job)).toBe(1);
    const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const client of [anon, users.a.client, users.admin.client]) {
      const denied = await client.rpc("insert_generated_asset", args(pathFor()));
      expect(denied.error).not.toBeNull();
      expect(denied.error?.code).toBe("42501");
    }
    expect(assetCount(job)).toBe(1);
    await endActiveJobs();
  });

  it("a write after the job was cleared as stale is refused, and stores nothing", async () => {
    const job = await newJob("FAILED");
    const late = await session(asService(callFn(job)));
    expect(late.code).not.toBe(0);
    expect(late.out).toContain("only to a running generation job");
    expect(assetCount(job)).toBe(0);
  });

  it("an in-flight insert makes the job-ending update wait; both complete in order and no write slips past", async () => {
    const job = await newJob("RUNNING");
    const [a, b] = await Promise.all([
      session(`begin; ${asService(callFn(job))} select pg_sleep(4); commit;`),
      session(`update public.generation_jobs set status = 'FAILED', error_code = 'STALE_ABANDONED' where id = '${job}' and status = 'RUNNING';`, 1500),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(b.ms).toBeGreaterThan(2000); // it waited for the insert's transaction instead of racing it
    expect(jobStatus(job)).toBe("FAILED");
    expect(assetCount(job)).toBe(1); // written while the job was still RUNNING; the clearing's cleanup runs after the job ended and sees it
  });

  it("an insert that starts after the job-ending update committed is refused", async () => {
    const job = await newJob("RUNNING");
    const [a, b] = await Promise.all([
      session(`begin; select pg_sleep(3); ${asService(callFn(job))} commit;`),
      session(`update public.generation_jobs set status = 'FAILED', error_code = 'STALE_ABANDONED' where id = '${job}' and status = 'RUNNING';`, 800),
    ]);
    expect(b.code).toBe(0);
    expect(a.code).not.toBe(0);
    expect(a.out).toContain("only to a running generation job");
    expect(assetCount(job)).toBe(0);
  });

  it("two inserts for the same RUNNING job at once both succeed, and the job can then succeed", async () => {
    const job = await newJob("RUNNING");
    const [a, b] = await Promise.all([session(asService(callFn(job))), session(asService(callFn(job)))]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(assetCount(job)).toBe(2);
    expect((await service.from("generation_jobs").update({ status: "SUCCEEDED" }).eq("id", job).eq("status", "RUNNING")).error).toBeNull();
  });

  it("clearStaleJob racing an in-flight insert: it waits, then its cleanup removes the row the insert wrote (no orphan), and the late insert after it is refused", async () => {
    const job = await newJob("RUNNING");
    expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", projectId)).error).toBeNull();
    const objectPath = pathFor();
    // The in-flight request: row insert in a transaction held open 4 s (its provider answered just before the clearing).
    const insertSession = session(`begin; ${asService(callFn(job, objectPath))} select pg_sleep(4); commit;`);
    await new Promise((r) => setTimeout(r, 1500));
    const started = Date.now();
    const cleared = await clearStaleJob(users.admin.client, service, projectId, { now: () => Date.now() + 11 * 60_000 });
    const clearMs = Date.now() - started;
    const inserted = await insertSession;
    expect(inserted.code).toBe(0);
    expect(cleared).toEqual({ ok: true });
    expect(clearMs).toBeGreaterThan(1500); // the job update waited for the insert's transaction
    expect(jobStatus(job)).toBe("FAILED");
    expect(assetCount(job)).toBe(0); // cleaned up AFTER the job ended, so it saw the row that committed during the wait
    expect(sql(`select error_summary from public.generation_jobs where id = '${job}'`)).toBe("The job was interrupted and cleared by an administrator.");
    expect(sql(`select status from public.projects where id = '${projectId}'`)).toBe("GENERATION_FAILED");
    // a request that still holds the old job id is now refused
    const late = await service.rpc("insert_generated_asset", { p_project_id: projectId, p_job_id: job, p_asset_type: "INTERIOR_CONCEPT", p_storage_path: pathFor(), p_mime_type: "image/png", p_width: 1, p_height: 1 });
    expect(late.error?.code).toBe("23514");
    expect(assetCount(job)).toBe(0);
    expect(sql(`select count(*) from public.audit_events where project_id = '${projectId}' and action = 'generation.admin_cleared_stale'`)).toBe("1");
  });

  describe("resuming an interrupted clearing is conditional on the project stamp (fresh-claim race)", () => {
    const projectStatus = () => sql(`select status from public.projects where id = '${projectId}'`);
    const later = () => Date.now() + 11 * 60_000;

    /** The interrupted state: the project is GENERATING, its job FAILED as STALE_ABANDONED, nothing active, one file left on it. */
    async function interrupted() {
      await endActiveJobs();
      if (projectStatus() === "GENERATION_FAILED") expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", projectId)).error).toBeNull();
      expect(projectStatus()).toBe("GENERATING");
      const job = await newJob("FAILED");
      sql(`insert into public.design_assets (project_id, generation_job_id, asset_type, storage_path, mime_type) values ('${projectId}', '${job}', 'INTERIOR_CONCEPT', '${pathFor()}', 'image/png')`);
      return job;
    }
    /** A service client whose storage removal first lets another actor end the attempt and claim the project again. */
    function withInterleavedClaim(): SupabaseClient {
      return new Proxy(service, {
        get(target, prop, receiver) {
          if (prop !== "storage") return Reflect.get(target, prop, receiver);
          return {
            from: (bucket: string) => ({
              remove: async (paths: string[]) => {
                expect((await service.from("projects").update({ status: "GENERATION_FAILED" }).eq("id", projectId)).error).toBeNull();
                expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", projectId)).error).toBeNull();
                return target.storage.from(bucket).remove(paths);
              },
            }),
          };
        },
      });
    }

    it("completes against the real database when nothing changed (the stamp compares equal through PostgREST)", async () => {
      const job = await interrupted();
      expect(await clearStaleJob(users.admin.client, service, projectId, { now: later })).toEqual({ ok: true });
      expect(projectStatus()).toBe("GENERATION_FAILED");
      expect(assetCount(job)).toBe(0);
      expect(sql(`select error_summary from public.generation_jobs where id = '${job}'`)).toBe("The job was interrupted and cleared by an administrator.");
    });

    it("leaves a project that was claimed again during the clearing in GENERATING, and its job can still be created", async () => {
      const job = await interrupted();
      const cleared = await clearStaleJob(users.admin.client, withInterleavedClaim(), projectId, { now: later });
      expect(cleared).toMatchObject({ ok: false, message: expect.stringContaining("changed while it was being cleared") });
      expect(projectStatus()).toBe("GENERATING"); // the fresh claim survived
      expect(assetCount(job)).toBe(0); // the old job's own cleanup still completed
      const created = await service.from("generation_jobs").insert({ project_id: projectId, provider: "mock", prompt_version: "image-prompt-1" }).select("id").single();
      expect(created.error).toBeNull(); // the claiming run creates its job exactly as before
      await endActiveJobs();
    });

    it("refuses outright, with no write, when the project was only just claimed (settle time measured on the project)", async () => {
      await interrupted();
      const before = sql(`select count(*) from public.audit_events where project_id = '${projectId}'`);
      const cleared = await clearStaleJob(users.admin.client, service, projectId, { now: () => Date.now() + 5_000 });
      expect(cleared).toMatchObject({ ok: false, message: expect.stringContaining("no single interrupted job") });
      expect(projectStatus()).toBe("GENERATING");
      expect(sql(`select count(*) from public.audit_events where project_id = '${projectId}'`)).toBe(before);
    });
  });
});
