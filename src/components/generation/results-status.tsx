import Link from "next/link";
import type { ProjectStatus } from "@/lib/db/schema";
import { milestoneStates, RELEASE_MILESTONES, type MilestoneState } from "@/lib/generation/milestones";
import { STATUS_INFO } from "@/lib/journeys/status";
import { buttonPrimary } from "@/components/journey/styles";

const WORD: Record<MilestoneState, string> = { done: "done", current: "in progress", problem: "needs attention", todo: "not started" };

/** A quiet elevation drawing for the status card: a pitched roof, a door and two windows. Decorative. */
function Elevation() {
  return (
    <svg aria-hidden="true" viewBox="0 0 240 150" className="h-auto w-full max-w-[15rem] text-sandstone" fill="none" stroke="currentColor" strokeWidth="1.25">
      <path d="M10 140h220" />
      <path d="M40 140V70l80-48 80 48v70" />
      <path d="M28 78 120 22l92 56" />
      <path d="M104 140V100h32v40" />
      <rect x="60" y="86" width="26" height="22" />
      <rect x="154" y="86" width="26" height="22" />
      <path d="M73 86v22M60 97h26M167 86v22M154 97h26" />
      <path d="M150 38V18h14v28" />
    </svg>
  );
}

/**
 * The results page while nothing is released: what the status is, what happens next, and where the
 * project stands between payment and release. It shows the status only; no file is read here.
 */
export function ResultsStatus({ projectId, status }: { projectId: string; status: ProjectStatus }) {
  const info = STATUS_INFO[status];
  const states = milestoneStates(status);
  const beforeQuote = states.every((s) => s === "todo") && status !== "CANCELLED";
  const action = info.actionPath && info.actionPath !== "/results" && info.actionLabel ? { href: `/projects/${projectId}${info.actionPath}`, label: info.actionLabel } : null;

  return (
    <section aria-labelledby="results-status-title" className="grid overflow-hidden rounded-[4px] border border-border bg-paper shadow-soft lg:grid-cols-12">
      <div className="space-y-6 p-7 sm:p-10 lg:col-span-6">
        <p className="eyebrow">Where your concepts are</p>
        <h2 id="results-status-title" className="font-display text-4xl font-medium leading-tight sm:text-5xl">
          {info.label}
        </h2>
        <p className="max-w-md leading-relaxed text-muted">{info.next}</p>
        <p className="max-w-md text-sm leading-relaxed text-muted">
          {beforeQuote
            ? "Concepts are drawn only after you accept a quote and a person verifies your payment."
            : "Your concept images appear on this page only after they have been reviewed and released to you."}
        </p>
        {action ? (
          <Link href={action.href} className={buttonPrimary}>
            {action.label} <span aria-hidden="true" className="gn-arrow">→</span>
          </Link>
        ) : null}
        <div className="hidden pt-6 lg:block">
          <Elevation />
        </div>
      </div>

      <ol aria-label="From payment to release" className="border-t border-border bg-surface p-7 sm:p-10 lg:col-span-6 lg:border-l lg:border-t-0">
        {RELEASE_MILESTONES.map((m, i) => {
          const state = states[i];
          const last = i === RELEASE_MILESTONES.length - 1;
          return (
            <li key={m.id} aria-current={state === "current" || state === "problem" ? "step" : undefined} className="relative flex gap-5 pb-8 last:pb-0">
              {!last ? <span aria-hidden="true" className={`absolute left-[0.9375rem] top-9 bottom-1 w-px ${state === "done" ? "bg-accent" : "bg-border-strong"}`} /> : null}
              <span
                aria-hidden="true"
                className={`relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular ${
                  state === "done"
                    ? "border-accent bg-accent text-accent-contrast"
                    : state === "current"
                      ? "border-accent bg-paper text-accent ring-4 ring-accent/10"
                      : state === "problem"
                        ? "border-danger-fg bg-danger-bg text-danger-fg"
                        : "border-border-strong bg-paper text-muted"
                }`}
              >
                {state === "done" ? "✓" : state === "problem" ? "!" : i + 1}
              </span>
              <span className="pt-1">
                <span className={`block font-semibold ${state === "todo" ? "text-muted" : ""}`}>
                  {m.label}
                  <span className="sr-only"> ({WORD[state]})</span>
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-muted">{m.detail}</span>
                {state === "current" || state === "problem" ? (
                  <span className={`mt-2 inline-block rounded-[3px] px-2 py-0.5 text-xs font-semibold ${state === "problem" ? "bg-danger-bg text-danger-fg" : "bg-success-bg text-success-fg"}`}>
                    {state === "problem" ? "Needs attention" : "Now"}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
