"use client";

import { useState, type FormEvent } from "react";

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; message: string }
  | { kind: "error"; message: string };

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) setState({ kind: "sent", message: json?.message ?? "Check your email for the sign-in link." });
      else setState({ kind: "error", message: json?.error?.message ?? "Something went wrong." });
    } catch {
      setState({ kind: "error", message: "Could not reach the server. Try again." });
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <label htmlFor="email" className="block text-sm font-medium">
        Email address
      </label>
      <input
        id="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full rounded border px-3 py-2"
      />
      <button
        type="submit"
        disabled={state.kind === "sending" || email.trim() === ""}
        className="rounded bg-accent px-4 py-2 text-accent-contrast disabled:opacity-50"
      >
        {state.kind === "sending" ? "Sending..." : "Email me a sign-in link"}
      </button>
      <p aria-live="polite" role={state.kind === "error" ? "alert" : undefined}>
        {state.kind === "sent" || state.kind === "error" ? state.message : null}
      </p>
    </form>
  );
}
