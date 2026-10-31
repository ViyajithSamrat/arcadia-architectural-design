"use client";

import { useId, useState, type FormEvent } from "react";
import { Notice } from "@/components/journey/notice";
import { buttonPrimary, buttonSecondary, input } from "@/components/journey/styles";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password-rules";

export type AuthMode = "sign-in" | "sign-up" | "forgot";

type State =
  | { kind: "idle" }
  | { kind: "working"; what: "email" | "google" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TITLES: Record<AuthMode, { submit: string; working: string }> = {
  "sign-in": { submit: "Sign in", working: "Signing in…" },
  "sign-up": { submit: "Create account", working: "Creating your account…" },
  forgot: { submit: "Email me a reset link", working: "Sending…" },
};

async function post(url: string, body: object): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, json: await res.json().catch(() => null) };
}

function errorMessage(json: Record<string, unknown> | null): string {
  const error = json?.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : "Something went wrong. Try again.";
}

/**
 * Sign in, create an account, or reset a password, plus Continue with Google. Every request goes
 * to the same-origin /api/auth routes, which talk to Supabase Auth on the server and set the
 * session cookies; this component never handles a token.
 *
 * @param next an allow-listed return path, already checked by the page; the server checks it again.
 * @param googleEnabled whether the Auth server reports Google as switched on.
 */
export function SignInForm({
  next = null,
  googleEnabled,
  initialMode = "sign-in",
}: {
  next?: string | null;
  googleEnabled: boolean;
  initialMode?: AuthMode;
}) {
  const id = useId();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const busy = state.kind === "working";

  function switchTo(m: AuthMode) {
    setMode(m);
    setState({ kind: "idle" });
  }

  function validate(): string | null {
    if (!EMAIL_PATTERN.test(email.trim())) return "Enter a valid email address.";
    if (mode === "forgot") return null;
    if (password === "") return "Enter your password.";
    if (mode === "sign-up" && password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters for your password.`;
    return null;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validate();
    if (problem) {
      setState({ kind: "error", message: problem });
      return;
    }
    setState({ kind: "working", what: "email" });
    try {
      const withNext = next ? { next } : {};
      const address = email.trim();
      const { ok, json } =
        mode === "forgot"
          ? await post("/api/auth/forgot-password", { email: address })
          : await post(mode === "sign-up" ? "/api/auth/sign-up" : "/api/auth/sign-in", { email: address, password, ...withNext });
      if (!ok) {
        setState({ kind: "error", message: errorMessage(json) });
        return;
      }
      if (typeof json?.redirect === "string" && json.redirect.startsWith("/")) {
        // A full navigation, so every server-rendered part of the page sees the new session.
        window.location.assign(json.redirect);
        return;
      }
      setPassword("");
      setState({ kind: "done", message: typeof json?.message === "string" ? json.message : "Check your email." });
    } catch {
      setState({ kind: "error", message: "Could not reach the server. Check your connection and try again." });
    }
  }

  async function onGoogle() {
    setState({ kind: "working", what: "google" });
    try {
      const { ok, json } = await post("/api/auth/oauth", next ? { provider: "google", next } : { provider: "google" });
      if (ok && typeof json?.url === "string") {
        window.location.assign(json.url);
        return;
      }
      setState({ kind: "error", message: errorMessage(json) });
    } catch {
      setState({ kind: "error", message: "Could not reach the server. Check your connection and try again." });
    }
  }

  const title = TITLES[mode];

  return (
    <div className="space-y-5">
      {mode !== "forgot" ? (
        <>
          <div role="group" aria-label="Choose" className="grid grid-cols-2 border-b border-border">
            {(["sign-in", "sign-up"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => switchTo(m)}
                disabled={busy}
                className={`-mb-px min-h-11 border-b-2 px-3 text-sm font-semibold transition-colors duration-300 ${
                  mode === m ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {m === "sign-in" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <button type="button" onClick={onGoogle} disabled={busy || !googleEnabled} className={`${buttonSecondary} w-full gap-3`}>
            <GoogleMark />
            {state.kind === "working" && state.what === "google" ? "Opening Google…" : "Continue with Google"}
          </button>
          {!googleEnabled ? (
            <p className="text-sm text-muted">Google sign-in is not set up on this server yet. Use your email and password instead.</p>
          ) : null}

          <div className="flex items-center gap-3 text-sm text-muted" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            or with email
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      ) : (
        <p className="text-muted">Enter the email address of your account and we will send you a link to choose a new password.</p>
      )}

      {/* method="post": if it is submitted before the page has loaded its script, the browser
          must not put the email and password in the URL (a GET would, and servers log URLs). */}
      <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-email`} className="block text-sm font-medium">
            Email address
          </label>
          <input
            id={`${id}-email`}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={input}
          />
        </div>

        {mode !== "forgot" ? (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`${id}-password`} className="block text-sm font-medium">
                Password
              </label>
              {mode === "sign-in" ? (
                <button type="button" onClick={() => switchTo("forgot")} className="text-sm underline underline-offset-4">
                  Forgot password?
                </button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <input
                id={`${id}-password`}
                type={showPassword ? "text" : "password"}
                name="password"
                autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                required
                minLength={mode === "sign-up" ? PASSWORD_MIN_LENGTH : undefined}
                aria-describedby={mode === "sign-up" ? `${id}-password-hint` : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={input}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
                aria-controls={`${id}-password`}
                className={`${buttonSecondary} shrink-0 px-3 text-sm`}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {mode === "sign-up" ? (
              <p id={`${id}-password-hint`} className="text-sm text-muted">
                At least {PASSWORD_MIN_LENGTH} characters.
              </p>
            ) : null}
          </div>
        ) : null}

        <button type="submit" disabled={busy} aria-busy={state.kind === "working" && state.what === "email"} className={`${buttonPrimary} w-full`}>
          {state.kind === "working" && state.what === "email" ? title.working : title.submit}
        </button>
      </form>

      <div aria-live="polite">
        {state.kind === "error" ? (
          <Notice tone="danger" role="alert">
            <p>{state.message}</p>
          </Notice>
        ) : state.kind === "done" ? (
          <Notice tone="success" role="status">
            <p>{state.message}</p>
          </Notice>
        ) : null}
      </div>

      {mode === "forgot" ? (
        <p className="text-sm">
          <button type="button" onClick={() => switchTo("sign-in")} className="underline underline-offset-4">
            Back to sign in
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** Google's "G" mark, as its sign-in branding asks for on a Continue with Google button. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z" />
      <path fill="#FBBC05" d="M10.6 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.8-4.5l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.2z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}
