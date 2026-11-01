import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoGenerationKey, startAutomaticGeneration } from "@/lib/generation/auto";
import { mockBriefProvider } from "@/lib/journeys/brief";
import { acceptQuote, createBrief, createDraftProject, createQuote, getLatestQuote, reviewBrief, saveStep } from "@/lib/journeys/service";
import { submitPayment, verifyPayment } from "@/lib/payments/service";
import type { ImageGenerationProvider } from "@/lib/providers/images";
import { ProviderError } from "@/lib/providers/interfaces";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { REQUIREMENTS } from "../unit/support/journey-fixtures";

/**
 * Automatic generation after a payment verification, against the LOCAL Supabase stack: the real
 * database (workflow triggers, insert_generated_asset, system_release_project), real Storage and the
 * real Auth users. Needs migration 20261101000100 applied locally.
 *
 * The image provider is a STAND-IN: the built-in test generator's valid PNGs, reported as an
 * "openrouter" provider with mock = false, so the database sees real-looking output and no credits are
 * spent. That is a stand-in for the provider only; everything after it is the real code and database.
 * Only synthetic users, projects and files are created, and the users are removed afterwards.
 *
 *   LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/auto-generation.live.test.ts
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
const BUCKET = "project-files";

if (ENABLED && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) throw new Error("Refusing to run live tests: NEXT_PUBLIC_SUPABASE_URL is not a local address.");

function sql(query: string, input?: string): string {
  return execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", ...(input === undefined ? ["-c", query] : [])], { encoding: "utf8", input }).trim();
}

/** The test generator's valid images, presented as real (non-placeholder) output. Counts its calls. */
function standInProvider(behaviour: "real" | "placeholder" | "failing") {
  const base = createMockImageProvider();
  let calls = 0;
  const provider: ImageGenerationProvider = {
    ...base,
    id: behaviour === "placeholder" ? "mock" : "openrouter",
    mock: behaviour === "placeholder",
    generate: async (request, hooks) => {
      calls += 1;
      if (behaviour === "failing") throw new ProviderError("server", "simulated provider failure");
      const out = await base.generate(request, hooks);
      return behaviour === "real" ? { ...out, provider: "openrouter", mock: false } : out;
    },
  };
  return { provider, calls: () => calls };
}

describe.skipIf(!ENABLED)("live local stack: automatic generation and release", () => {
  let service: SupabaseClient;
  const users = {} as Record<"a" | "b" | "admin", { id: string; client: SupabaseClient }>;

  const jobs = (projectId: string) => sql(`select status || ':' || provider || ':' || coalesce(idempotency_key, '') from public.generation_jobs where project_id = '${projectId}' order by created_at`).split("\n").filter(Boolean);
  const status = (projectId: string) => sql(`select status from public.projects where id = '${projectId}'`);
  const assets = (projectId: string) => sql(`select asset_type || ':' || is_released || ':' || storage_path from public.design_assets where project_id = '${projectId}' and generation_job_id is not null order by created_at`).split("\n").filter(Boolean);
  const auditCount = (projectId: string, action: string) => Number(sql(`select count(*) from public.audit_events where project_id = '${projectId}' and action = '${action}'`));

  /** A project taken through the real journey up to a VERIFIED payment, as the customer and the administrator would. */
  async function verifiedProject(owner: "a" | "b" = "a") {
    const u = users[owner];
    const created = await createDraftProject(u.client, u.id, "EMPTY_PLOT");
    if (!created.ok) throw new Error("setup: draft");
    const projectId = created.projectId;
    for (const [stepId, data] of Object.entries(REQUIREMENTS.EMPTY_PLOT)) await saveStep(u.client, u.id, projectId, stepId, data, undefined, { service: () => service });
    expect(await createBrief(u.client, service, u.id, projectId, mockBriefProvider)).toEqual({ ok: true });
    expect(await reviewBrief(u.client, service, u.id, projectId, "approve", "Approved brief for a synthetic test project.", true)).toEqual({ ok: true });
    expect(await createQuote(u.client, service, u.id, projectId)).toEqual({ ok: true });
    const quote = (await getLatestQuote(u.client, projectId))!;
    expect(await acceptQuote(u.client, service, u.id, projectId, quote.id)).toEqual({ ok: true });
    const fields = { utrReference: `AUT${RUN.toUpperCase()}${Math.floor(Math.random() * 1e6)}`, transferDate: new Date().toISOString().slice(0, 10), amount: quote.totalAmount.toFixed(2), method: "UPI" };
    const paid = await submitPayment(u.client, service, u.id, projectId, { ...fields, file: new File([PNG_BYTES], "receipt.png", { type: "image/png" }) }, { env: DEMO_ENV });
    if (!paid.ok) throw new Error("setup: payment");
    return { projectId, paymentId: paid.paymentId, total: quote.totalAmount.toFixed(2) };
  }
  const verify = (p: { paymentId: string; total: string }, amount = p.total) => verifyPayment(users.admin.client, p.paymentId, { confirmedAmount: amount, note: "synthetic", acknowledged: true });

  beforeAll(async () => {
    expect(URL_ && ANON && SERVICE).toBeTruthy();
    service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const label of ["a", "b", "admin"] as const) {
      const email = `live-auto-${label}-${RUN}@example.test`;
      const created = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
      expect(created.error).toBeNull();
      const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await client.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
      users[label] = { id: created.data.user!.id, client };
    }
    sql(`insert into public.admin_users (user_id) values ('${users.admin.id}')`);
    if (sql("select count(*) from public.pricing_rules") === "0") sql("", readFileSync(path.join(process.cwd(), "supabase/demo/pricing_rules.demo.sql"), "utf8"));
    expect(sql("select count(*) from pg_proc where proname = 'system_release_project'")).toBe("1"); // migration 20261101000100 must be applied locally
  });

  afterAll(async () => {
    if (!ENABLED) return;
    for (const u of Object.values(users)) await service.auth.admin.deleteUser(u.id).catch(() => undefined);
  });

  const start = (projectId: string, provider: ImageGenerationProvider, actor: string | null = users.admin.id) =>
    startAutomaticGeneration(service, { projectId, actorId: actor }, { provider, env: {}, newRequestId: () => randomUUID() });

  it("creates no job before a payment is verified, and none for a wrong amount", async () => {
    const p = await verifiedProject();
    const stand = standInProvider("real");
    expect(await start(p.projectId, stand.provider)).toMatchObject({ state: "not_started", code: "not_eligible" });
    expect(await verify(p, "1.00")).toMatchObject({ ok: false });
    expect(await start(p.projectId, stand.provider)).toMatchObject({ state: "not_started" });
    expect(stand.calls()).toBe(0);
    expect(jobs(p.projectId)).toEqual([]);
    expect(status(p.projectId)).toBe("PAYMENT_PROOF_SUBMITTED");
  });

  it("verification then one automatic run: one job keyed to the payment, private images, released to the owner only", async () => {
    const p = await verifiedProject();
    const verified = await verify(p);
    expect(verified).toMatchObject({ ok: true, projectId: p.projectId });
    expect(status(p.projectId)).toBe("PAYMENT_VERIFIED"); // the durable "generation is owed" state

    const stand = standInProvider("real");
    const outcome = await start(p.projectId, stand.provider);
    expect(outcome).toMatchObject({ state: "released" });
    expect(stand.calls()).toBe(1);
    expect(status(p.projectId)).toBe("RELEASED");
    expect(jobs(p.projectId)).toEqual([`SUCCEEDED:openrouter:${autoGenerationKey(p.paymentId)}`]);
    expect(auditCount(p.projectId, "generation.auto_started")).toBe(1);
    expect(auditCount(p.projectId, "release.automatic")).toBe(1);

    const rows = assets(p.projectId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.split(":")[1] === "true")).toBe(true);

    // The owner can open each file; another customer and a signed-out client cannot.
    const files = rows.map((r) => r.split(":").slice(2).join(":"));
    for (const file of files) {
      expect((await users.a.client.storage.from(BUCKET).createSignedUrl(file, 60)).error).toBeNull();
      const stranger = await users.b.client.storage.from(BUCKET).createSignedUrl(file, 60);
      expect(stranger.error ?? stranger.data?.signedUrl === undefined).toBeTruthy();
      const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      const signedOut = await anon.storage.from(BUCKET).createSignedUrl(file, 60);
      expect(signedOut.error).not.toBeNull();
    }
    // The customer sees the project and its released asset rows, but never the job.
    const own = await users.a.client.from("design_assets").select("id").eq("project_id", p.projectId).eq("is_released", true);
    expect(own.data).toHaveLength(2);
    expect((await users.b.client.from("design_assets").select("id").eq("project_id", p.projectId)).data).toHaveLength(0);
    expect((await users.a.client.from("generation_jobs").select("id").eq("project_id", p.projectId)).data).toHaveLength(0);
  });

  it("repeated and concurrent triggers produce exactly one job and one provider call", async () => {
    const p = await verifiedProject();
    expect(await verify(p)).toMatchObject({ ok: true });
    const stand = standInProvider("real");
    const results = await Promise.all([start(p.projectId, stand.provider), start(p.projectId, stand.provider), start(p.projectId, stand.provider), start(p.projectId, stand.provider)]);
    await start(p.projectId, stand.provider);
    await start(p.projectId, stand.provider, null);
    expect(stand.calls()).toBe(1);
    expect(jobs(p.projectId)).toHaveLength(1);
    expect(status(p.projectId)).toBe("RELEASED");
    expect(results.every((r) => ["released", "running"].includes(r.state))).toBe(true);
    expect(auditCount(p.projectId, "release.automatic")).toBe(1);
  });

  it("a second verification attempt is refused by the database and creates nothing", async () => {
    const p = await verifiedProject();
    expect(await verify(p)).toMatchObject({ ok: true });
    expect(await verify(p)).toMatchObject({ ok: false, message: expect.stringContaining("already been decided") });
    expect(Number(sql(`select count(*) from public.audit_events where project_id = '${p.projectId}' and action = 'payment.verified'`))).toBe(1);
  });

  it("placeholder output is never released automatically, and the owner cannot reach it", async () => {
    const p = await verifiedProject();
    expect(await verify(p)).toMatchObject({ ok: true });
    const stand = standInProvider("placeholder");
    expect(await start(p.projectId, stand.provider)).toMatchObject({ state: "awaiting_review", reason: "placeholder" });
    expect(status(p.projectId)).toBe("READY_FOR_REVIEW");
    expect(assets(p.projectId).every((r) => r.split(":")[1] === "false")).toBe(true);
    for (const r of assets(p.projectId)) {
      const file = r.split(":").slice(2).join(":");
      const owner = await users.a.client.storage.from(BUCKET).createSignedUrl(file, 60);
      expect(owner.error).not.toBeNull();
    }
    expect((await users.a.client.from("design_assets").select("id").eq("project_id", p.projectId)).data).toHaveLength(0);
  });

  it("a failed job is visible, releases nothing, leaves no files behind and is not repeated by a re-trigger", async () => {
    const p = await verifiedProject();
    expect(await verify(p)).toMatchObject({ ok: true });
    const failing = standInProvider("failing");
    expect(await start(p.projectId, failing.provider)).toMatchObject({ state: "failed" });
    expect(status(p.projectId)).toBe("GENERATION_FAILED");
    expect(jobs(p.projectId)).toEqual([`FAILED:openrouter:${autoGenerationKey(p.paymentId)}`]);
    expect(assets(p.projectId)).toEqual([]);
    await start(p.projectId, failing.provider);
    expect(failing.calls()).toBe(1);
    expect(jobs(p.projectId)).toHaveLength(1);
    expect(auditCount(p.projectId, "release.automatic")).toBe(0);
  });

  it("system_release_project is callable only by the service role", async () => {
    const p = await verifiedProject();
    expect(await verify(p)).toMatchObject({ ok: true });
    await start(p.projectId, standInProvider("placeholder").provider); // READY_FOR_REVIEW, so only permissions can be what refuses
    for (const who of [users.a.client, users.admin.client, createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })]) {
      const denied = await who.rpc("system_release_project", { p_project_id: p.projectId });
      expect(denied.error).not.toBeNull();
      expect(denied.error?.code).toBe("42501");
    }
    expect(status(p.projectId)).toBe("READY_FOR_REVIEW");
    // Even the service role cannot release placeholder output.
    const refused = await service.rpc("system_release_project", { p_project_id: p.projectId });
    expect(refused.error?.code).toBe("23514");
    expect(status(p.projectId)).toBe("READY_FOR_REVIEW");
  });
});
