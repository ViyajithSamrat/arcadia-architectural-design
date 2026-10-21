import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

const createServerClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => createServerClient() }));
const createServiceClient = vi.fn();
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: () => createServiceClient() }));

const pricing = { publishRuleVersion: vi.fn() };
vi.mock("@/lib/pricing/admin", () => pricing);

const { publishPricingRuleAction } = await import("@/app/(app)/admin/pricing/actions");

const INPUT = { projectType: "EMPTY_PLOT", ruleKey: "base_fee", rate: 1500, unit: "project", minimumCharge: 0, includedQuantity: 0, currency: "INR" };

function session(isAdmin: boolean | null) {
  createServerClient.mockResolvedValue(
    isAdmin === null
      ? { auth: { getUser: async () => ({ data: { user: null }, error: { message: "no session" } }) } }
      : {
          admin: isAdmin,
          auth: { getUser: async () => ({ data: { user: { id: isAdmin ? "a-admin" : "a-customer" } }, error: null }) },
          rpc: async () => ({ data: isAdmin, error: null }),
        },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("publishPricingRuleAction", () => {
  it("refuses without the confirmation, before any session or write", async () => {
    session(true);
    expect(await publishPricingRuleAction(INPUT, false)).toMatchObject({ ok: false, fieldErrors: { confirm: "Tick the box to publish." } });
    expect(await publishPricingRuleAction(INPUT, "true" as unknown as boolean)).toMatchObject({ ok: false });
    expect(createServerClient).not.toHaveBeenCalled();
    expect(pricing.publishRuleVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["a signed-out visitor", null],
    ["a customer", false],
  ] as const)("refuses %s and publishes nothing", async (_name, isAdmin) => {
    session(isAdmin);
    const result = await publishPricingRuleAction(INPUT, true);
    expect(result?.ok).toBe(false);
    expect(pricing.publishRuleVersion).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("publishes with the administrator's own session, never the service role", async () => {
    session(true);
    pricing.publishRuleVersion.mockResolvedValue({ ok: true, version: 2 });
    await expect(publishPricingRuleAction(INPUT, true)).rejects.toThrow("NEXT_REDIRECT:/admin/pricing?published=1");
    expect(pricing.publishRuleVersion).toHaveBeenCalledTimes(1);
    expect(pricing.publishRuleVersion.mock.calls[0][0]).toMatchObject({ admin: true });
    expect(pricing.publishRuleVersion.mock.calls[0][1]).toEqual(INPUT);
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/admin/pricing");
  });

  it("returns the service's refusal and field errors without redirecting", async () => {
    session(true);
    pricing.publishRuleVersion.mockResolvedValue({ ok: false, message: "Please fix the highlighted values. Nothing was saved.", fieldErrors: { rate: "Enter 0 or more." } });
    expect(await publishPricingRuleAction(INPUT, true)).toEqual({ ok: false, message: "Please fix the highlighted values. Nothing was saved.", fieldErrors: { rate: "Enter 0 or more." } });
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
