"use client";

import { startProjectAction } from "@/app/(app)/projects/actions";
import type { JourneySlug } from "@/lib/journeys/project-types";
import { ActionButton } from "./action-button";

export function StartProjectButton({ slug }: { slug: JourneySlug }) {
  return (
    <ActionButton action={() => startProjectAction(slug)} pendingLabel="Starting…">
      Start this project
    </ActionButton>
  );
}
