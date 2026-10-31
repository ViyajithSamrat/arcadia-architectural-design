import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<object>()), connection: async () => undefined }));

// One fake Supabase Auth client for every route; each test sets what its methods answer.
const auth = {
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signInWithOAuth: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  exchangeCodeForSession: vi.fn(),
};
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth, rpc }) }));

const getAuthProviders = vi.fn();
vi.mock("@/lib/auth/credentials", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAuthProviders: () => getAuthProviders(),
}));

const getAccountSummary = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getAccountSummary: () => getAccountSummary() }));

const { POST: signIn } = await import("@/app/api/auth/sign-in/route");
const { POST: signUp } = await import("@/app/api/auth/sign-up/route");
const { POST: oauth } = await import("@/app/api/auth/oauth/route");
const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
const { POST: updatePassword } = await import("@/app/api/auth/update-password/route");
const { POST: signOut } = await import("@/app/api/auth/sign-out/route");
const { GET: callback } = await import("@/app/auth/callback/route");
const { default: ResetPasswordPage } = await import("@/app/(app)/reset-password/page");
const { AccessGate } = await import("@/components/journey/access-gate");
const credentials = await vi.importActual<typeof import("@/lib/auth/credentials")>("@/lib/auth/credentials");

const KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_APP_URL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const SUPABASE = "https://x.example.test";

beforeEach(() => {
  for (const fn of [...Object.values(auth), rpc, getAuthProviders, getAccountSummary]) fn.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "k";
  delete process.env.NEXT_PUBLIC_APP_URL;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const json = async (res: Response) => (await res.json()) as { ok?: boolean; redirect?: string; url?: string; confirm?: boolean; message?: string; error?: { code: string; message: string } };
const GOOD = { email: "new.customer@example.test", password: "correct-horse-battery" };

describe("every auth route", () => {
  it.each([
    ["/api/auth/sign-in", signIn],
    ["/api/auth/sign-up", signUp],
    ["/api/auth/oauth", oauth],
    ["/api/auth/forgot-password", forgot],
    ["/api/auth/update-password", updatePassword],
    ["/api/auth/sign-out", signOut],
  ] as const)("%s refuses a cross-origin request before contacting Supabase", async (path, handler) => {
    const res = await handler(post(path, { ...GOOD, provider: "google" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    for (const fn of Object.values(auth)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/auth/sign-in", signIn],
    ["/api/auth/sign-up", signUp],
    ["/api/auth/oauth", oauth],
    ["/api/auth/forgot-password", forgot],
    ["/api/auth/update-password", updatePassword],
  ] as const)("%s reports a clear disabled state when Supabase is not configured", async (path, handler) => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const res = await handler(post(path, { ...GOOD, provider: "google" }));
    expect(res.status).toBe(503);
    expect((await json(res)).error?.code).toBe("AUTH_NOT_CONFIGURED");
  });
});

describe("POST /api/auth/sign-in (email and password)", () => {
  it("rejects missing input before contacting Supabase", async () => {
    expect((await signIn(post("/api/auth/sign-in", { email: "not-an-email", password: "x" }))).status).toBe(400);
    expect((await signIn(post("/api/auth/sign-in", { email: GOOD.email, password: "" }))).status).toBe(400);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("gives one message for a wrong email or password, without the raw Supabase text", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { code: "invalid_credentials", status: 400, message: "Invalid login credentials" } });
    const res = await signIn(post("/api/auth/sign-in", GOOD));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toEqual({ code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." });
  });

  it("explains an unconfirmed email", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { code: "email_not_confirmed", status: 400 } });
    const res = await signIn(post("/api/auth/sign-in", GOOD));
    expect((await json(res)).error?.code).toBe("EMAIL_NOT_CONFIRMED");
  });

  it("reports rate limiting", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { code: "over_request_rate_limit", status: 429 } });
    expect((await signIn(post("/api/auth/sign-in", GOOD))).status).toBe(429);
  });

  it("returns to the allow-listed page, with the sign-in marker, and only that", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
    const ok = await json(await signIn(post("/api/auth/sign-in", { ...GOOD, next: "/projects/abc/payment" })));
    expect(ok).toEqual({ ok: true, redirect: "/projects/abc/payment?signed_in=1" });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: GOOD.email, password: GOOD.password });

    for (const next of ["https://evil.example", "//evil.example", "/sign-in"]) {
      expect((await json(await signIn(post("/api/auth/sign-in", { ...GOOD, next })))).redirect).toBe("/projects?signed_in=1");
    }
  });
});

describe("POST /api/auth/sign-up (self-service registration)", () => {
  it("rejects a short password before contacting Supabase", async () => {
    const res = await signUp(post("/api/auth/sign-up", { email: GOOD.email, password: "short" }));
    expect(res.status).toBe(400);
    expect((await json(res)).error?.message).toMatch(/at least 8 characters/);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("creates an ordinary account: no role, metadata or admin call, confirmation link to the existing callback", async () => {
    auth.signUp.mockResolvedValue({ data: { session: { access_token: "t" }, user: { id: "u" } }, error: null });
    const res = await signUp(post("/api/auth/sign-up", { ...GOOD, next: "/new/interior" }));
    expect(await json(res)).toEqual({ ok: true, redirect: "/new/interior?signed_in=1" });
    expect(auth.signUp).toHaveBeenCalledWith({
      email: GOOD.email,
      password: GOOD.password,
      options: { emailRedirectTo: "http://localhost:3000/auth/callback" },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ignores a role sent by the browser", async () => {
    auth.signUp.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
    await signUp(post("/api/auth/sign-up", { ...GOOD, role: "admin", data: { is_admin: true } }));
    expect(auth.signUp.mock.calls[0][0]).not.toHaveProperty("options.data");
    expect(JSON.stringify(auth.signUp.mock.calls[0][0])).not.toMatch(/admin/);
  });

  it("asks to confirm the email when the Auth server requires it, remembering the return path", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null, user: { id: "u", identities: [] } }, error: null });
    const res = await signUp(post("/api/auth/sign-up", { ...GOOD, next: "/projects" }));
    const body = await json(res);
    expect(body.confirm).toBe(true);
    expect(body.message).toMatch(/confirmation link in this same browser window/);
    expect(body.message).toMatch(/If you already have an account, sign in instead/);
    expect(res.headers.get("set-cookie")).toMatch(/aad_next=%2Fprojects; Path=\/auth\/callback;.*Max-Age=900;.*HttpOnly/i);
  });

  it("says clearly when the email is already registered", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null, user: null }, error: { code: "user_already_exists", status: 422 } });
    const res = await signUp(post("/api/auth/sign-up", GOOD));
    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toMatch(/already exists/);
  });

  it("explains a password Supabase rejects as weak", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null, user: null }, error: { code: "weak_password", status: 422 } });
    expect((await json(await signUp(post("/api/auth/sign-up", GOOD)))).error?.code).toBe("WEAK_PASSWORD");
  });

  it("hides an unexpected Supabase failure behind a generic message", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null, user: null }, error: { code: "unexpected_failure", status: 500, message: "db exploded at 10.0.0.1" } });
    const res = await signUp(post("/api/auth/sign-up", GOOD));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await json(res))).not.toMatch(/exploded|10\.0\.0\.1/);
  });
});

describe("POST /api/auth/oauth (Continue with Google)", () => {
  it("refuses when the Auth server does not have Google switched on", async () => {
    getAuthProviders.mockResolvedValue({ google: false, email: true, signupOpen: true, autoConfirm: true });
    const res = await oauth(post("/api/auth/oauth", { provider: "google" }));
    expect(res.status).toBe(503);
    expect((await json(res)).error?.code).toBe("GOOGLE_NOT_CONFIGURED");
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
  });

  it("refuses when the settings cannot be read", async () => {
    getAuthProviders.mockResolvedValue(null);
    expect((await oauth(post("/api/auth/oauth", { provider: "google" }))).status).toBe(503);
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
  });

  it("accepts only Google", async () => {
    expect((await oauth(post("/api/auth/oauth", { provider: "github" }))).status).toBe(400);
  });

  it("hands back Supabase's authorize URL, returning to the existing callback, and remembers the page", async () => {
    getAuthProviders.mockResolvedValue({ google: true, email: true, signupOpen: true, autoConfirm: true });
    const url = `${SUPABASE}/auth/v1/authorize?provider=google&redirect_to=x`;
    auth.signInWithOAuth.mockResolvedValue({ data: { url }, error: null });
    const res = await oauth(post("/api/auth/oauth", { provider: "google", next: "/new/empty-plot" }));
    expect(await json(res)).toEqual({ ok: true, url });
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "http://localhost:3000/auth/callback", skipBrowserRedirect: true },
    });
    expect(res.headers.get("set-cookie")).toMatch(/aad_next=%2Fnew%2Fempty-plot/);
  });

  it("never sends the browser anywhere but the Supabase project", async () => {
    getAuthProviders.mockResolvedValue({ google: true, email: true, signupOpen: true, autoConfirm: true });
    auth.signInWithOAuth.mockResolvedValue({ data: { url: "https://evil.example/authorize" }, error: null });
    expect((await oauth(post("/api/auth/oauth", { provider: "google" }))).status).toBe(503);
  });
});

describe("POST /api/auth/forgot-password", () => {
  it("answers the same whether or not the account exists, and flags the reset for the callback", async () => {
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: { code: "user_not_found", status: 400 } });
    const a = await forgot(post("/api/auth/forgot-password", { email: "exists@example.test" }));
    const b = await forgot(post("/api/auth/forgot-password", { email: "missing@example.test" }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await json(a)).toEqual(await json(b));
    expect(a.headers.get("set-cookie")).toMatch(/aad_recovery=1; Path=\/auth\/callback;.*Max-Age=3600;.*HttpOnly/i);
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("exists@example.test", { redirectTo: "http://localhost:3000/auth/callback" });
  });

  it("reports rate limiting and outages", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: { status: 429 } });
    expect((await forgot(post("/api/auth/forgot-password", { email: "a@example.test" }))).status).toBe(429);
    auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: { status: 500 } });
    expect((await forgot(post("/api/auth/forgot-password", { email: "a@example.test" }))).status).toBe(503);
  });

  it("rejects an invalid email", async () => {
    expect((await forgot(post("/api/auth/forgot-password", { email: "nope" }))).status).toBe(400);
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/update-password", () => {
  it("needs a session checked with the Auth server", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: new Error("no session") });
    const res = await updatePassword(post("/api/auth/update-password", { password: "a-new-password" }));
    expect(res.status).toBe(401);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("rejects a short password", async () => {
    expect((await updatePassword(post("/api/auth/update-password", { password: "short" }))).status).toBe(400);
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("explains reusing the current password", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    auth.updateUser.mockResolvedValue({ data: {}, error: { code: "same_password", status: 422 } });
    const res = await updatePassword(post("/api/auth/update-password", { password: "a-new-password" }));
    expect((await json(res)).error?.code).toBe("SAME_PASSWORD");
  });

  it("changes only the password of the signed-in account", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    auth.updateUser.mockResolvedValue({ data: {}, error: null });
    const res = await updatePassword(post("/api/auth/update-password", { password: "a-new-password", email: "other@example.test" }));
    expect(await json(res)).toEqual({ ok: true, redirect: "/projects" });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "a-new-password" });
  });
});

describe("POST /api/auth/sign-out", () => {
  it("ends the session", async () => {
    auth.signOut.mockResolvedValue({ error: null });
    const res = await signOut(new Request("http://localhost:3000/api/auth/sign-out", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("GET /auth/callback after a reset link", () => {
  it("goes to the new-password page and clears both cookies", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await callback(
      new Request("http://localhost:3000/auth/callback?code=abc", { headers: { cookie: "aad_recovery=1; aad_next=%2Fprojects" } }),
    );
    expect(res.headers.get("location")).toBe("http://localhost:3000/reset-password");
    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies).toMatch(/aad_recovery=;/);
    expect(cookies).toMatch(/aad_next=;/);
  });

  it("a failed Google sign-in returns to /sign-in with the general message", async () => {
    const res = await callback(new Request("http://localhost:3000/auth/callback?error=server_error&error_description=x"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/sign-in?error=1");
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});

describe("/reset-password page", () => {
  async function renderPage() {
    const page = ResetPasswordPage() as ReactElement<{ children: ReactElement[] }>;
    const suspense = (page.props.children as ReactElement[])[1] as ReactElement<{ children: ReactElement }>;
    const content = suspense.props.children as ReactElement<object, (p: object) => Promise<ReactElement>>;
    return renderToStaticMarkup(await content.type(content.props));
  }

  it("without a session: explains the link cannot be used and offers a new one", async () => {
    getAccountSummary.mockResolvedValue(null);
    const out = await renderPage();
    expect(out).toContain("This reset link cannot be used");
    expect(out).toContain('href="/sign-in?mode=forgot"');
    expect(out).not.toContain('type="password"');
  });

  it("with a session: the new-password form for that account", async () => {
    getAccountSummary.mockResolvedValue({ email: "customer@example.test", isAdmin: false });
    const out = await renderPage();
    expect(out).toContain("customer@example.test");
    expect(out).toMatch(/autocomplete="new-password"/i);
    expect(out).toContain("Save new password");
  });
});

describe("protected pages for a signed-out visitor", () => {
  it("show the sign-in gate, which returns to the page and mentions creating an account", () => {
    const out = renderToStaticMarkup(createElement(AccessGate, { access: { state: "signed_out" } }));
    expect(out).toContain("Sign in to continue");
    expect(out).toContain('href="/sign-in?next=%2Fprojects"');
    expect(out).toContain("create a free account");
  });
});

describe("authProblem and getAuthProviders", () => {
  it("maps unknown codes to a generic answer", () => {
    expect(credentials.authProblem({ code: "something_new", status: 400 })).toMatchObject({ status: 503, code: "AUTH_UNAVAILABLE" });
    expect(credentials.authProblem({ status: 429 })).toMatchObject({ status: 429 });
  });

  it("reads the Auth server's public settings", async () => {
    const fake = vi.fn(async () =>
      Response.json({ external: { google: true, email: true }, disable_signup: false, mailer_autoconfirm: false }),
    ) as unknown as typeof fetch;
    expect(await credentials.getAuthProviders(fake)).toEqual({ google: true, email: true, signupOpen: true, autoConfirm: false });
    expect(fake).toHaveBeenCalledWith(`${SUPABASE}/auth/v1/settings`, expect.objectContaining({ headers: { apikey: "k" } }));
  });

  it("treats unreadable settings as unknown (Google unavailable)", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await credentials.getAuthProviders(failing)).toBeNull();
    const notOk = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await credentials.getAuthProviders(notOk)).toBeNull();
  });
});
