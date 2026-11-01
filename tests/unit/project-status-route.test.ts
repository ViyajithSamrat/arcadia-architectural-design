import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchIntervalMs } from "@/lib/generation/watch";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

let db: FakeDb;
let signedInAs: string | null;
const scheduled: (() => Promise<void> | void)[] = [];
const reconcile = vi.fn(async () => ({ state: "idle" as const }));

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => Promise<void> | void) => scheduled.push(fn) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    const client = db.client() as unknown as Record<string, unknown>;
    client.auth = { getUser: async () => (signedInAs ? { data: { user: { id: signedInAs } }, error: null } : { data: { user: null }, error: { message: "no session" } }) };
    return client as unknown as SupabaseClient;
  },
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: () => db.client() }));
vi.mock("@/lib/generation/auto", () => ({ reconcileGeneration: (...args: unknown[]) => reconcile(...(args as [])) }));

const { GET } = await import("@/app/api/projects/[id]/status/route");
const call = (id = PROJECT) => GET(new Request(`http://localhost:3000/api/projects/${id}/status`), { params: Promise.resolve({ id }) });
const setStatus = (status: string) => db.seed("projects", [{ id: PROJECT, customer_id: ME, status }]);

beforeEach(() => {
  db = new FakeDb();
  signedInAs = ME;
  scheduled.length = 0;
  reconcile.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/projects/[id]/status", () => {
  it("tells the owner the status word and nothing else", async () => {
    setStatus("GENERATING");
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, status: "GENERATING" });
  });

  it("answers 401 when signed out, and 404 for someone else's project exactly as for a missing one", async () => {
    setStatus("GENERATING");
    signedInAs = null;
    expect((await call()).status).toBe(401);
    signedInAs = OTHER;
    const other = await call();
    signedInAs = ME;
    const missing = await call("55555555-5555-4555-8555-555555555555");
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect((await call("not-a-uuid")).status).toBe(404);
    expect(scheduled).toHaveLength(0);
  });

  it.each(["PAYMENT_VERIFIED", "READY_FOR_REVIEW"])("schedules the safety-net check after the response for %s", async (status) => {
    setStatus(status);
    await call();
    expect(scheduled).toHaveLength(1);
    expect(reconcile).not.toHaveBeenCalled();
    await scheduled[0]();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), PROJECT);
  });

  it.each(["DRAFT", "PAYMENT_PROOF_SUBMITTED", "GENERATING", "GENERATION_FAILED", "RELEASED"])("starts no work for %s", async (status) => {
    setStatus(status);
    await call();
    expect(scheduled).toHaveLength(0);
  });

  it("never lets a failed background check surface to the customer or leak detail", async () => {
    setStatus("PAYMENT_VERIFIED");
    reconcile.mockRejectedValueOnce(new Error("SECRET-DETAIL"));
    expect((await call()).status).toBe(200);
    await expect(scheduled[0]()).resolves.toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("SECRET-DETAIL");
  });

  it("does not use any request value to decide what runs: the work is keyed only by the project id in the path", async () => {
    setStatus("PAYMENT_VERIFIED");
    await GET(new Request(`http://localhost:3000/api/projects/${PROJECT}/status?actor=admin&key=x`, { headers: { "x-actor": "admin" } }), { params: Promise.resolve({ id: PROJECT }) });
    await scheduled[0]();
    expect(reconcile.mock.calls[0]).toEqual([expect.anything(), PROJECT]);
  });
});

describe("watchIntervalMs", () => {
  it("watches only statuses that change by themselves, and not the ones that wait for the customer or an administrator", () => {
    expect(watchIntervalMs("PAYMENT_VERIFIED")).toBe(6_000);
    expect(watchIntervalMs("GENERATING")).toBe(6_000);
    expect(watchIntervalMs("PAYMENT_PROOF_SUBMITTED")).toBe(10_000);
    expect(watchIntervalMs("READY_FOR_REVIEW")).toBe(15_000);
    for (const s of ["DRAFT", "BRIEF_REVIEW", "QUOTED", "AWAITING_PAYMENT", "PAYMENT_REJECTED", "GENERATION_FAILED", "RELEASED", "CANCELLED"] as const) {
      expect(watchIntervalMs(s)).toBeNull();
    }
  });
});
