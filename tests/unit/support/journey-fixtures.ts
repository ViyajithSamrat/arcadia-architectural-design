import type { ProjectType } from "@/lib/db/schema";
import type { StepData } from "@/lib/journeys/validation";

/** Complete, valid answers for each journey, in the shape stored in requirements_json. */
export const REQUIREMENTS: Record<ProjectType, Record<string, StepData>> = {
  EMPTY_PLOT: {
    space: { plotWidth: 30, plotLength: 40, unit: "ft", orientation: "E", floors: 2, location: "Bengaluru" },
    rooms: { bedrooms: 3, bathrooms: 2, parkingSpaces: 1, spaces: ["living", "kitchen", "stairs"] },
    preferences: { style: "modern", budgetBand: "standard", vastu: "undecided", exteriorViews: 4, interiorViews: 2, frontGarden: true },
    description: { text: "We want plenty of light in the living room." },
  },
  INTERIOR: {
    space: { rooms: ["living_room", "bedroom"], roomWidth: 12, roomLength: 15, unit: "ft" },
    preferences: { style: "minimalist", palette: "warm wood", budgetBand: "undecided", viewsPerRoom: 2, materialSheet: true },
    preserve: { keep: ["windows", "furniture"], keepNotes: "The teak sofa stays." },
    description: {},
  },
  LANDSCAPE: {
    area: { areaType: "front", approxArea: 1200, areaUnit: "sqft" },
    conditions: { location: "Pune", sunlight: "partial", water: "good", maintenance: "low", children: true, pets: false },
    features: { paths: true, seating: true, privacy: false, vegetableGarden: false, style: "native", budgetBand: "economy", views: 3 },
    description: {},
  },
};

/** What the database stores: the answers plus the schema marker. */
export function storedRequirements(type: ProjectType): Record<string, unknown> {
  return { schemaVersion: 1, ...REQUIREMENTS[type] };
}
