"use client";

import { useState, useTransition } from "react";
import { clearStaleJobAction, releaseProjectAction, startGenerationAction, type GenerationActionState } from "@/app/(app)/admin/generation/actions";
import { Notice } from "@/components/journey/notice";
import { button, buttonPrimary } from "@/components/journey/styles";
import { RELEASE_EXPLANATION } from "@/lib/generation/copy";

/**
 * Administrator controls. They only ask the server to act: the server decides whether the
 * request is allowed and the page afterwards shows what really happened. Nothing here marks
 * success itself, and each button is disabled while its request is in flight.
 */

function Failure({ state }: { state: GenerationActionState }) {
  return state && !state.ok ? (
    <Notice tone="danger" role="alert" title={state.message}>
      <p>Nothing was changed by this request.</p>
    </Notice>
  ) : null;
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`.padEnd(16, "0"));

export type StartMode = "start" | "retry" | "resume" | "finish";

const START_TEXT: Record<StartMode, { button: string; busy: string; hint: string }> = {
  start: { button: "Start mock generation", busy: "Generating…", hint: "Creates placeholder images with the test generator. No AI model is used and nothing is spent." },
  retry: { button: "Try generation again", busy: "Generating…", hint: "The last attempt failed and left nothing behind. This starts a new attempt with the test generator." },
  resume: { button: "Start generation again", busy: "Generating…", hint: "Generation was claimed but never began. This starts it again." },
  finish: { button: "Finish and move to review", busy: "Finishing…", hint: "The images were created but the project was not advanced. This completes that step without generating again." },
};

/**
 * One idempotency key per attempt: a double click repeats the same key, which the server
 * treats as the same request. After a failure a fresh key is made, because a failed key
 * is never reused.
 */
export function StartGenerationForm({ projectId, mode }: { projectId: string; mode: StartMode }) {
  const [pending, run] = useTransition();
  const [state, setState] = useState<GenerationActionState>(undefined);
  const [key, setKey] = useState(newKey);
  const text = START_TEXT[mode];
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setState(undefined);
        run(async () => {
          const result = await startGenerationAction(projectId, key);
          setState(result);
          if (result && !result.ok) setKey(newKey());
        });
      }}
    >
      <p className="text-sm text-muted">{text.hint}</p>
      <Failure state={state} />
      <button type="submit" className={buttonPrimary} disabled={pending} aria-busy={pending}>
        {pending ? text.busy : text.button}
      </button>
    </form>
  );
}

/** Release needs two explicit confirmations when the images are mock placeholders. */
export function ReleaseForm({ projectId, assetCount, mock }: { projectId: string; assetCount: number; mock: boolean }) {
  const [pending, run] = useTransition();
  const [state, setState] = useState<GenerationActionState>(undefined);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setState(undefined);
        run(async () => setState(await releaseProjectAction(projectId, f.get("reviewed") === "on", f.get("mock") === "on")));
      }}
    >
      <h3 className="text-lg font-semibold">Release to the customer</h3>
      <p>{RELEASE_EXPLANATION}</p>
      <label className="flex items-start gap-3">
        <input type="checkbox" name="reviewed" required className="mt-1 size-5 accent-[var(--accent)]" />
        <span>
          I reviewed all {assetCount} {assetCount === 1 ? "image" : "images"} above and I want the customer to be able to see {assetCount === 1 ? "it" : "them"}.
        </span>
      </label>
      {mock ? (
        <label className="flex items-start gap-3">
          <input type="checkbox" name="mock" required className="mt-1 size-5 accent-[var(--accent)]" />
          <span>I understand these are MOCK placeholders, not designs, and the customer will see them as they are.</span>
        </label>
      ) : null}
      <Failure state={state} />
      <button type="submit" className={buttonPrimary} disabled={pending} aria-busy={pending}>
        {pending ? "Releasing…" : `Release ${assetCount} ${assetCount === 1 ? "image" : "images"} to the customer`}
      </button>
    </form>
  );
}

/** Clearing an abandoned job. The server refuses unless the job has made no progress for ten minutes. */
export function ClearStaleJobForm({ projectId }: { projectId: string }) {
  const [pending, run] = useTransition();
  const [state, setState] = useState<GenerationActionState>(undefined);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setState(undefined);
        run(async () => setState(await clearStaleJobAction(projectId, f.get("confirmed") === "on")));
      }}
    >
      <label className="flex items-start gap-3">
        <input type="checkbox" name="confirmed" required className="mt-1 size-5 accent-[var(--accent)]" />
        <span>I understand the interrupted job will be marked failed and its unfinished files removed. Nothing is released.</span>
      </label>
      <Failure state={state} />
      <button type="submit" className={`${button} border border-danger-fg text-danger-fg hover:bg-danger-bg`} disabled={pending} aria-busy={pending}>
        {pending ? "Clearing…" : "Clear the interrupted job"}
      </button>
    </form>
  );
}
