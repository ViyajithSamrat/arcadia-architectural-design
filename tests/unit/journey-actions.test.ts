import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/auth/errors";

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const createServerClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => createServerClient() }));
const createServiceClient = vi.fn();
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: () => createServiceClient() }));

const service = {
  createDraftProject: vi.fn(),
  saveStep: vi.fn(),
  createBrief: vi.fn(),
  reviewBrief: vi.fn(),
  createQuote: vi.fn(),
  acceptQuote: vi.fn(),
};
vi.mock("@/lib/journeys/service", () => service);

const actions = await import("@/app/(app)/projects/actions");

const ID = "33333333-3333-4333-8333-333333333333";
const QUOTE = "44444444-4444-4444-8444-444444444444";

function signedIn(userId = "11111111-1111-4111-8111-111111111111") {
  createServerClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) } });
  createServiceClient.mockReturnValue({ service: true });
}
function signedOut() {
  createServerClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null }, error: { message: "no session" } }) } });
}

beforeEach(() => {
  vi.clearAllMocks();
  redirect.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });
});

describe("authentication on every action", () => {
  it.each([
    ["startProjectAction", () => actions.startProjectAction("interior")],
    ["saveStepAction", () => actions.saveStepAction(ID, "space", {})],
    ["createBriefAction", () => actions.createBriefAction(ID)],
    ["reviewBriefAction", () => actions.reviewBriefAction(ID, "approve", "text", true)],
    ["createQuoteAction", () => actions.createQuoteAction(ID)],
    ["acceptQuoteAction", () => actions.acceptQuoteAction(ID, QUOTE)],
  ])("%s refuses a signed-out caller and touches nothing", async (_name, call) => {
    signedOut();
    const result = await call();
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/sign in/i) });
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("reports a missing configuration instead of crashing", async () => {
    createServerClient.mockRejectedValue(new AuthError(503, "AUTH_NOT_CONFIGURED", "Sign-in is not available yet."));
    expect(await actions.createQuoteAction(ID)).toMatchObject({ ok: false, message: "Sign-in is not available yet." });
  });
});

describe("untrusted arguments", () => {
  beforeEach(() => signedIn());

  it("rejects malformed ids, step ids, intents and payloads before reaching the service", async () => {
    const bad = { ok: false, message: expect.stringMatching(/not valid/i) };
    expect(await actions.startProjectAction("tower")).toMatchObject(bad);
    expect(await actions.saveStepAction("not-an-id", "space", {})).toMatchObject(bad);
    expect(await actions.saveStepAction(ID, "space", [] as unknown as Record<string, unknown>)).toMatchObject(bad);
    expect(await actions.saveStepAction(ID, "space", null as unknown as Record<string, unknown>)).toMatchObject(bad);
    expect(await actions.createBriefAction("1; drop table")).toMatchObject(bad);
    expect(await actions.reviewBriefAction(ID, "release", "x", true)).toMatchObject(bad);
    expect(await actions.acceptQuoteAction(ID, "nope")).toMatchObject(bad);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("outcomes", () => {
  beforeEach(() => signedIn());

  it("passes the signed-in user's id, never an id from the caller, to the service", async () => {
    service.saveStep.mockResolvedValue({ ok: true, nextStepId: "rooms" });
    await expect(actions.saveStepAction(ID, "space", { plotWidth: 30 })).rejects.toThrow("NEXT_REDIRECT:/projects/" + ID + "/edit?step=rooms");
    expect(service.saveStep).toHaveBeenCalledWith(expect.anything(), "11111111-1111-4111-8111-111111111111", ID, "space", { plotWidth: 30 });
  });

  it("sends the customer to the brief after the last step", async () => {
    service.saveStep.mockResolvedValue({ ok: true, nextStepId: null });
    await expect(actions.saveStepAction(ID, "description", {})).rejects.toThrow(`NEXT_REDIRECT:/projects/${ID}/brief`);
  });

  it("returns field errors without redirecting", async () => {
    service.saveStep.mockResolvedValue({ ok: false, message: "Please fix the highlighted answers.", fieldErrors: { plotWidth: "Enter 1 or more." } });
    expect(await actions.saveStepAction(ID, "space", {})).toEqual({
      ok: false,
      message: "Please fix the highlighted answers.",
      fieldErrors: { plotWidth: "Enter 1 or more." },
      missing: undefined,
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("starts a project and opens its first step", async () => {
    service.createDraftProject.mockResolvedValue({ ok: true, projectId: ID });
    await expect(actions.startProjectAction("landscape")).rejects.toThrow(`NEXT_REDIRECT:/projects/${ID}/edit`);
    expect(service.createDraftProject).toHaveBeenCalledWith(expect.anything(), expect.any(String), "LANDSCAPE");
  });

  it("goes to the quote only after the brief is approved", async () => {
    service.reviewBrief.mockResolvedValue({ ok: true });
    await expect(actions.reviewBriefAction(ID, "approve", "text", true)).rejects.toThrow(`NEXT_REDIRECT:/projects/${ID}/quote`);
    await expect(actions.reviewBriefAction(ID, "save", "text", false)).rejects.toThrow(`NEXT_REDIRECT:/projects/${ID}/brief?saved=1`);
  });

  it("treats a non-boolean confirmation as not confirmed", async () => {
    service.reviewBrief.mockResolvedValue({ ok: false, message: "Please confirm" });
    await actions.reviewBriefAction(ID, "approve", "text", "true" as unknown as boolean);
    expect(service.reviewBrief.mock.calls[0][6]).toBe(false);
  });

  it("relays 'Pricing not configured' and stays on the page", async () => {
    service.createQuote.mockResolvedValue({ ok: false, message: "Pricing not configured. A quote cannot be prepared yet." });
    expect(await actions.createQuoteAction(ID)).toMatchObject({ ok: false, message: expect.stringMatching(/Pricing not configured/) });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("ends the journey at the quote page after acceptance", async () => {
    service.acceptQuote.mockResolvedValue({ ok: true });
    await expect(actions.acceptQuoteAction(ID, QUOTE)).rejects.toThrow(`NEXT_REDIRECT:/projects/${ID}/quote`);
  });
});
