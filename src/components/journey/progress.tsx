import type { ProjectStatus } from "@/lib/db/schema";
import { PROGRESS_STAGES, stageState } from "@/lib/journeys/status";

/** Where the project is. Each stage says "done" or "current" in words, not only by style. */
export function Progress({ status }: { status: ProjectStatus }) {
  return (
    <ol aria-label="Project progress" className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4">
      {PROGRESS_STAGES.map((stage, i) => {
        const state = stageState(status, stage, i);
        return (
          <li key={stage.id} aria-current={state === "current" ? "step" : undefined} className="space-y-2 text-sm">
            <span
              aria-hidden="true"
              className={`block h-[3px] rounded-full ${state === "done" ? "bg-accent" : state === "current" ? "bg-sandstone" : "bg-border"}`}
            />
            <span className={`flex items-center gap-2 ${state === "todo" ? "text-muted" : "font-semibold"}`}>
              <span
                aria-hidden="true"
                className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular ${
                  state === "done"
                    ? "border-accent bg-accent text-accent-contrast"
                    : state === "current"
                      ? "border-accent text-accent"
                      : "border-border text-muted"
                }`}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              {stage.label}
            </span>
            <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (current)" : " (not started)"}</span>
          </li>
        );
      })}
    </ol>
  );
}
