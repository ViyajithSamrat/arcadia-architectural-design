import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/auth/errors";

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

const generation = { startGeneration: vi.fn(), releaseProject: vi.fn(), clearStaleJob: vi.fn() };
vi.mock("@/lib/generation/service", () => generation);

const actions = await import("@/app/(app)/admin/generation/actions");

const ID = "33333333-3333-4333-8333-333333333333";
const KEY = "key-0123456789abcdef";
const SESSION = { session: true };
const SERVICE = { service: true };

function asAdmin() {
  createServerClient.mockResolvedValue({
    ...SESSION,
    auth: { getUser: async () => ({ data: { user: { id: "a-admin" } }, error: null }) },
    rpc: async () => ({ data: true, error: null }),
  });
  createServiceClient.mockReturnValue(SERVICE);
}
function asCustomer() {
  createServerClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "a-customer" } }, error: null }) },
    rpc: async () => ({ data: false, error: null }),
  });
  createServiceClient.mockReturnValue(SERVICE);
}
function signedOut() {
  createServerClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null }, error: { message: "no session" } }) } });
}

const calls = () => [generation.startGeneration, generation.releaseProject, generation.clearStaleJob];

beforeEach(() => {
  vi.clearAllMocks();
  redirect.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });
});

const everyAction = [
  ["startGenerationAction", () => actions.startGenerationAction(ID, KEY)],
  ["releaseProjectAction", () => actions.releaseProjectAction(ID, true, true)],
  ["clearStaleJobAction", () => actions.clearStaleJobAction(ID, true)],
] as const;

describe("who may call the generation actions", () => {
  it.each(everyAction)("%s refuses a signed-out caller and touches nothing", async (_name, call) => {
    signedOut();
    expect(await call()).toMatchObject({ ok: false, message: expect.stringMatching(/sign in/i) });
    for (const fn of calls()) expect(fn).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it.each(everyAction)("%s refuses a signed-in customer (not an administrator) and touches nothing", async (_name, call) => {
    asCustomer();
    expect(await call()).toMatchObject({ ok: false, message: expect.stringMatching(/do not have access/i) });
    for (const fn of calls()) expect(fn).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("reports a missing configuration instead of crashing", async () => {
    createServerClient.mockRejectedValue(new AuthError(503, "AUTH_NOT_CONFIGURED", "Sign-in is not available yet."));
    expect(await actions.startGenerationAction(ID, KEY)).toMatchObject({ ok: false, message: "Sign-in is not available yet." });
  });
});

describe("untrusted arguments", () => {
  beforeEach(() => asAdmin());

  it.each(["", "nope", "../../etc", "1; drop table projects", 42, null, undefined])("rejects a bad project id (%j) before the service", async (bad) => {
    const invalid = { ok: false, message: expect.stringMatching(/not valid/i) };
    expect(await actions.startGenerationAction(bad as string, KEY)).toMatchObject(invalid);
    expect(await actions.releaseProjectAction(bad as string, true, true)).toMatchObject(invalid);
    expect(await actions.clearStaleJobAction(bad as string, true)).toMatchObject(invalid);
    for (const fn of calls()) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a non-string key", async () => {
    expect(await actions.startGenerationAction(ID, 7 as unknown as string)).toMatchObject({ ok: false });
    expect(generation.startGeneration).not.toHaveBeenCalled();
  });
});

describe("explicit confirmation", () => {
  beforeEach(() => asAdmin());

  it.each([false, "on", 1, undefined, null])("will not release unless the review confirmation is exactly true (got %j)", async (value) => {
    expect(await actions.releaseProjectAction(ID, value as boolean, true)).toMatchObject({ ok: false, message: expect.stringMatching(/confirm/i) });
    expect(generation.releaseProject).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("passes the mock acknowledgement only when it is exactly true", async () => {
    generation.releaseProject.mockResolvedValue({ ok: false, message: "x" });
    for (const [given, expected] of [[true, true], [false, false], ["on", false], [undefined, false]] as const) {
      await actions.releaseProjectAction(ID, true, given as boolean);
      expect(generation.releaseProject).toHaveBeenLastCalledWith(expect.anything(), ID, { acknowledgeMock: expected });
    }
  });

  it("will not clear a job without confirmation", async () => {
    expect(await actions.clearStaleJobAction(ID, false)).toMatchObject({ ok: false });
    expect(generation.clearStaleJob).not.toHaveBeenCalled();
  });
});

describe("which client does what", () => {
  beforeEach(() => asAdmin());

  it("releases with the administrator's own session and never builds the service client", async () => {
    generation.releaseProject.mockResolvedValue({ ok: true });
    await expect(actions.releaseProjectAction(ID, true, true)).rejects.toThrow(`NEXT_REDIRECT:/admin/generation/${ID}?released=1`);
    expect(generation.releaseProject.mock.calls[0][0]).toMatchObject(SESSION);
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("starts with the session (for the role check) and the service client (for trusted writes)", async () => {
    generation.startGeneration.mockResolvedValue({ ok: true, jobId: "j", assetIds: [], replayed: false, mock: true });
    await expect(actions.startGenerationAction(ID, KEY)).rejects.toThrow(`NEXT_REDIRECT:/admin/generation/${ID}?started=1`);
    const [session, service, input] = generation.startGeneration.mock.calls[0];
    expect(session).toMatchObject(SESSION);
    expect(service).toBe(SERVICE);
    expect(input).toEqual({ projectId: ID, idempotencyKey: KEY });
  });

  it("clears a stale job and redirects to the confirmation", async () => {
    generation.clearStaleJob.mockResolvedValue({ ok: true });
    await expect(actions.clearStaleJobAction(ID, true)).rejects.toThrow(`NEXT_REDIRECT:/admin/generation/${ID}?cleared=1`);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/generation", "layout");
  });
});

describe("outcomes are server-confirmed", () => {
  beforeEach(() => asAdmin());

  it.each([
    ["startGenerationAction", () => actions.startGenerationAction(ID, KEY), generation.startGeneration],
    ["releaseProjectAction", () => actions.releaseProjectAction(ID, true, true), generation.releaseProject],
    ["clearStaleJobAction", () => actions.clearStaleJobAction(ID, true), generation.clearStaleJob],
  ] as const)("%s returns the service's message and does not redirect or revalidate on failure", async (_name, call, fn) => {
    fn.mockResolvedValue({ ok: false, code: "failed", message: "That did not work." });
    expect(await call()).toEqual({ ok: false, message: "That did not work." });
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not leak unexpected error details: a thrown non-auth error propagates to the error boundary, not to the form", async () => {
    generation.releaseProject.mockRejectedValue(new Error("secret database detail"));
    await expect(actions.releaseProjectAction(ID, true, true)).rejects.toThrow("secret database detail");
  });
});
