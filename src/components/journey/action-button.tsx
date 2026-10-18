"use client";

import { useState, useTransition } from "react";
import type { ActionState } from "@/app/(app)/projects/actions";
import { Notice } from "./notice";
import { buttonPrimary, buttonSecondary } from "./styles";

/**
 * A button that runs a Server Action and shows what came back. The action redirects on
 * success, so only a failure ever needs displaying here.
 */
export function ActionButton({
  action,
  children,
  pendingLabel,
  disabled = false,
  variant = "primary",
}: {
  action: () => Promise<ActionState>;
  children: string;
  pendingLabel: string;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState>(undefined);

  return (
    <div className="space-y-3">
      <button
        type="button"
        className={variant === "primary" ? buttonPrimary : buttonSecondary}
        disabled={disabled || pending}
        aria-busy={pending}
        onClick={() => {
          setState(undefined);
          start(async () => setState(await action()));
        }}
      >
        {pending ? pendingLabel : children}
      </button>
      {state && !state.ok ? (
        <Notice tone="danger" role="alert" title={state.message}>
          {state.missing?.length ? (
            <ul className="list-disc pl-5">
              {state.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
    </div>
  );
}
