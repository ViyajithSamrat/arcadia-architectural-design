import { afterEach, describe, expect, it } from "vitest";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from "@/lib/auth/next-path";

describe("safeNextPath", () => {
  it.each(["/projects", "/projects/33333333-3333-4333-8333-333333333333/edit", "/projects/abc/edit?step=description", "/new/interior", "/admin/payments"])("accepts the application page %s", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    "//evil.example/projects",
    "https://evil.example/projects",
    "/\\evil.example",
    "/projects/../../etc",
    "/sign-in",
    "/",
    "/api/payments",
    "/projects/x#frag",
    "/projects/<script>",
    "javascript:alert(1)",
    "",
    "/projects/" + "a".repeat(300),
    42,
    null,
  ])("rejects %s", (path) => {
    expect(safeNextPath(path)).toBeNull();
  });

  it("falls back to My projects", () => {
    expect(DEFAULT_AFTER_SIGN_IN).toBe("/projects");
  });
});

describe("POST /api/auth/sign-in with a return path", () => {
  const KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("still rejects a cross-origin request before anything else", async () => {
    const res = await signIn(
      new Request("http://localhost:3000/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ email: "a@example.com", next: "/projects" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
