import { describe, expect, it, vi } from "vitest";
import { finishUsage, planGnaniCall, planOpenRouterBrief, refusalMessage, reserveUsage, withUsage, type UsagePlan } from "@/lib/providers/budget";
import { getGnaniReadiness, getOpenRouterConfig, type GnaniConfig } from "@/lib/providers/config";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const GNANI_ENV = {
  GNANI_VOICE_ENABLED: "true",
  GNANI_API_KEY: "k",
  GNANI_BASE_URL: "https://api.vachana.ai",
  GNANI_STT_ENDPOINT: "/stt/v3",
  GNANI_TTS_ENDPOINT: "/api/v1/tts/inference",
  GNANI_TTS_MODEL: "timbre-v2.5",
  GNANI_TTS_VOICE: "v",
  GNANI_LANGUAGES: "hi-IN",
  GNANI_CREDITS_PER_STT_SECOND: "2",
  GNANI_CREDITS_PER_TTS_CHAR: "0.5",
  GNANI_MAX_CREDITS_PER_REQUEST: "100",
  GNANI_CUSTOMER_CREDITS_PER_HOUR: "300",
  GNANI_BUDGET_CREDITS: "9999",
};
const gnani = (patch: Record<string, string> = {}): GnaniConfig => {
  const r = getGnaniReadiness({ ...GNANI_ENV, ...patch });
  if (!r.ready) throw new Error("fixture must be ready");
  return r.config;
};

const PLAN: UsagePlan = { provider: "openrouter", operation: "brief", model: "m", unit: "request", units: 1, limits: { customerLimit: 5, customerWindowMinutes: 60, globalLimit: 40, globalWindowMinutes: 1440, maxInFlight: null } };

function ledger() {
  const db = new FakeDb();
  db.rpcHandlers.ai_usage_reserve = () => ({ data: "usage-1" });
  db.rpcHandlers.ai_usage_finish = () => ({ data: null });
  return db;
}
const finished = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "ai_usage_finish").map((c) => c.args);

describe("planOpenRouterBrief", () => {
  it("plans one request against the customer's hourly limit and the 24-hour daily cap", () => {
    const config = getOpenRouterConfig({ OPENROUTER_API_KEY: "k", OPENROUTER_TEXT_MODEL: "vendor/m:free" })!;
    expect(planOpenRouterBrief(config)).toEqual({
      provider: "openrouter",
      operation: "brief",
      model: "vendor/m:free",
      unit: "request",
      units: 1,
      limits: { customerLimit: 5, customerWindowMinutes: 60, globalLimit: 40, globalWindowMinutes: 1440, maxInFlight: null },
    });
  });
});

describe("planGnaniCall: conservative estimate, fail closed", () => {
  it("estimates STT from whole seconds, rounded up, against a cumulative ceiling and one call in flight", () => {
    const result = planGnaniCall("stt", 12.2, gnani());
    expect(result).toMatchObject({ ok: true, plan: { provider: "gnani", operation: "stt", unit: "credit", units: 26 } });
    if (result.ok) {
      expect(result.plan.limits).toEqual({ customerLimit: 300, customerWindowMinutes: 60, globalLimit: 9999 > 5000 ? 5000 : 9999, globalWindowMinutes: null, maxInFlight: 1 });
    }
  });

  it("estimates TTS from characters and names the model", () => {
    const result = planGnaniCall("tts", 101, gnani());
    expect(result).toMatchObject({ ok: true, plan: { operation: "tts", units: 50.5, model: "timbre-v2.5" } });
  });

  it("refuses a call whose estimate exceeds the per-request maximum", () => {
    expect(planGnaniCall("stt", 30, gnani({ GNANI_MAX_CREDITS_PER_REQUEST: "59" }))).toEqual({ ok: false, reason: "per_request" });
    expect(planGnaniCall("stt", 30, gnani({ GNANI_MAX_CREDITS_PER_REQUEST: "60" })).ok).toBe(true);
  });

  it("refuses an unmeasurable call (zero or invalid amount)", () => {
    expect(planGnaniCall("stt", 0, gnani())).toEqual({ ok: false, reason: "unmeasurable" });
    expect(planGnaniCall("tts", Number.NaN, gnani())).toEqual({ ok: false, reason: "unmeasurable" });
    expect(planGnaniCall("stt", -3, gnani())).toEqual({ ok: false, reason: "unmeasurable" });
  });

  it("can never plan a ceiling above 5,000 credits", () => {
    const result = planGnaniCall("stt", 1, gnani({ GNANI_BUDGET_CREDITS: "1000000" }));
    expect(result.ok && result.plan.limits.globalLimit).toBe(5000);
  });
});

describe("reserveUsage", () => {
  it("passes the plan to the database function and returns the reservation id", async () => {
    const db = ledger();
    const result = await reserveUsage(db.client(), { customerId: ME, projectId: "p1" }, PLAN);
    expect(result).toEqual({ ok: true, usageId: "usage-1" });
    expect(db.rpcCalls[0]).toEqual({
      name: "ai_usage_reserve",
      args: { p_customer_id: ME, p_project_id: "p1", p_provider: "openrouter", p_operation: "brief", p_model: "m", p_unit: "request", p_units: 1, p_customer_limit: 5, p_customer_window_minutes: 60, p_global_limit: 40, p_global_window_minutes: 1440, p_max_in_flight: null },
    });
  });

  it.each([
    ["AI001", "customer_limit"],
    ["AI002", "global_limit"],
    ["AI003", "busy"],
    ["22023", "unavailable"],
    ["XX000", "unavailable"],
  ])("maps database error %s to %s", async (code, reason) => {
    const db = ledger();
    db.rpcHandlers.ai_usage_reserve = () => ({ error: { code, message: "internal detail" } });
    expect(await reserveUsage(db.client(), { customerId: ME, projectId: null }, PLAN)).toEqual({ ok: false, reason });
  });

  it("fails closed when the database cannot be reached, or answers with no id", async () => {
    const db = ledger();
    const client = db.client();
    (client as unknown as { rpc: () => never }).rpc = () => {
      throw new Error("network down");
    };
    expect(await reserveUsage(client, { customerId: ME, projectId: null }, PLAN)).toEqual({ ok: false, reason: "unavailable" });
    db.rpcHandlers.ai_usage_reserve = () => ({ data: null });
    expect(await reserveUsage(db.client(), { customerId: ME, projectId: null }, PLAN)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("customer-safe messages never mention credits, budgets or providers", () => {
    for (const reason of ["customer_limit", "global_limit", "busy", "unavailable"] as const) {
      expect(refusalMessage(reason)).not.toMatch(/credit|budget|openrouter|gnani|provider/i);
    }
  });
});

describe("withUsage", () => {
  const who = { customerId: ME, projectId: "p1" };

  it("does not run the work at all when the reservation is refused", async () => {
    const db = ledger();
    db.rpcHandlers.ai_usage_reserve = () => ({ error: { code: "AI002", message: "x" } });
    const work = vi.fn();
    expect(await withUsage(db.client(), who, PLAN, work)).toEqual({ ok: false, reason: "global_limit" });
    expect(work).not.toHaveBeenCalled();
    expect(finished(db)).toHaveLength(0);
  });

  it("records SUCCEEDED with the reported usage and request id", async () => {
    const db = ledger();
    const result = await withUsage(db.client(), who, PLAN, async (hooks) => {
      hooks.onSent?.();
      hooks.onUsage?.({ requestId: "req-9", model: "m2", units: 1 });
      return "done";
    });
    expect(result).toEqual({ ok: true, value: "done" });
    expect(finished(db)).toEqual([{ p_id: "usage-1", p_status: "SUCCEEDED", p_units_reported: 1, p_request_id: "req-9", p_model: "m2" }]);
  });

  it("records FAILED (still counted) when the call was sent and then failed, and rethrows", async () => {
    const db = ledger();
    await expect(
      withUsage(db.client(), who, PLAN, async (hooks) => {
        hooks.onSent?.();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(finished(db)[0]).toMatchObject({ p_status: "FAILED" });
  });

  it("records NOT_SENT (released) only when the adapter says nothing was sent", async () => {
    const db = ledger();
    await expect(
      withUsage(db.client(), who, PLAN, async (hooks) => {
        hooks.onNotSent?.();
        throw new Error("rejected before sending");
      }),
    ).rejects.toThrow();
    expect(finished(db)[0]).toMatchObject({ p_status: "NOT_SENT" });
  });

  it("counts a failure as a made call (FAILED) when the adapter never says anything", async () => {
    const db = ledger();
    await expect(
      withUsage(db.client(), who, PLAN, async () => {
        throw new Error("an adapter that forgot its hooks");
      }),
    ).rejects.toThrow();
    expect(finished(db)[0]).toMatchObject({ p_status: "FAILED" });
  });

  it("never releases a call that was sent, even if the adapter also says not sent", async () => {
    const db = ledger();
    await expect(
      withUsage(db.client(), who, PLAN, async (hooks) => {
        hooks.onSent?.();
        hooks.onNotSent?.();
        throw new Error("contradictory hooks");
      }),
    ).rejects.toThrow();
    expect(finished(db)[0]).toMatchObject({ p_status: "FAILED" });
  });

  it("is not broken by a failure to record the outcome", async () => {
    const db = ledger();
    db.rpcHandlers.ai_usage_finish = () => {
      throw new Error("db down");
    };
    const client = db.client();
    const original = (client as unknown as { rpc: (n: string, a: object) => Promise<unknown> }).rpc;
    (client as unknown as { rpc: (n: string, a: object) => Promise<unknown> }).rpc = async (n, a) => {
      if (n === "ai_usage_finish") throw new Error("db down");
      return original(n, a);
    };
    expect(await withUsage(client, who, PLAN, async () => 7)).toEqual({ ok: true, value: 7 });
  });
});

describe("finishUsage", () => {
  it("swallows errors so a bookkeeping failure cannot hide a result", async () => {
    const db = ledger();
    db.rpcHandlers.ai_usage_finish = () => ({ error: { message: "gone" } });
    await expect(finishUsage(db.client(), "usage-1", { status: "SUCCEEDED" })).resolves.toBeUndefined();
  });
});
