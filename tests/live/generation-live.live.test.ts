import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getCustomerResults, getGenerationDetail, listGenerationQueue } from "@/lib/generation/read";
import { clearStaleJob, releaseProject, removeLeftoverFiles, startGeneration } from "@/lib/generation/service";
import { mockBriefProvider } from "@/lib/journeys/brief";
import { acceptQuote, createBrief, createDraftProject, createQuote, getLatestQuote, reviewBrief, saveStep } from "@/lib/journeys/service";
import { sniffImage } from "@/lib/payments/evidence";
import { submitPayment, verifyPayment } from "@/lib/payments/service";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { ProviderError } from "@/lib/providers/interfaces";
import { PROJECT_FILES_BUCKET } from "@/lib/storage/paths";
import type { ProjectType } from "@/lib/db/schema";
import { REQUIREMENTS } from "../unit/support/journey-fixtures";

/**
 * Phase 6A live verification against the LOCAL Supabase stack: mock image generation, the
 * real database guards, private storage and controlled release. No AI provider is contacted
 * (the generator is the labelled mock) and nothing leaves this machine. It refuses to run
 * unless the URL is local, uses @example.test accounts and fake data, and never touches the
 * AI usage ledger.
 *
 *   LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/generation-live.live.test.ts
 *
 * Like the other live suites it installs the labelled DEMO pricing rules (configuration only).
 */

const ENABLED = process.env.LIVE_SUPABASE === "1";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_CONTAINER = "supabase_db_Gnani_intern";
const PASSWORD = "Live-test-" + randomUUID();
const RUN = randomUUID().slice(0, 8);
const DEMO_ENV = { PAYMENT_MODE: "manual", PAYMENT_UPI_ID: "DEMO-DO-NOT-PAY@demo", PAYMENT_INSTRUCTIONS: "DEMO — DO NOT TRANSFER MONEY.", PAYMENT_CURRENCY: "INR" };
const key = (n: string) => `live-${RUN}-${n}-0123456789`;

if (ENABLED && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) {
  throw new Error("Refusing to run live tests: NEXT_PUBLIC_SUPABASE_URL is not a local address.");
}

function sql(query: string, input?: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", ...(input === undefined ? ["-c", query] : [])],
    { encoding: "utf8", input },
  ).trim();
}
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 64 }, (_, i) => i)]);

describe.skipIf(!ENABLED)("live local Supabase: mock generation and controlled release", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  const users = {} as Record<"a" | "b" | "admin", { id: string; client: SupabaseClient }>;
  let verified = ""; // customer A, paid and verified
  let unpaid = ""; // customer B, quote accepted, not paid
  let failing = ""; // customer A, paid and verified, used for the failure path
  let stale = ""; // customer A, paid and verified, used for the interrupted-job path
  let leftover = ""; // customer B, paid and verified, used for the leftover-file path
  let winningKey = "";
  let assetPaths: string[] = [];
  const status = (id: string) => sql(`select status from public.projects where id = '${id}'`);
  const count = (query: string) => Number(sql(query));
  const jobCount = (id: string) => count(`select count(*) from public.generation_jobs where project_id = '${id}'`);
  const bucket = (c: SupabaseClient) => c.storage.from(PROJECT_FILES_BUCKET);

  async function makeUser(label: "a" | "b" | "admin") {
    const email = `live-gen-${label}-${RUN}@example.test`;
    const created = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    expect(created.error).toBeNull();
    const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await client.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
    users[label] = { id: created.data.user!.id, client };
  }

  /** Walks a customer's project through the real service layer to AWAITING_PAYMENT, or on to PAYMENT_VERIFIED. */
  async function walk(who: "a" | "b", type: ProjectType, to: "AWAITING_PAYMENT" | "PAYMENT_VERIFIED"): Promise<string> {
    const u = users[who];
    const created = await createDraftProject(u.client, u.id, type);
    if (!created.ok) throw new Error("setup: draft project");
    const id = created.projectId;
    for (const [stepId, data] of Object.entries(REQUIREMENTS[type])) await saveStep(u.client, u.id, id, stepId, data, undefined, { service: () => service });
    expect(await createBrief(u.client, service, u.id, id, mockBriefProvider)).toEqual({ ok: true });
    expect(await reviewBrief(u.client, service, u.id, id, "approve", "Approved brief for a synthetic test project.", true)).toEqual({ ok: true });
    expect(await createQuote(u.client, service, u.id, id)).toEqual({ ok: true });
    const quote = (await getLatestQuote(u.client, id))!;
    expect(await acceptQuote(u.client, service, u.id, id, quote.id)).toEqual({ ok: true });
    if (to === "AWAITING_PAYMENT") return id;
    const fields = { utrReference: `GEN${RUN.toUpperCase()}${Math.floor(Math.random() * 1e6)}`, transferDate: new Date().toISOString().slice(0, 10), amount: quote.totalAmount.toFixed(2), method: "UPI" };
    const paid = await submitPayment(u.client, service, u.id, id, { ...fields, file: new File([PNG_BYTES], "receipt.png", { type: "image/png" }) }, { env: DEMO_ENV });
    if (!paid.ok) throw new Error("setup: payment submission");
    const decided = await verifyPayment(users.admin.client, paid.paymentId, { confirmedAmount: quote.totalAmount.toFixed(2), note: "synthetic", acknowledged: true });
    expect(decided).toMatchObject({ ok: true });
    expect(status(id)).toBe("PAYMENT_VERIFIED");
    return id;
  }

  beforeAll(async () => {
    expect(URL_ && ANON && SERVICE).toBeTruthy();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const label of ["a", "b", "admin"] as const) await makeUser(label);
    sql(`insert into public.admin_users (user_id) values ('${users.admin.id}')`);
    // Non-destructive: load the labelled demo rates only into an empty table, never replace existing ones.
    if (sql("select count(*) from public.pricing_rules") === "0") sql("", readFileSync(path.join(process.cwd(), "supabase/demo/pricing_rules.demo.sql"), "utf8"));
    verified = await walk("a", "EMPTY_PLOT", "PAYMENT_VERIFIED");
    failing = await walk("a", "LANDSCAPE", "PAYMENT_VERIFIED");
    unpaid = await walk("b", "INTERIOR", "AWAITING_PAYMENT");
    stale = await walk("a", "INTERIOR", "PAYMENT_VERIFIED");
    leftover = await walk("b", "LANDSCAPE", "PAYMENT_VERIFIED");
  });

  describe("who may start, and when", () => {
    it("a customer or an anonymous caller cannot start generation, and nothing is written", async () => {
      await expect(startGeneration(users.a.client, service, { projectId: verified, idempotencyKey: key("cust") })).rejects.toMatchObject({ status: 403 });
      await expect(startGeneration(anon, service, { projectId: verified, idempotencyKey: key("anon") })).rejects.toMatchObject({ status: 401 });
      expect(jobCount(verified)).toBe(0);
      expect(status(verified)).toBe("PAYMENT_VERIFIED");
    });

    it("an administrator cannot start an unpaid project, and the database refuses it independently", async () => {
      const result = await startGeneration(users.admin.client, service, { projectId: unpaid, idempotencyKey: key("unpaid") }, { env: {} });
      expect(result).toMatchObject({ ok: false, code: "not_eligible" });
      expect(jobCount(unpaid)).toBe(0);
      expect(status(unpaid)).toBe("AWAITING_PAYMENT");
      // Even trusted code cannot bypass the gate.
      expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", unpaid)).error).not.toBeNull();
      expect((await service.from("generation_jobs").insert({ project_id: unpaid, provider: "mock", prompt_version: "v" })).error).not.toBeNull();
      expect(status(unpaid)).toBe("AWAITING_PAYMENT");
    });

    it("the administrator's identity cannot be forged through the request: the project id and key are the only inputs", async () => {
      expect(await startGeneration(users.admin.client, service, { projectId: "not-a-uuid", idempotencyKey: key("bad") }, { env: {} })).toMatchObject({ ok: false, code: "bad_request" });
      expect(await startGeneration(users.admin.client, service, { projectId: randomUUID(), idempotencyKey: key("none") }, { env: {} })).toMatchObject({ ok: false, code: "not_found" });
    });
  });

  describe("generation on the real database", () => {
    it("five simultaneous requests produce exactly one job and one set of unreleased assets", async () => {
      const ledgerBefore = count("select count(*) from public.ai_usage");
      const keys = ["1", "2", "3", "4", "5"].map((n) => key(`par${n}`));
      const results = await Promise.all(keys.map((k) => startGeneration(users.admin.client, service, { projectId: verified, idempotencyKey: k }, { env: {} })));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      winningKey = keys[results.findIndex((r) => r.ok)];
      expect(winners[0]).toMatchObject({ ok: true, mock: true, replayed: false });
      expect(jobCount(verified)).toBe(1);
      expect(sql(`select status || '|' || provider || '|' || idempotency_key from public.generation_jobs where project_id = '${verified}'`)).toBe(`SUCCEEDED|mock|${winningKey}`);
      expect(count(`select count(*) from public.design_assets where project_id = '${verified}' and generation_job_id is not null and not is_released`)).toBe(2);
      expect(count(`select count(*) from public.design_assets where project_id = '${verified}' and is_released`)).toBe(0);
      expect(status(verified)).toBe("READY_FOR_REVIEW");
      expect(count(`select count(*) from public.audit_events where project_id = '${verified}' and action = 'generation.admin_started'`)).toBe(1);
      expect(sql(`select actor_id::text from public.audit_events where project_id = '${verified}' and action = 'generation.admin_started'`)).toBe(users.admin.id);
      expect(count("select count(*) from public.ai_usage")).toBe(ledgerBefore); // the mock spends and records nothing
      assetPaths = sql(`select storage_path from public.design_assets where project_id = '${verified}' order by storage_path`).split("\n");
      expect(assetPaths).toHaveLength(2);
      expect(assetPaths.every((p) => p.startsWith(`${verified}/generated/`) && p.endsWith(".png"))).toBe(true);
    });

    it("repeating the winning request is a no-op replay; a new key is refused", async () => {
      const replay = await startGeneration(users.admin.client, service, { projectId: verified, idempotencyKey: winningKey }, { env: {} });
      expect(replay).toMatchObject({ ok: true, replayed: true });
      expect(await startGeneration(users.admin.client, service, { projectId: verified, idempotencyKey: key("late") }, { env: {} })).toMatchObject({ ok: false, code: "not_eligible" });
      expect(jobCount(verified)).toBe(1);
    });

    it("stored real, mock-labelled PNG files that only an administrator can preview before release", async () => {
      for (const p of assetPaths) {
        const preview = await bucket(users.admin.client).download(p);
        expect(preview.error).toBeNull();
        const bytes = new Uint8Array(await preview.data!.arrayBuffer());
        expect(sniffImage(bytes)?.mime).toBe("image/png");
        expect(bytes.length).toBeGreaterThan(100);
        const signed = await bucket(users.admin.client).createSignedUrl(p, 60);
        expect(signed.error).toBeNull();
      }
    });

    it("a failure leaves nothing behind and is recoverable with a new key", async () => {
      const boom = { ...createMockImageProvider(), generate: async () => { throw new ProviderError("server", "simulated outage"); } };
      const result = await startGeneration(users.admin.client, service, { projectId: failing, idempotencyKey: key("fail") }, { provider: boom, env: {} });
      expect(result).toMatchObject({ ok: false, code: "failed" });
      expect(sql(`select status || '|' || error_code from public.generation_jobs where project_id = '${failing}'`)).toBe("FAILED|PROVIDER_SERVER");
      expect(status(failing)).toBe("GENERATION_FAILED");
      expect(count(`select count(*) from public.design_assets where project_id = '${failing}'`)).toBe(0);
      expect(count(`select count(*) from storage.objects where bucket_id = '${PROJECT_FILES_BUCKET}' and name like '${failing}/generated/%'`)).toBe(0);

      const retry = await startGeneration(users.admin.client, service, { projectId: failing, idempotencyKey: key("retry") }, { env: {} });
      expect(retry).toMatchObject({ ok: true });
      expect(sql(`select string_agg(status, ',' order by created_at) from public.generation_jobs where project_id = '${failing}'`)).toBe("FAILED,SUCCEEDED");
      expect(status(failing)).toBe("READY_FOR_REVIEW");
      expect(count(`select count(*) from public.design_assets where project_id = '${failing}' and not is_released`)).toBe(1);
    });
  });

  describe("private until an administrator releases", () => {
    it("the owner, another customer and an anonymous caller cannot see or fetch generated files", async () => {
      for (const client of [users.a.client, users.b.client, anon]) {
        const rows = await client.from("design_assets").select("id").eq("project_id", verified).neq("asset_type", "REFERENCE");
        expect(rows.error !== null || (rows.data ?? []).length === 0).toBe(true);
        for (const p of assetPaths) {
          expect((await bucket(client).download(p)).error).not.toBeNull();
          expect((await bucket(client).createSignedUrl(p, 60)).error).not.toBeNull();
        }
      }
      for (const client of [users.a.client, users.b.client]) {
        const jobs = await client.from("generation_jobs").select("id").eq("project_id", verified);
        expect(jobs.error !== null || (jobs.data ?? []).length === 0).toBe(true);
      }
    });

    it("there is no public URL for a generated file", async () => {
      const response = await fetch(`${URL_}/storage/v1/object/public/${PROJECT_FILES_BUCKET}/${assetPaths[0]}`);
      expect(response.ok).toBe(false);
    });

    it("nobody but an administrator's own session can release; generation itself never does", async () => {
      expect((await users.a.client.rpc("admin_release_project", { p_project_id: verified })).error).not.toBeNull();
      expect((await anon.rpc("admin_release_project", { p_project_id: verified })).error).not.toBeNull();
      expect((await service.rpc("admin_release_project", { p_project_id: verified })).error).not.toBeNull();
      await expect(releaseProject(users.a.client, verified)).rejects.toMatchObject({ status: 403 });
      expect(status(verified)).toBe("READY_FOR_REVIEW");
      expect(count(`select count(*) from public.design_assets where project_id = '${verified}' and is_released`)).toBe(0);
    });

    it("direct attempts to release, to create released assets or to write generated files are refused", async () => {
      await users.a.client.from("design_assets").update({ is_released: true }).eq("project_id", verified); // may error or match no row; either way nothing changes
      expect(count(`select count(*) from public.design_assets where project_id = '${verified}' and is_released`)).toBe(0);
      expect((await service.from("design_assets").update({ is_released: true }).eq("project_id", verified)).error).not.toBeNull();
      const forged = await users.a.client.from("design_assets").insert({ project_id: verified, asset_type: "EXTERIOR_CONCEPT", storage_path: `${verified}/generated/forged.png`, mime_type: "image/png" });
      expect(forged.error).not.toBeNull();
      expect((await bucket(users.a.client).upload(`${verified}/generated/forged.png`, PNG_BYTES, { contentType: "image/png" })).error).not.toBeNull();
      expect(count(`select count(*) from storage.objects where name = '${verified}/generated/forged.png'`)).toBe(0);
    });

    it("the bucket itself refuses an SVG or script even from trusted code", async () => {
      const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>");
      const attempt = await bucket(service).upload(`${verified}/generated/${randomUUID()}.svg`, svg, { contentType: "image/svg+xml" });
      expect(attempt.error).not.toBeNull();
    });
  });

  describe("what the screens read, before release", () => {
    it("the administrator sees the project in the queue, ready for review, with working preview links and no storage paths", async () => {
      const queue = await listGenerationQueue(users.admin.client);
      expect(queue.find((r) => r.projectId === verified)).toMatchObject({ phase: "ready_for_review", jobCount: 1, assetCount: 2 });
      expect(JSON.stringify(queue)).not.toContain("/generated/");

      const detail = await getGenerationDetail(users.admin.client, verified);
      expect(detail).toMatchObject({ status: "READY_FOR_REVIEW", phase: "ready_for_review", mock: true, leftoverCount: 0, releaseBlockers: [] });
      expect(detail!.previews).toHaveLength(2);
      expect(Object.keys(detail!.previews[0]).sort()).toEqual(["height", "id", "label", "released", "url", "width"]);
      for (const preview of detail!.previews) {
        expect(preview.released).toBe(false);
        const response = await fetch(preview.url!);
        expect(response.ok).toBe(true);
        expect(response.headers.get("content-type")).toContain("image/png");
        expect(sniffImage(new Uint8Array(await response.arrayBuffer()))?.mime).toBe("image/png");
      }
    });

    it("the owner's results page data shows only the status: no files, paths or links", async () => {
      const result = await getCustomerResults(users.a.client, users.a.id, verified);
      expect(result).toEqual({ state: "pending", status: "READY_FOR_REVIEW" });
    });

    it("another customer is told the project does not exist, and the administrator readers show a customer nothing of anyone else's", async () => {
      expect(await getCustomerResults(users.b.client, users.b.id, verified)).toEqual({ state: "not_found" });
      const asCustomer = await getGenerationDetail(users.a.client, verified);
      // Row level security hides jobs and unreleased assets from a customer's session.
      expect(asCustomer === null || (asCustomer.jobs.length === 0 && asCustomer.previews.length === 0)).toBe(true);
      // Even called with a customer's session the queue holds only that customer's own rows, never another's.
      const queueForB = await listGenerationQueue(users.b.client);
      expect(queueForB.every((r) => r.customerId === users.b.id)).toBe(true);
      expect(queueForB.some((r) => r.projectId === verified)).toBe(false);
    });
  });

  describe("controlled release", () => {
    it("an administrator releases through the database function, and only then can the owner fetch the files", async () => {
      // Mock placeholders need an explicit acknowledgement; without it nothing is released.
      expect(await releaseProject(users.admin.client, verified)).toMatchObject({ ok: false, message: expect.stringContaining("MOCK") });
      expect(status(verified)).toBe("READY_FOR_REVIEW");
      expect(await releaseProject(users.admin.client, verified, { acknowledgeMock: true })).toEqual({ ok: true });
      expect(status(verified)).toBe("RELEASED");
      expect(count(`select count(*) from public.design_assets where project_id = '${verified}' and is_released`)).toBe(2);
      expect(count(`select count(*) from public.audit_events where project_id = '${verified}' and action = 'asset.released'`)).toBe(1);

      for (const p of assetPaths) {
        const own = await bucket(users.a.client).download(p);
        expect(own.error).toBeNull();
        expect(sniffImage(new Uint8Array(await own.data!.arrayBuffer()))?.mime).toBe("image/png");
        expect((await bucket(users.a.client).createSignedUrl(p, 60)).error).toBeNull();
      }
      const rows = await users.a.client.from("design_assets").select("id").eq("project_id", verified).neq("asset_type", "REFERENCE");
      expect(rows.data).toHaveLength(2);
    });

    it("after release, another customer and an anonymous caller still cannot fetch them", async () => {
      for (const client of [users.b.client, anon]) {
        for (const p of assetPaths) expect((await bucket(client).download(p)).error).not.toBeNull();
      }
    });

    it("the other, unreleased project stays private while this one is released", async () => {
      const other = sql(`select storage_path from public.design_assets where project_id = '${failing}'`);
      expect((await bucket(users.a.client).download(other)).error).not.toBeNull();
      expect(status(failing)).toBe("READY_FOR_REVIEW");
    });

    it("a released project cannot be generated again or released twice", async () => {
      expect(await startGeneration(users.admin.client, service, { projectId: verified, idempotencyKey: key("again") }, { env: {} })).toMatchObject({ ok: false, code: "not_eligible" });
      expect(await releaseProject(users.admin.client, verified)).toMatchObject({ ok: false });
      expect(jobCount(verified)).toBe(1);
    });
  });

  describe("what the screens read, after release", () => {
    it("the owner gets their two images with working links; nobody else gets anything", async () => {
      const result = await getCustomerResults(users.a.client, users.a.id, verified);
      expect(result.state).toBe("released");
      if (result.state !== "released") return;
      expect(result.assets).toHaveLength(2);
      expect(result.unavailable).toBe(0);
      expect(Object.keys(result.assets[0]).sort()).toEqual(["downloadUrl", "height", "id", "label", "url", "width"]);
      for (const asset of result.assets) {
        const response = await fetch(asset.url);
        expect(response.ok).toBe(true);
        expect(sniffImage(new Uint8Array(await response.arrayBuffer()))?.mime).toBe("image/png");
      }
      expect(await getCustomerResults(users.b.client, users.b.id, verified)).toEqual({ state: "not_found" });
    });

    it("the administrator sees the released state", async () => {
      const queue = await listGenerationQueue(users.admin.client);
      expect(queue.find((r) => r.projectId === verified)?.phase).toBe("released");
      const detail = await getGenerationDetail(users.admin.client, verified);
      expect(detail).toMatchObject({ status: "RELEASED", phase: "released" });
      expect(detail!.previews.every((p) => p.released)).toBe(true);
    });
  });

  describe("interrupted jobs and files left behind (set up directly, as a crashed run would leave them)", () => {
    const job = async (projectId: string, status: "RUNNING" | "FAILED") => {
      const inserted = await service.from("generation_jobs").insert({ project_id: projectId, provider: "mock", prompt_version: "image-prompt-1" }).select("id").single();
      expect(inserted.error).toBeNull();
      const id = (inserted.data as { id: string }).id;
      expect((await service.from("generation_jobs").update({ status: "RUNNING" }).eq("id", id)).error).toBeNull();
      if (status === "FAILED") expect((await service.from("generation_jobs").update({ status: "FAILED", error_code: "STORAGE_FAILED" }).eq("id", id)).error).toBeNull();
      return id;
    };
    const claim = async (projectId: string) => {
      const updated = await service.from("projects").update({ status: "GENERATING" }).eq("id", projectId);
      expect(updated.error).toBeNull();
    };
    const asset = async (projectId: string, jobId: string, type = "INTERIOR_CONCEPT") => {
      const path = `${projectId}/generated/${randomUUID()}.png`;
      const inserted = await service.from("design_assets").insert({ project_id: projectId, generation_job_id: jobId, asset_type: type, storage_path: path, mime_type: "image/png", width: 640, height: 360 });
      expect(inserted.error).toBeNull();
      return path;
    };

    it("a running job is left alone until it has been quiet for ten minutes, then it can be cleared, and generation works again", async () => {
      await claim(stale);
      const jobId = await job(stale, "RUNNING");
      const ledgerBefore = count("select count(*) from public.ai_usage");

      // Fresh: the real clock says it only just started.
      expect(await listGenerationQueue(users.admin.client).then((q) => q.find((r) => r.projectId === stale)?.phase)).toBe("running");
      expect(await clearStaleJob(users.admin.client, service, stale)).toMatchObject({ ok: false, message: expect.stringContaining("may still be running") });
      expect(await startGeneration(users.admin.client, service, { projectId: stale, idempotencyKey: key("blocked") }, { env: {} })).toMatchObject({ ok: false, code: "in_progress" });
      expect(sql(`select status from public.generation_jobs where id = '${jobId}'`)).toBe("RUNNING");
      await expect(clearStaleJob(users.a.client, service, stale)).rejects.toMatchObject({ status: 403 });

      // Eleven minutes later (simulated clock): abandoned.
      const later = () => Date.now() + 11 * 60_000;
      expect(await getGenerationDetail(users.admin.client, stale, later())).toMatchObject({ phase: "stale_job" });
      expect(await clearStaleJob(users.admin.client, service, stale, { now: later })).toEqual({ ok: true });
      expect(sql(`select status || '|' || error_code from public.generation_jobs where id = '${jobId}'`)).toBe("FAILED|STALE_ABANDONED");
      expect(status(stale)).toBe("GENERATION_FAILED");
      expect(sql(`select actor_id::text from public.audit_events where project_id = '${stale}' and action = 'generation.admin_cleared_stale'`)).toBe(users.admin.id);
      expect(count("select count(*) from public.ai_usage")).toBe(ledgerBefore);

      const again = await startGeneration(users.admin.client, service, { projectId: stale, idempotencyKey: key("after-clear") }, { env: {} });
      expect(again).toMatchObject({ ok: true, replayed: false });
      expect(status(stale)).toBe("READY_FOR_REVIEW");
      expect(sql(`select string_agg(status, ',' order by created_at) from public.generation_jobs where project_id = '${stale}'`)).toBe("FAILED,SUCCEEDED");
    });

    it("a file left by a failed attempt blocks release and is never shown or published", async () => {
      await claim(leftover);
      const failedJob = await job(leftover, "FAILED");
      await asset(leftover, failedJob); // the file the failed attempt could not clean up
      expect((await service.from("projects").update({ status: "GENERATION_FAILED" }).eq("id", leftover)).error).toBeNull();
      expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", leftover)).error).toBeNull();
      // A later attempt then succeeds with its own file (done directly, around the service's own refusal).
      const goodJob = await job(leftover, "RUNNING");
      await asset(leftover, goodJob);
      expect((await service.from("generation_jobs").update({ status: "SUCCEEDED" }).eq("id", goodJob)).error).toBeNull();
      expect((await service.from("projects").update({ status: "READY_FOR_REVIEW" }).eq("id", leftover)).error).toBeNull();

      const detail = await getGenerationDetail(users.admin.client, leftover);
      expect(detail).toMatchObject({ phase: "ready_for_review", leftoverCount: 1 });
      expect(detail!.releaseBlockers).toEqual(["Files from a failed or unfinished attempt are still attached to this project."]);
      expect(detail!.previews).toHaveLength(1); // only the succeeded job's file is offered

      const refused = await releaseProject(users.admin.client, leftover, { acknowledgeMock: true });
      expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("failed or unfinished attempt") });
      expect(status(leftover)).toBe("READY_FOR_REVIEW");
      expect(count(`select count(*) from public.design_assets where project_id = '${leftover}' and is_released`)).toBe(0);
      expect(await getCustomerResults(users.b.client, users.b.id, leftover)).toEqual({ state: "pending", status: "READY_FOR_REVIEW" });
      // And a new generation cannot be layered on top of it.
      expect(await startGeneration(users.admin.client, service, { projectId: leftover, idempotencyKey: key("on-top") }, { env: {} })).toMatchObject({ ok: false, code: "not_eligible" });
    });

    it("an administrator can then clear the leftover (audited, only the failed attempt's file), after which release works", async () => {
      const goodFiles = count(`select count(*) from public.design_assets d join public.generation_jobs j on j.id = d.generation_job_id where d.project_id = '${leftover}' and j.status = 'SUCCEEDED'`);
      await expect(removeLeftoverFiles(users.b.client, service, leftover)).rejects.toMatchObject({ status: 403 });
      expect(await removeLeftoverFiles(users.admin.client, service, leftover)).toMatchObject({ ok: true, removedRows: 1 });
      expect(sql(`select count(*) from public.audit_events where project_id = '${leftover}' and action = 'generation.admin_cleared_leftovers' and actor_id = '${users.admin.id}'`)).toBe("1");
      expect(count(`select count(*) from public.design_assets d join public.generation_jobs j on j.id = d.generation_job_id where d.project_id = '${leftover}' and j.status = 'SUCCEEDED'`)).toBe(goodFiles);
      expect(count(`select count(*) from public.design_assets where project_id = '${leftover}' and generation_job_id is not null`)).toBe(goodFiles);
      const detail = await getGenerationDetail(users.admin.client, leftover);
      expect(detail).toMatchObject({ leftoverCount: 0 });
      expect(detail!.releaseBlockers).toEqual([]);
      // nothing was released by the clearing itself
      expect(count(`select count(*) from public.design_assets where project_id = '${leftover}' and is_released`)).toBe(0);
      expect(status(leftover)).toBe("READY_FOR_REVIEW");
    });
  });

});
