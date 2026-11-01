import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/auth/errors";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYMENT = "44444444-4444-4444-8444-444444444444";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const scheduled: (() => Promise<void> | void)[] = [];
const redirects: string[] = [];
const requireAdmin = vi.fn(async () => ({ id: ADMIN }));
const verifyPayment = vi.fn();
const rejectPayment = vi.fn();
const startAutomaticGeneration = vi.fn(async () => ({ state: "running" as const }));
const serviceClient = { marker: "service" };

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.push(to);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => scheduled.push(fn) }));
vi.mock("@/lib/auth/guards", () => ({ requireAdmin: (...a: unknown[]) => requireAdmin(...(a as [])) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ marker: "session" }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: () => serviceClient }));
vi.mock("@/lib/payments/service", () => ({
  verifyPayment: (...a: unknown[]) => verifyPayment(...a),
  rejectPayment: (...a: unknown[]) => rejectPayment(...a),
}));
vi.mock("@/lib/generation/auto", () => ({ startAutomaticGeneration: (...a: unknown[]) => startAutomaticGeneration(...(a as [])) }));

const { verifyPaymentAction, rejectPaymentAction } = await import("@/app/(app)/admin/payments/actions");

const verify = () => verifyPaymentAction(PAYMENT, "12500.00", "checked", true).catch((e: Error) => (e.message === "NEXT_REDIRECT" ? "redirected" : Promise.reject(e)));

beforeEach(() => {
  scheduled.length = 0;
  redirects.length = 0;
  requireAdmin.mockClear().mockResolvedValue({ id: ADMIN });
  verifyPayment.mockReset();
  rejectPayment.mockReset();
  startAutomaticGeneration.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("verifyPaymentAction starts generation automatically", () => {
  it("after a successful verification, schedules exactly one run for that project with the verifying administrator", async () => {
    verifyPayment.mockResolvedValue({ ok: true, projectId: PROJECT });
    expect(await verify()).toBe("redirected");
    expect(scheduled).toHaveLength(1);
    expect(startAutomaticGeneration).not.toHaveBeenCalled(); // nothing runs inside the request
    await scheduled[0]();
    expect(startAutomaticGeneration).toHaveBeenCalledTimes(1);
    expect(startAutomaticGeneration).toHaveBeenCalledWith(serviceClient, { projectId: PROJECT, actorId: ADMIN });
  });

  it("a repeated click after the first success is refused by the decision itself and schedules nothing more", async () => {
    verifyPayment.mockResolvedValueOnce({ ok: true, projectId: PROJECT }).mockResolvedValue({ ok: false, message: "This payment has already been decided." });
    await verify();
    expect(await verify()).toMatchObject({ ok: false });
    expect(await verify()).toMatchObject({ ok: false });
    expect(scheduled).toHaveLength(1);
  });

  it.each([
    ["a wrong amount", { ok: false, message: "The confirmed amount must equal the full quoted total.", fieldErrors: { confirmedAmount: "x" } }],
    ["a payment that is no longer awaiting review", { ok: false, message: "This payment has already been decided." }],
  ])("creates no generation for %s", async (_label, outcome) => {
    verifyPayment.mockResolvedValue(outcome);
    expect(await verify()).toMatchObject({ ok: false });
    expect(scheduled).toHaveLength(0);
    expect(startAutomaticGeneration).not.toHaveBeenCalled();
  });

  it("creates no generation for someone who is not an administrator, and never decides the payment", async () => {
    requireAdmin.mockRejectedValue(new AuthError(403, "FORBIDDEN", "You do not have access to this action."));
    expect(await verify()).toMatchObject({ ok: false });
    expect(verifyPayment).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });

  it("does not let a failed background start affect the decision or surface detail", async () => {
    verifyPayment.mockResolvedValue({ ok: true, projectId: PROJECT });
    startAutomaticGeneration.mockRejectedValueOnce(new Error("SECRET-DETAIL"));
    await verify();
    await expect(scheduled[0]()).resolves.toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("SECRET-DETAIL");
  });

  it("rejecting a payment never starts generation", async () => {
    rejectPayment.mockResolvedValue({ ok: true });
    await rejectPaymentAction(PAYMENT, "Receipt unreadable", "").catch(() => undefined);
    expect(scheduled).toHaveLength(0);
    expect(startAutomaticGeneration).not.toHaveBeenCalled();
  });
});
