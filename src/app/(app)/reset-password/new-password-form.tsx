"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Notice } from "@/components/journey/notice";
import { buttonPrimary, buttonSecondary, input } from "@/components/journey/styles";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password-rules";


type State = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

/** Sets a new password for the account signed in by the reset link. */
export function NewPasswordForm() {
  const id = useId();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password.length < PASSWORD_MIN_LENGTH) {
      setState({ kind: "error", message: `Use at least ${PASSWORD_MIN_LENGTH} characters for your password.` });
      return;
    }
    if (password !== confirm) {
      setState({ kind: "error", message: "The two passwords do not match." });
      return;
    }
    setState({ kind: "saving" });
    try {
      const res = await fetch("/api/auth/update-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        // Already signed in by the reset link, so an ordinary navigation is enough.
        router.replace("/projects");
        router.refresh();
        return;
      }
      setState({ kind: "error", message: json?.error?.message ?? "Could not save the password. Try again." });
    } catch {
      setState({ kind: "error", message: "Could not reach the server. Check your connection and try again." });
    }
  }

  return (
    // method="post" keeps an early (pre-script) submit from putting the password in the URL.
    <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
      {(["new", "confirm"] as const).map((field) => (
        <div key={field} className="space-y-1.5">
          <label htmlFor={`${id}-${field}`} className="block text-sm font-medium">
            {field === "new" ? "New password" : "Repeat the new password"}
          </label>
          <input
            id={`${id}-${field}`}
            type={show ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={field === "new" ? password : confirm}
            onChange={(e) => (field === "new" ? setPassword : setConfirm)(e.target.value)}
            className={input}
          />
        </div>
      ))}
      <p className="text-sm text-muted">At least {PASSWORD_MIN_LENGTH} characters.</p>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={state.kind === "saving"} aria-busy={state.kind === "saving"} className={buttonPrimary}>
          {state.kind === "saving" ? "Saving…" : "Save new password"}
        </button>
        <button type="button" onClick={() => setShow((v) => !v)} aria-pressed={show} className={buttonSecondary}>
          {show ? "Hide passwords" : "Show passwords"}
        </button>
      </div>
      <div aria-live="polite">
        {state.kind === "error" ? (
          <Notice tone="danger" role="alert">
            <p>{state.message}</p>
          </Notice>
        ) : null}
      </div>
    </form>
  );
}
