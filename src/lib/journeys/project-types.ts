import type { ProjectType } from "@/lib/db/schema";

/**
 * The three customer journeys. The URL slug is what appears in /new/<slug>; the
 * database vocabulary (ProjectType) is what is stored.
 */
export const JOURNEY_SLUGS = ["empty-plot", "interior", "landscape"] as const;
export type JourneySlug = (typeof JOURNEY_SLUGS)[number];

const SLUG_TO_TYPE: Readonly<Record<JourneySlug, ProjectType>> = {
  "empty-plot": "EMPTY_PLOT",
  interior: "INTERIOR",
  landscape: "LANDSCAPE",
};

export type JourneyInfo = {
  type: ProjectType;
  slug: JourneySlug;
  /** Name used in navigation and headings. */
  title: string;
  /** One-sentence description for the project card and journey intro. */
  summary: string;
  /** Disclaimer shown beside the relevant steps (04_UI_UX.md section 4.7). */
  disclaimer: string;
};

export const JOURNEYS: Readonly<Record<ProjectType, JourneyInfo>> = {
  EMPTY_PLOT: {
    type: "EMPTY_PLOT",
    slug: "empty-plot",
    title: "New build on an empty plot",
    summary: "Describe your plot and the rooms you need. Concepts include an illustrative 2D layout.",
    disclaimer: "Illustrative layout only. Not CAD or a construction drawing. Dimensions may be approximate.",
  },
  INTERIOR: {
    type: "INTERIOR",
    slug: "interior",
    title: "Interior refresh",
    summary: "Tell us about the rooms, your style and what must stay. Concepts are interior images.",
    disclaimer:
      "Visual inspiration only. Existing dimensions, structure, electrical and plumbing conditions, and product sizes have not been verified.",
  },
  LANDSCAPE: {
    type: "LANDSCAPE",
    slug: "landscape",
    title: "Landscaping",
    summary: "Describe your outdoor space and its conditions. Concepts are landscape images.",
    disclaimer:
      "Plant selection, local suitability, drainage, irrigation, pet and child safety, and maintenance need local or professional review.",
  },
};

export function projectTypeFromSlug(slug: string): ProjectType | null {
  return (JOURNEY_SLUGS as readonly string[]).includes(slug) ? SLUG_TO_TYPE[slug as JourneySlug] : null;
}

export const GENERAL_DISCLAIMER =
  "These are conceptual design ideas, not construction drawings. Have a qualified professional validate dimensions, structure, safety, and local regulations before building.";
