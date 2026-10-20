import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockBriefProvider, type BriefProvider } from "@/lib/journeys/brief";
import { createBrief, createDraftProject, saveStep } from "@/lib/journeys/service";
import { planOpenRouterBrief, reserveUsage, finishUsage, type UsagePlan } from "@/lib/providers/budget";
import { GNANI_HARD_CEILING_CREDITS } from "@/lib/providers/config";
import { REQUIREMENTS } from "../unit/support/journey-fixtures";

/**
 * Real-PostgreSQL verification of the AI usage ledger and budget guard (migration 7), against
 * the LOCAL Supabase stack only. No AI provider is contacted: briefs use a stub provider and
 * no network call leaves the machine. Run with:
 *
 *   LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/ai-usage-live.live.test.ts
 *
 * The ledger is append-only by design, so between cases the rows of the users THIS suite created are
 * removed with the database owner by briefly disabling the guard trigger. That is a LOCAL TEST FIXTURE
 * step only; rows of any other user are never deleted (the suite refuses to run if there are any).
 */

const ENABLED = process.env.LIVE_SUPABASE === "1";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_CONTAINER = "supabase_db_Gnani_intern";
const PASSWORD = "Live-test-" + randomUUID();
const RUN = randomUUID().slice(0, 8);

if (ENABLED && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) {
  throw new Error("Refusing to run live tests: NEXT_PUBLIC_SUPABASE_URL is not a local address.");
}

const PSQL = ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
function sql(query: string): string {
  return execFileSync("docker", [...PSQL, "-c", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Ledger rows belong to customers. This suite only ever removes rows of the users it created itself,
// and refuses to run if the ledger holds anyone else's rows (it assumes an otherwise empty ledger).
const testUserIds: string[] = [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ownedList(): string {
  if (testUserIds.length === 0 || !testUserIds.every((id) => UUID.test(id))) {
    throw new Error("Refusing to touch the ledger: the test-owned user ids are not established.");
  }
  return testUserIds.map((id) => `'${id}'`).join(",");
}
const foreignRows = () => Number(sql(`select count(*) from public.ai_usage where customer_id not in (${ownedList()})`));
const resetLedger = () =>
  sql(
    `alter table public.ai_usage disable trigger trg_10_ai_usage_guard; delete from public.ai_usage where customer_id in (${ownedList()}); alter table public.ai_usage enable trigger trg_10_ai_usage_guard`,
  );
const ledgerCount = () => Number(sql(`select count(*) from public.ai_usage where customer_id in (${ownedList()})`));

describe.skipIf(!ENABLED)("live local ai_usage budget guard", () => {
  let service: SupabaseClient;
  const users = {} as Record<"a" | "b" | "admin", { id: string; client: SupabaseClient }>;

  async function makeUser(label: "a" | "b" | "admin") {
    const email = `ai-${label}-${RUN}@example.test`;
    const created = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    expect(created.error).toBeNull();
    const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await client.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
    users[label] = { id: created.data.user!.id, client };
    testUserIds.push(created.data.user!.id);
  }

  // Default: Gnani speech-to-text, the shape the application uses.
  const rpc = (customer: string, units: number, o: Partial<{ op: string; provider: string; unit: string; cl: number; gl: number; gw: number | null; inflight: number | null }> = {}) =>
    service.rpc("ai_usage_reserve", {
      p_customer_id: customer,
      p_project_id: null,
      p_provider: o.provider ?? "gnani",
      p_operation: o.op ?? (o.provider === "openrouter" ? "brief" : "stt"),
      p_model: "m",
      p_unit: o.unit ?? (o.provider === "openrouter" ? "request" : "credit"),
      p_units: units,
      p_customer_limit: o.cl ?? 1000,
      p_customer_window_minutes: 60,
      p_global_limit: o.gl ?? 10,
      p_global_window_minutes: o.gw ?? null,
      p_max_in_flight: o.inflight ?? null,
    });

  beforeAll(async () => {
    expect(URL_ && ANON && SERVICE).toBeTruthy();
    service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const label of ["a", "b", "admin"] as const) await makeUser(label);
    sql(`insert into public.admin_users (user_id) values ('${users.admin.id}') on conflict do nothing`);
    // Fail closed: the cumulative ceiling tests need an otherwise empty ledger, and other rows must never be deleted.
    expect(foreignRows(), "ai_usage holds rows of other users: refusing to run").toBe(0);
    resetLedger();
  });
  afterEach(() => {
    resetLedger();
  });
  afterAll(() => {
    expect(foreignRows()).toBe(0);
  });

  it("is applied: the table, both functions and the privileges are as designed", () => {
    expect(sql("select to_regclass('public.ai_usage')")).toBe("ai_usage");
    expect(sql("select count(*) from pg_proc where proname in ('ai_usage_reserve','ai_usage_finish')")).toBe("2");
    expect(sql("select has_table_privilege('service_role','public.ai_usage','DELETE')::text || has_table_privilege('service_role','public.ai_usage','TRUNCATE')::text")).toBe("falsefalse");
  });

  describe("concurrency on a real connection pool", () => {
    it("20 parallel reservations of 3 credits against a ceiling of 10 give exactly 3 successes, over 5 rounds", async () => {
      for (let round = 0; round < 5; round++) {
        resetLedger();
        const results = await Promise.all(Array.from({ length: 20 }, () => rpc(users.a.id, 3)));
        const ok = results.filter((r) => !r.error);
        expect(ok, `round ${round}`).toHaveLength(3);
        expect(results.filter((r) => r.error).every((r) => r.error?.code === "AI002")).toBe(true);
        expect(Number(sql("select sum(units_estimated) from public.ai_usage"))).toBe(9);
      }
    });

    it("10 parallel reservations with one call allowed in flight give exactly 1", async () => {
      for (let round = 0; round < 3; round++) {
        resetLedger();
        const results = await Promise.all(Array.from({ length: 10 }, () => rpc(users.a.id, 1, { gl: 100, inflight: 1 })));
        expect(results.filter((r) => !r.error), `round ${round}`).toHaveLength(1);
        expect(results.filter((r) => r.error).every((r) => r.error?.code === "AI003")).toBe(true);
      }
    });

    it("10 parallel reservations by one customer cannot pass the customer limit", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => rpc(users.a.id, 2, { cl: 7, gl: 100 })));
      expect(results.filter((r) => !r.error)).toHaveLength(3); // 3 x 2 = 6 <= 7
      expect(results.filter((r) => r.error).every((r) => r.error?.code === "AI001")).toBe(true);
    });

    it("two parallel finishes give exactly one success", async () => {
      const { data: id } = await rpc(users.a.id, 1);
      const finishes = await Promise.all([1, 2].map((n) => service.rpc("ai_usage_finish", { p_id: id, p_status: "SUCCEEDED", p_units_reported: n, p_request_id: `r${n}`, p_model: null })));
      expect(finishes.filter((f) => !f.error)).toHaveLength(1);
      expect(finishes.find((f) => f.error)?.error?.code).toBe("P0002");
    });

    it("a lock held by another session makes the reservation fail within about 3 seconds, then it recovers", async () => {
      const holder = spawn("docker", [...PSQL, "-c", "select pg_advisory_lock(hashtextextended('ai_usage:gnani', 0)); select pg_sleep(9)"], { stdio: "ignore" });
      const closed = new Promise<void>((resolve) => holder.on("close", () => resolve()));
      await new Promise((r) => setTimeout(r, 2000)); // let the holder take the lock
      const started = Date.now();
      const { data, error } = await rpc(users.a.id, 1);
      const elapsed = Date.now() - started;
      expect(data).toBeNull();
      expect(error?.code).toBe("55P03");
      expect(elapsed).toBeGreaterThan(2500);
      expect(elapsed).toBeLessThan(6000);
      expect(ledgerCount()).toBe(0);
      await closed;
      expect((await rpc(users.a.id, 1)).error).toBeNull(); // the lock is gone with its session
    }, 30_000);
  });

  describe("PostgREST error codes", () => {
    it("returns AI001, AI002, AI003 and 22023 as error.code", async () => {
      await rpc(users.a.id, 3, { cl: 3, gl: 100, inflight: 5 });
      expect((await rpc(users.a.id, 1, { cl: 3, gl: 100 })).error?.code).toBe("AI001");
      expect((await rpc(users.b.id, 100, { cl: 1000, gl: 10 })).error?.code).toBe("AI002");
      expect((await rpc(users.b.id, 1, { gl: 100, inflight: 1 })).error?.code).toBe("AI003");
      expect((await rpc(users.b.id, 0)).error?.code).toBe("22023");
      expect((await rpc(users.b.id, 1, { unit: "request" })).error?.code).toBe("22023");
      expect((await rpc(users.b.id, 1, { gw: 60 })).error?.code).toBe("22023");
    });

    it("maps to the application's refusal reasons through reserveUsage", async () => {
      const plan = (o: Partial<UsagePlan["limits"]>): UsagePlan => ({
        provider: "gnani", operation: "stt", model: null, unit: "credit", units: 4,
        limits: { customerLimit: 5, customerWindowMinutes: 60, globalLimit: 6, globalWindowMinutes: null, maxInFlight: null, ...o },
      });
      const who = { customerId: users.a.id, projectId: null };
      const first = await reserveUsage(service, who, plan({}));
      expect(first.ok).toBe(true);
      expect(await reserveUsage(service, who, plan({}))).toEqual({ ok: false, reason: "customer_limit" });
      expect(await reserveUsage(service, { customerId: users.b.id, projectId: null }, plan({}))).toEqual({ ok: false, reason: "global_limit" });
      expect(await reserveUsage(service, { customerId: users.b.id, projectId: null }, plan({ customerLimit: 100, globalLimit: 100, maxInFlight: 1 }))).toEqual({ ok: false, reason: "busy" });
      expect(await reserveUsage(service, who, plan({ customerLimit: 0 }))).toEqual({ ok: false, reason: "unavailable" });
      if (first.ok) await finishUsage(service, first.usageId, { status: "FAILED", unitsReported: 0 });
    });
  });

  describe("limits and arithmetic", () => {
    it("clamps the Gnani ceiling to 5,000 whatever limit is passed", async () => {
      expect(GNANI_HARD_CEILING_CREDITS).toBe(5000);
      expect((await rpc(users.a.id, 3000, { cl: 1e6, gl: 1e6 })).error).toBeNull();
      expect((await rpc(users.b.id, 3000, { cl: 1e6, gl: 1e6 })).error?.code).toBe("AI002");
      expect((await rpc(users.b.id, 2000, { cl: 1e6, gl: 1e6 })).error).toBeNull();
      expect((await rpc(users.b.id, 0.01, { cl: 1e6, gl: 1e6 })).error?.code).toBe("AI002");
    });

    it("refuses NaN, Infinity, zero and an oversized amount, and rounds a fraction up", () => {
      for (const bad of ["'NaN'", "'Infinity'", "0", "-1", "1e10"]) {
        expect(() => sql(`select public.ai_usage_reserve('${users.a.id}', null, 'gnani', 'stt', 'm', 'credit', ${bad}::numeric, 3, 60, 10, null, null)`)).toThrow(/missing or invalid/);
      }
      for (const bad of ["'NaN'", "'Infinity'"]) {
        expect(() => sql(`select public.ai_usage_reserve('${users.a.id}', null, 'gnani', 'stt', 'm', 'credit', 1, ${bad}::numeric, 60, 10, null, null)`)).toThrow(/missing or invalid/);
        expect(() => sql(`select public.ai_usage_reserve('${users.a.id}', null, 'gnani', 'stt', 'm', 'credit', 1, 3, 60, ${bad}::numeric, null, null)`)).toThrow(/missing or invalid/);
      }
      expect(ledgerCount()).toBe(0);
      sql(`select public.ai_usage_reserve('${users.a.id}', null, 'gnani', 'stt', 'm', 'credit', 0.004, 3, 60, 10, null, null)`);
      expect(sql("select units_estimated from public.ai_usage")).toBe("0.01");
    });

    it("shares one customer limit across speech-to-text and text-to-speech, and never refunds a failed call", async () => {
      expect((await rpc(users.a.id, 2, { cl: 3, gl: 100, op: "stt" })).error).toBeNull();
      expect((await rpc(users.a.id, 2, { cl: 3, gl: 100, op: "tts" })).error?.code).toBe("AI001");
      const { data: id } = await rpc(users.b.id, 3, { cl: 3, gl: 100 });
      await service.rpc("ai_usage_finish", { p_id: id, p_status: "FAILED", p_units_reported: 0, p_request_id: null, p_model: null });
      expect((await rpc(users.b.id, 1, { cl: 3, gl: 100 })).error?.code).toBe("AI001");
    });
  });

  describe("access control", () => {
    it("a customer is denied on reserve, finish, insert, update and delete, and reads no rows", async () => {
      const { data: id } = await rpc(users.a.id, 1);
      const c = users.a.client;
      expect((await c.rpc("ai_usage_reserve", { p_customer_id: users.a.id, p_project_id: null, p_provider: "gnani", p_operation: "stt", p_model: null, p_unit: "credit", p_units: 1, p_customer_limit: 3, p_customer_window_minutes: 60, p_global_limit: 10, p_global_window_minutes: null, p_max_in_flight: null })).error).not.toBeNull();
      expect((await c.rpc("ai_usage_finish", { p_id: id, p_status: "FAILED", p_units_reported: null, p_request_id: null, p_model: null })).error).not.toBeNull();
      expect((await c.from("ai_usage").insert({ customer_id: users.a.id, provider: "gnani", operation: "stt", unit: "credit", units_estimated: 1 })).error).not.toBeNull();
      const upd = await c.from("ai_usage").update({ units_estimated: 1 }).eq("id", id).select();
      expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
      const del = await c.from("ai_usage").delete().eq("id", id).select();
      expect(del.error !== null || (del.data ?? []).length === 0).toBe(true);
      expect((await c.from("ai_usage").select("id")).data ?? []).toHaveLength(0);
      expect(sql(`select status from public.ai_usage where id = '${id}'`)).toBe("RESERVED");
    });

    it("an anonymous caller is denied, and an administrator can read the ledger", async () => {
      await rpc(users.a.id, 1);
      const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await anon.from("ai_usage").select("id")).error).not.toBeNull();
      expect((await users.admin.client.from("ai_usage").select("id")).data).toHaveLength(1);
      expect((await users.admin.client.rpc("ai_usage_finish", { p_id: randomUUID(), p_status: "FAILED", p_units_reported: null, p_request_id: null, p_model: null })).error).not.toBeNull();
    });

    it("the service role cannot DELETE or TRUNCATE, and neither can the table owner", async () => {
      await rpc(users.a.id, 1);
      expect(() => sql("set role service_role; delete from public.ai_usage")).toThrow(/permission denied/);
      expect(() => sql("set role service_role; truncate public.ai_usage")).toThrow(/permission denied/);
      expect(() => sql("delete from public.ai_usage")).toThrow(/cannot be deleted or truncated/);
      expect(() => sql("truncate public.ai_usage")).toThrow(/cannot be deleted or truncated/);
      expect(ledgerCount()).toBe(1);
    });

    it("refuses to run under REPEATABLE READ", () => {
      expect(() =>
        sql(`begin isolation level repeatable read; set local role service_role; select public.ai_usage_reserve('${users.a.id}', null, 'gnani', 'stt', 'm', 'credit', 1, 3, 60, 10, null, null); commit`),
      ).toThrow(/requires READ COMMITTED/);
    });
  });

  describe("createBrief against the real ledger (stub provider, no network)", () => {
    let projectId = "";
    const config = { apiKey: "stub", baseUrl: "https://openrouter.ai/api/v1", model: "stub/model", referer: null, title: null, timeoutMs: 1000, briefsPerHour: 2, dailyRequestCap: 50 };
    const stub = (generate: BriefProvider["generate"]): BriefProvider => ({ id: "openrouter", usage: planOpenRouterBrief(config), generate });

    beforeAll(async () => {
      const created = await createDraftProject(users.a.client, users.a.id, "EMPTY_PLOT");
      expect(created.ok).toBe(true);
      projectId = (created as { ok: true; projectId: string }).projectId;
      for (const [stepId, data] of Object.entries(REQUIREMENTS.EMPTY_PLOT)) {
        expect(await saveStep(users.a.client, users.a.id, projectId, stepId, data)).toMatchObject({ ok: true });
      }
    });

    it("records SUCCEEDED, then FAILED, and a refusal makes no call", async () => {
      const ok = vi.fn(async (input, hooks) => {
        hooks?.onSent?.();
        hooks?.onUsage?.({ requestId: "stub-1", model: "stub/model", units: 1 });
        return mockBriefProvider.generate(input);
      });
      expect(await createBrief(users.a.client, service, users.a.id, projectId, stub(ok))).toEqual({ ok: true });
      expect(sql("select status || ':' || units_estimated || ':' || coalesce(units_reported::text,'-') from public.ai_usage")).toBe("SUCCEEDED:1.00:1.00");

      const failing = vi.fn(async (_input, hooks) => {
        hooks?.onSent?.();
        throw new Error("provider exploded");
      });
      expect(await createBrief(users.a.client, service, users.a.id, projectId, stub(failing))).toMatchObject({ ok: false });
      expect(sql("select string_agg(status, ',' order by created_at) from public.ai_usage")).toBe("SUCCEEDED,FAILED");

      const refused = vi.fn();
      const result = await createBrief(users.a.client, service, users.a.id, projectId, stub(refused)); // briefsPerHour is 2
      expect(result).toMatchObject({ ok: false });
      expect(refused).not.toHaveBeenCalled();
      expect(ledgerCount()).toBe(2);
    });
  });
});
