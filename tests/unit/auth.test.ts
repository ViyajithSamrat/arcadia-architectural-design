import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/auth/errors";
import { requireAdmin, requireUser } from "@/lib/auth/guards";
import { getServiceRoleKey, getSupabasePublicConfig, resolveAppOrigin } from "@/lib/supabase/config";

function fakeClient(user: object | null, isAdmin: unknown = false): SupabaseClient {
  return {
    auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error("no session") }) },
    rpc: vi.fn(async () => ({ data: isAdmin, error: null })),
  } as unknown as SupabaseClient;
}

describe("requireUser / requireAdmin", () => {
  it("rejects anonymous callers with 401", async () => {
    await expect(requireUser(fakeClient(null))).rejects.toMatchObject({ status: 401 });
  });
  it("rejects signed-in non-admins with 403", async () => {
    await expect(requireAdmin(fakeClient({ id: "u" }, false))).rejects.toMatchObject({ status: 403 });
  });
  it("does not treat a truthy non-true value as admin", async () => {
    await expect(requireAdmin(fakeClient({ id: "u" }, "yes"))).rejects.toBeInstanceOf(AuthError);
  });
  it("accepts an admin only when the database says so", async () => {
    const client = fakeClient({ id: "a" }, true);
    await expect(requireAdmin(client)).resolves.toMatchObject({ id: "a" });
    expect(client.rpc).toHaveBeenCalledWith("is_admin");
  });
});

describe("supabase config", () => {
  it("is null when unset, blank or malformed", () => {
    expect(getSupabasePublicConfig({})).toBeNull();
    expect(getSupabasePublicConfig({ NEXT_PUBLIC_SUPABASE_URL: " ", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" })).toBeNull();
    expect(getSupabasePublicConfig({ NEXT_PUBLIC_SUPABASE_URL: "nope", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" })).toBeNull();
  });
  it("returns the public settings when valid", () => {
    expect(
      getSupabasePublicConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }),
    ).toEqual({ url: "https://x.example.test", anonKey: "k" });
  });
  it("reads the service key only when present", () => {
    expect(getServiceRoleKey({})).toBeNull();
    expect(getServiceRoleKey({ SUPABASE_SERVICE_ROLE_KEY: "s" })).toBe("s");
  });
  it("uses the configured app origin, else the request origin", () => {
    expect(resolveAppOrigin("http://localhost:3000/a?b=1", {})).toBe("http://localhost:3000");
    expect(resolveAppOrigin("http://localhost:3000/a", { NEXT_PUBLIC_APP_URL: "https://app.example.test/x" })).toBe(
      "https://app.example.test",
    );
  });
});
