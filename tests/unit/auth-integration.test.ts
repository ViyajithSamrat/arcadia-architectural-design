import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Header, notice and sign-in page tests render client components outside the app router.
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}));

// The page awaits connection(), which needs a real request scope.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<object>()), connection: async () => undefined }));

const exchangeCodeForSession = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { exchangeCodeForSession } }),
}));

const getAccountSummary = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getAccountSummary: () => getAccountSummary() }));

const getAuthProviders = vi.fn();
vi.mock("@/lib/auth/credentials", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAuthProviders: () => getAuthProviders(),
}));

const { config: proxyConfig, proxy } = await import("@/proxy");
const { GET: callback } = await import("@/app/auth/callback/route");
const { AccountNav } = await import("@/components/layout/auth-nav");
const { JustSignedInNotice } = await import("@/components/layout/auth-controls");
const { default: SignInPage } = await import("@/app/(app)/sign-in/page");
const { signInErrorMessage, signInErrorReason } = await import("@/lib/auth/sign-in-errors");
const { withSignedInMarker } = await import("@/lib/auth/next-path");

const KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const configure = () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "k";
};

beforeEach(() => {
  exchangeCodeForSession.mockReset();
  getAccountSummary.mockReset();
  getAuthProviders.mockReset();
  searchParams = new URLSearchParams();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("proxy matcher (session refresh)", () => {
  it.each([
    "/",
    "/projects",
    "/projects/33333333-3333-4333-8333-333333333333/payment",
    "/new/interior",
    "/admin/payments",
    "/sign-in",
    "/auth/callback",
    "/api/auth/sign-in",
    "/api/payments",
    "/status",
  ])("runs on %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url })).toBe(true);
  });

  it.each(["/_next/static/chunks/app.js", "/_next/image?url=%2Fa.jpg&w=640&q=75", "/favicon.ico", "/photos/kerala-house.webp", "/x.svg"])(
    "skips the static file %s",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url })).toBe(false);
    },
  );

  it("passes requests through untouched when Supabase is not configured", async () => {
    for (const k of KEYS) delete process.env[k];
    const res = await proxy(new NextRequest("http://localhost:3000/projects"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /auth/callback", () => {
  const get = (query: string, cookie?: string) =>
    callback(new Request(`http://localhost:3000/auth/callback${query}`, { headers: cookie ? { cookie } : {} }));

  it("sends a link without a code to the general error", async () => {
    configure();
    const res = await get("");
    expect(res.headers.get("location")).toBe("http://localhost:3000/sign-in?error=1");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("reports an expired link that Supabase sent back with error_code", async () => {
    configure();
    const res = await get("?error=access_denied&error_code=otp_expired");
    expect(res.headers.get("location")).toBe("http://localhost:3000/sign-in?error=expired");
  });

  it("reports a link opened in another browser (no code verifier)", async () => {
    configure();
    exchangeCodeForSession.mockResolvedValue({ error: { code: "pkce_code_verifier_not_found" } });
    const res = await get("?code=abc");
    expect(res.headers.get("location")).toBe("http://localhost:3000/sign-in?error=browser");
  });

  it("uses the general message for an undocumented error", async () => {
    configure();
    exchangeCodeForSession.mockResolvedValue({ error: { code: "something_else" } });
    const res = await get("?code=abc");
    expect(res.headers.get("location")).toBe("http://localhost:3000/sign-in?error=1");
  });

  it("lands on My projects with the sign-in marker after success", async () => {
    configure();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await get("?code=abc");
    expect(res.headers.get("location")).toBe("http://localhost:3000/projects?signed_in=1");
  });

  it("returns to a remembered allow-listed page, keeping its query, and clears the cookie", async () => {
    configure();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await get("?code=abc", `aad_next=${encodeURIComponent("/projects/abc/edit?step=description")}`);
    expect(res.headers.get("location")).toBe("http://localhost:3000/projects/abc/edit?step=description&signed_in=1");
    expect(res.headers.get("set-cookie")).toMatch(/aad_next=;/);
  });

  it.each(["//evil.example/projects", "https://evil.example", "/sign-in"])("ignores the unsafe remembered path %s", async (path) => {
    configure();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await get("?code=abc", `aad_next=${encodeURIComponent(path)}`);
    expect(res.headers.get("location")).toBe("http://localhost:3000/projects?signed_in=1");
  });
});

describe("sign-in error messages", () => {
  it("maps only documented Supabase codes", () => {
    expect(signInErrorReason("otp_expired")).toBe("expired");
    expect(signInErrorReason("flow_state_not_found")).toBe("expired");
    expect(signInErrorReason("bad_code_verifier")).toBe("browser");
    expect(signInErrorReason("anything")).toBe("1");
    expect(signInErrorReason(null)).toBe("1");
  });

  it("shows a general message for unknown values", () => {
    expect(signInErrorMessage("expired")).toMatch(/expired or was already used/);
    expect(signInErrorMessage("browser")).toMatch(/different browser or window/);
    expect(signInErrorMessage("<script>")).toMatch(/did not complete/);
  });

  it("adds the marker to a path with or without a query", () => {
    expect(withSignedInMarker("/projects")).toBe("/projects?signed_in=1");
    expect(withSignedInMarker("/projects/a/edit?step=x")).toBe("/projects/a/edit?step=x&signed_in=1");
  });
});

describe("header account states", () => {
  const render = (account: Parameters<typeof AccountNav>[0]["account"]) =>
    renderToStaticMarkup(createElement(AccountNav, { account, className: "act", accountClassName: "acct", tagClassName: "tag" }));

  it("signed out: a Sign in link back to the current page, no account or admin", () => {
    const out = render(null);
    expect(out).toContain('href="/sign-in?next=%2Fprojects"');
    expect(out).toContain("Sign in");
    expect(out).not.toContain("Sign out");
    expect(out).not.toContain("Admin");
  });

  it("signed in customer: the full email and Sign out, no Admin tag", () => {
    const out = render({ email: "customer@example.test", isAdmin: false });
    expect(out).toContain("customer@example.test");
    expect(out).toContain("Signed in as");
    expect(out).toContain("Sign out");
    expect(out).not.toContain("Admin");
    expect(out).not.toContain('href="/sign-in');
  });

  it("administrator: the Admin tag only when the database check said so", () => {
    const out = render({ email: "admin@example.test", isAdmin: true });
    expect(out).toContain("admin@example.test");
    expect(out).toContain('<span class="tag">Admin</span>');
  });
});

describe("sign-in success notice", () => {
  it("shows the email when the marker is present", () => {
    searchParams = new URLSearchParams("signed_in=1");
    const out = renderToStaticMarkup(createElement(JustSignedInNotice, { email: "customer@example.test" }));
    expect(out).toContain("You are signed in");
    expect(out).toContain("Signed in as customer@example.test.");
    expect(out).toContain('role="status"');
  });

  it("shows nothing without the marker", () => {
    expect(renderToStaticMarkup(createElement(JustSignedInNotice, { email: "a@b.test" }))).toBe("");
  });
});

describe("sign-in page", () => {
  /** Renders the page's async content the way the Suspense boundary would. */
  async function renderPage(query: { error?: string; next?: string; mode?: string }) {
    const page = SignInPage({ searchParams: Promise.resolve(query) }) as ReactElement<{ children: ReactElement }>;
    const content = page.props.children as ReactElement<object, (p: object) => Promise<ReactElement>>;
    return renderToStaticMarkup(await content.type(content.props));
  }

  it("for a signed-in visitor: the email, My projects and Sign out instead of the form", async () => {
    configure();
    getAccountSummary.mockResolvedValue({ email: "customer@example.test", isAdmin: false });
    const out = await renderPage({});
    expect(out).toContain("You are signed in");
    expect(out).toContain("customer@example.test");
    expect(out).toContain('href="/projects"');
    expect(out).toContain("Sign out");
    expect(out).not.toContain('type="email"');
  });

  it("offers the remembered page only when it is allow-listed", async () => {
    configure();
    getAccountSummary.mockResolvedValue({ email: "customer@example.test", isAdmin: false });
    expect(await renderPage({ next: "/projects/abc/payment" })).toContain('href="/projects/abc/payment"');
    expect(await renderPage({ next: "https://evil.example" })).not.toContain("evil.example");
  });

  it("for a signed-out visitor: Google, email and password, create account, forgot password and the specific error", async () => {
    configure();
    getAccountSummary.mockResolvedValue(null);
    getAuthProviders.mockResolvedValue({ google: true, email: true, signupOpen: true, autoConfirm: true });
    const out = await renderPage({ error: "browser" });
    expect(out).toContain('type="email"');
    expect(out).toContain('type="password"');
    expect(out).toMatch(/autocomplete="current-password"/i);
    expect(out).toContain("Continue with Google");
    expect(out).not.toContain("Google sign-in is not set up");
    expect(out).toContain("Create account");
    expect(out).toContain("Forgot password?");
    expect(out).toContain("different browser or window");
    expect(out).toContain("Browsing the site does not need an account");
    expect(out).not.toContain("Sign out");
  });

  it("disables Google with an explanation when the Auth server has it off", async () => {
    configure();
    getAccountSummary.mockResolvedValue(null);
    getAuthProviders.mockResolvedValue({ google: false, email: true, signupOpen: true, autoConfirm: true });
    const out = await renderPage({});
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*Continue with Google/);
    expect(out).toContain("Google sign-in is not set up on this server yet");
  });

  it("opens on Create account or Forgot password when asked", async () => {
    configure();
    getAccountSummary.mockResolvedValue(null);
    getAuthProviders.mockResolvedValue(null);
    const signUp = await renderPage({ mode: "sign-up" });
    expect(signUp).toMatch(/autocomplete="new-password"/i);
    expect(signUp).toContain("At least 8 characters");
    const forgot = await renderPage({ mode: "forgot" });
    expect(forgot).toContain("Email me a reset link");
    expect(forgot).not.toContain('type="password"');
    expect(await renderPage({ mode: "<script>" })).toMatch(/autocomplete="current-password"/i);
  });

  it("when Supabase is not configured: no form and no session lookup", async () => {
    for (const k of KEYS) delete process.env[k];
    const out = await renderPage({});
    expect(out).toContain("has not been configured");
    expect(getAccountSummary).not.toHaveBeenCalled();
  });
});
