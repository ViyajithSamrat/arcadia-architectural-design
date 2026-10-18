import type { ProjectStatus } from "@/lib/db/schema";
import { PROGRESS_STAGES, stageState } from "@/lib/journeys/status";

/** Where the project is. Each stage says "done" or "current" in words, not only by style. */
export function Progress({ status }: { status: ProjectStatus }) {
  return (
    <ol aria-label="Project progress" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {PROGRESS_STAGES.map((stage, i) => {
        const state = stageState(status, stage, i);
        return (
          <li
            key={stage.id}
            aria-current={state === "current" ? "step" : undefined}
            className={`rounded-lg border px-3 py-2 text-sm ${
              state === "current" ? "border-accent bg-surface font-semibold" : state === "done" ? "border-border bg-success-bg text-success-fg" : "border-border text-muted"
            }`}
          >
            <span aria-hidden="true">{state === "done" ? "✓ " : state === "current" ? "● " : "○ "}</span>
            {stage.label}
            <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (current)" : " (not started)"}</span>
          </li>
        );
      })}
    </ol>
  );
}
