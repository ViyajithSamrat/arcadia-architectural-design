"use client";

import { useId, useState, useTransition } from "react";
import { reviewBriefAction, type ActionState } from "@/app/(app)/projects/actions";
import { BRIEF_MAX_TEXT } from "@/lib/journeys/brief";
import { Notice } from "./notice";
import { buttonPrimary, buttonSecondary, input } from "./styles";

/** The editable English brief, with Save and Approve. The server decides whether approval is allowed. */
export function BriefReviewForm({
  projectId,
  initialText,
  canApprove,
  blockedReason,
}: {
  projectId: string;
  initialText: string;
  /** False while required answers are missing; the server checks again regardless. */
  canApprove: boolean;
  blockedReason?: string;
}) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<ActionState>(undefined);
  const [pending, start] = useTransition();

  const run = (intent: "save" | "approve") => {
    setState(undefined);
    start(async () => setState(await reviewBriefAction(projectId, intent, text, confirmed)));
  };
  const errors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <div className="space-y-4">
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

      <div>
        <label htmlFor={`${id}-text`} className="block text-sm font-medium">
          English brief (you can edit this)
        </label>
        <textarea
          id={`${id}-text`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          maxLength={BRIEF_MAX_TEXT}
          aria-invalid={errors?.briefText ? true : undefined}
          aria-describedby={errors?.briefText ? `${id}-text-error` : undefined}
          className={`${input} mt-1`}
        />
        {errors?.briefText ? (
          <p id={`${id}-text-error`} className="mt-1 text-sm font-medium text-danger-fg">
            <span aria-hidden="true">✕ </span>
            {errors.briefText}
          </p>
        ) : null}
      </div>

      <div>
        <label className="flex min-h-11 items-start gap-3 text-base">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={!canApprove}
            aria-describedby={errors?.confirm ? `${id}-confirm-error` : undefined}
            className="mt-2 size-5 accent-[var(--accent)]"
          />
          <span className="pt-1.5">I have read this brief and it describes what I want.</span>
        </label>
        {errors?.confirm ? (
          <p id={`${id}-confirm-error`} className="mt-1 text-sm font-medium text-danger-fg">
            <span aria-hidden="true">✕ </span>
            {errors.confirm}
          </p>
        ) : null}
      </div>

      {!canApprove ? (
        <Notice tone="warning" title="Approval is not available yet">
          <p>{blockedReason ?? "Some required answers are still missing."}</p>
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button type="button" className={buttonSecondary} disabled={pending} onClick={() => run("save")}>
          {pending ? "Working…" : "Save edits"}
        </button>
        <button
          type="button"
          className={buttonPrimary}
          disabled={pending || !canApprove || !confirmed}
          aria-busy={pending}
          onClick={() => run("approve")}
        >
          {pending ? "Working…" : "Approve brief and continue to quote"}
        </button>
      </div>
    </div>
  );
}
