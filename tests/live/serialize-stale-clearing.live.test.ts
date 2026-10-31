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
 * Real concurrency for migration 20261022000400: the stale clearing's project move
 * (public.end_interrupted_generation) and the creation of a new job (generation_jobs_guard, FOR KEY SHARE)
 * both take the project row's lock, so exactly one wins. Needs the migration applied to the LOCAL database.
 * Nothing is applied or rolled back by this file; it only adds a synthetic user, project and jobs (the same
 * footprint as the other live suites) and removes the users afterwards. It does not touch pricing rows.
 *
 *   LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/serialize-stale-clearing.live.test.ts
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

describe.skipIf(!ENABLED)("live local PostgreSQL: the stale clearing and a new job are serialized on the project row", () => {
  let service: SupabaseClient;
  const users = {} as Record<"a" | "admin", { id: string; client: SupabaseClient }>;
  let projectId = "";

  const asService = (stmt: string) => `set role service_role; ${stmt}`;

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
    expect(sql("select count(*) from pg_proc where proname = 'end_interrupted_generation'")).toBe("1"); // migration 20261022000400 must be applied locally
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

  const insertJobSql = () => `insert into public.generation_jobs (project_id, provider, prompt_version) values ('${projectId}', 'mock', 'image-prompt-1');`;
  const endSql = () => `select public.end_interrupted_generation('${projectId}', null);`;
  const projectStatus = () => sql(`select status from public.projects where id = '${projectId}'`);
  const activeJobs = () => Number(sql(`select count(*) from public.generation_jobs where project_id = '${projectId}' and status in ('QUEUED', 'RUNNING')`));
  const later = () => Date.now() + 11 * 60_000;

  /** The interrupted state: project GENERATING, a FAILED job (the project guard needs one), nothing active. */
  async function interrupted(): Promise<string> {
    await endActiveJobs();
    if (projectStatus() === "GENERATION_FAILED") expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", projectId)).error).toBeNull();
    expect(projectStatus()).toBe("GENERATING");
    return newJob("FAILED");
  }

  it("a job insert that took its lock first: the clearing waits for it, then sees the job and leaves the fresh run alone", async () => {
    await interrupted();
    const [a, b] = await Promise.all([
      session(`begin; ${asService(insertJobSql())} select pg_sleep(4); commit;`),
      session(asService(endSql()), 1500),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(b.ms).toBeGreaterThan(2000); // it waited for the insert's transaction (the project-row lock), instead of racing it
    expect(b.out).toContain("ACTIVE_JOB");
    expect(projectStatus()).toBe("GENERATING");
    expect(activeJobs()).toBe(1);
  });

  it("the clearing took its lock first: the job insert waits, is refused after the move, and no active job exists on the failed project", async () => {
    await interrupted();
    const [a, b] = await Promise.all([
      session(`begin; ${asService(endSql())} select pg_sleep(4); commit;`),
      session(asService(insertJobSql()), 1500),
    ]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("MOVED");
    expect(b.ms).toBeGreaterThan(2000); // the insert waited behind the clearing's lock
    expect(b.code).not.toBe(0);
    expect(b.out).toContain("can be created only while the project is GENERATING");
    expect(projectStatus()).toBe("GENERATION_FAILED");
    expect(activeJobs()).toBe(0);
  });

  it("many simultaneous pairs: always one winner, never a failed project with an active job", async () => {
    const outcomes = { cleared: 0, kept: 0 };
    for (let i = 0; i < 10; i++) {
      await interrupted();
      const [clearing, creating] = await Promise.all([
        session(asService(endSql()), i % 2 === 0 ? 0 : 60),
        session(asService(insertJobSql()), i % 2 === 0 ? 60 : 0),
      ]);
      expect(clearing.code).toBe(0);
      const moved = clearing.out.includes("MOVED");
      if (moved) {
        expect(clearing.out).not.toContain("ACTIVE_JOB");
        expect(creating.code).not.toBe(0); // the fresh run lost: it is refused, nothing half-created
        expect(projectStatus()).toBe("GENERATION_FAILED");
        expect(activeJobs()).toBe(0);
        outcomes.cleared++;
      } else {
        expect(clearing.out).toContain("ACTIVE_JOB");
        expect(creating.code).toBe(0); // the fresh run won: the project is left alone
        expect(projectStatus()).toBe("GENERATING");
        expect(activeJobs()).toBe(1);
        outcomes.kept++;
      }
      // the invariant itself, whichever side won
      expect(sql(`select count(*) from public.projects p where p.id = '${projectId}' and p.status = 'GENERATION_FAILED' and exists (select 1 from public.generation_jobs j where j.project_id = p.id and j.status in ('QUEUED','RUNNING'))`)).toBe("0");
    }
    expect(outcomes.cleared + outcomes.kept).toBe(10);
  });

  it("clearStaleJob (resume path) racing a job insert in flight: the application leaves the fresh run alone", async () => {
    await interrupted();
    const insert = session(`begin; ${asService(insertJobSql())} select pg_sleep(4); commit;`);
    await new Promise((r) => setTimeout(r, 1500));
    const started = Date.now();
    const result = await clearStaleJob(users.admin.client, service, projectId, { now: later });
    const ms = Date.now() - started;
    expect((await insert).code).toBe(0);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("new generation run started") });
    expect(ms).toBeGreaterThan(1500);
    expect(projectStatus()).toBe("GENERATING");
    expect(activeJobs()).toBe(1);
  });

  it("clearStaleJob (resume path) with nothing racing still completes against the real database", async () => {
    await interrupted();
    expect(await clearStaleJob(users.admin.client, service, projectId, { now: later })).toEqual({ ok: true });
    expect(projectStatus()).toBe("GENERATION_FAILED");
    // after the clearing won, the normal retry path works: the project is claimed again and a job can be created
    expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", projectId)).error).toBeNull();
    expect((await service.from("generation_jobs").insert({ project_id: projectId, provider: "mock", prompt_version: "image-prompt-1" }).select("id").single()).error).toBeNull();
    await endActiveJobs();
  });

  it("the function can be called by the service role only", async () => {
    await interrupted();
    const args = { p_project_id: projectId, p_expect_updated_at: null };
    const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const client of [anon, users.a.client, users.admin.client]) {
      const denied = await client.rpc("end_interrupted_generation", args);
      expect(denied.error?.code).toBe("42501");
    }
    expect(projectStatus()).toBe("GENERATING");
    const ok = await service.rpc("end_interrupted_generation", args);
    expect(ok.error).toBeNull();
    expect(ok.data).toBe("MOVED");
  });
});
