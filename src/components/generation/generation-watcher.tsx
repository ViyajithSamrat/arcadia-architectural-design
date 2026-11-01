"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ProjectStatus } from "@/lib/db/schema";
import { watchIntervalMs } from "@/lib/generation/watch";

/**
 * Keeps an open project page current without a manual refresh: while the status is one that
 * changes by itself (payment under review, concepts being drawn), it asks the owner-only status
 * endpoint now and then, and re-renders the page from the server when the status has changed.
 * It renders nothing and decides nothing: what the page shows still comes from the server.
 * Checks pause while the tab is hidden and stop once there is nothing left to wait for.
 */
export function GenerationWatcher({ projectId, status }: { projectId: string; status: ProjectStatus }) {
  const router = useRouter();

  useEffect(() => {
    const interval = watchIntervalMs(status);
    if (interval === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/api/projects/${projectId}/status`, { cache: "no-store", signal: controller.signal });
          if (response.ok) {
            const body = (await response.json()) as { status?: unknown };
            // The refreshed page passes the new status, which restarts this effect. If it somehow
            // does not, the next tick below refreshes again rather than going quiet.
            if (typeof body.status === "string" && body.status !== status) router.refresh();
          }
        } catch {
          // Offline or interrupted: try again at the next interval.
        }
      }
      if (!stopped) timer = setTimeout(tick, interval);
    };

    timer = setTimeout(tick, interval);
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, status, router]);

  return null;
}
