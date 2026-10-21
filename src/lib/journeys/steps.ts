import type { ProjectType } from "@/lib/db/schema";

/**
 * Declarative definition of every question in the three journeys
 * (04_UI_UX.md section 4.4). The form renderer, the client check, the server check
 * and the brief builder all read this one definition, so they cannot disagree.
 *
 * Numeric bounds are sanity limits that reject typos (a 5000 ft plot); they are not
 * business rules. Budget bands are relative words, never amounts.
 */

type Option = { value: string; label: string };

type Common = { name: string; label: string; hint?: string };

export type FieldSpec =
  | (Common & { kind: "number"; required?: boolean; integer?: boolean; min: number; max: number; step?: number })
  | (Common & { kind: "text"; required?: boolean; min?: number; max: number })
  | (Common & { kind: "textarea"; required?: boolean; max: number; rows?: number })
  | (Common & { kind: "select"; required?: boolean; options: readonly Option[] })
  | (Common & { kind: "checkbox" })
  | (Common & { kind: "checkboxes"; required?: boolean; options: readonly Option[] });

export type FieldIssue = { field: string; message: string };

export type StepSpec = {
  id: string;
  title: string;
  intro: string;
  fields: readonly FieldSpec[];
  /** Cross-field rules that a single field cannot express. */
  check?: (data: Record<string, unknown>) => FieldIssue[];
  /** Shows the uploads-not-configured notice on this step. */
  showsUploadNotice?: boolean;
  /** Shows the text-description box and voice status on this step. */
  isDescription?: boolean;
};

const UNIT_LENGTH: readonly Option[] = [
  { value: "ft", label: "Feet" },
  { value: "m", label: "Metres" },
];

const BUDGET_BANDS: readonly Option[] = [
  { value: "undecided", label: "Not decided yet" },
  { value: "economy", label: "Economy" },
  { value: "standard", label: "Standard" },
  { value: "premium", label: "Premium" },
];

const BUDGET_FIELD: FieldSpec = {
  kind: "select",
  name: "budgetBand",
  label: "Budget band",
  required: true,
  options: BUDGET_BANDS,
  hint: "A relative guide only. No amount is assumed.",
};

const BUILDING_STYLES: readonly Option[] = [
  { value: "undecided", label: "Not sure yet" },
  { value: "modern", label: "Modern" },
  { value: "contemporary", label: "Contemporary" },
  { value: "traditional", label: "Traditional" },
  { value: "minimalist", label: "Minimalist" },
  { value: "industrial", label: "Industrial" },
];

/** Longest free-text description; a voice transcript is cut to this before it fills the field. */
export const DESCRIPTION_MAX_CHARS = 2000;

const DESCRIPTION_STEP: StepSpec = {
  id: "description",
  title: "In your own words",
  intro:
    "Add anything the questions did not cover. This is optional: you can continue with the answers you have already given.",
  isDescription: true,
  fields: [
    {
      kind: "textarea",
      name: "text",
      label: "Describe your project",
      max: DESCRIPTION_MAX_CHARS,
      rows: 6,
      hint: "For example: what the space is used for, what you like, what you want to avoid.",
    },
  ],
};

/** Both dimensions or neither, so a half-filled size never reaches the brief. */
function pairedDimensions(a: string, b: string, label: string) {
  return (data: Record<string, unknown>): FieldIssue[] => {
    const hasA = data[a] !== undefined;
    const hasB = data[b] !== undefined;
    if (hasA === hasB) return [];
    return [{ field: hasA ? b : a, message: `Enter both ${label} dimensions, or leave both empty.` }];
  };
}

const EMPTY_PLOT_STEPS: readonly StepSpec[] = [
  {
    id: "space",
    title: "Your space",
    intro: "The plot and where it is. Orientation and built-up area are optional.",
    fields: [
      { kind: "number", name: "plotWidth", label: "Plot width", required: true, min: 1, max: 1000, step: 0.1 },
      { kind: "number", name: "plotLength", label: "Plot length", required: true, min: 1, max: 1000, step: 0.1 },
      { kind: "select", name: "unit", label: "Unit", required: true, options: UNIT_LENGTH },
      {
        kind: "select",
        name: "orientation",
        label: "Direction the plot faces",
        options: [
          { value: "unknown", label: "Not sure" },
          { value: "N", label: "North" },
          { value: "NE", label: "North-east" },
          { value: "E", label: "East" },
          { value: "SE", label: "South-east" },
          { value: "S", label: "South" },
          { value: "SW", label: "South-west" },
          { value: "W", label: "West" },
          { value: "NW", label: "North-west" },
        ],
      },
      {
        kind: "number",
        name: "builtUpArea",
        label: "Built-up area (all floors)",
        min: 1,
        max: 1000000,
        hint: "In the square of the unit above. Leave empty if you do not know.",
      },
      { kind: "number", name: "floors", label: "Floors", required: true, integer: true, min: 1, max: 4 },
      { kind: "text", name: "location", label: "City or area", required: true, min: 2, max: 120 },
      {
        kind: "text",
        name: "climate",
        label: "Climate notes",
        max: 120,
        hint: "For example hot and humid, heavy monsoon.",
      },
    ],
  },
  {
    id: "rooms",
    title: "Rooms and circulation",
    intro: "What the home needs. Counts are whole numbers.",
    fields: [
      { kind: "number", name: "bedrooms", label: "Bedrooms", required: true, integer: true, min: 1, max: 10 },
      { kind: "number", name: "bathrooms", label: "Bathrooms", required: true, integer: true, min: 1, max: 10 },
      { kind: "number", name: "parkingSpaces", label: "Parking spaces", required: true, integer: true, min: 0, max: 6 },
      {
        kind: "checkboxes",
        name: "spaces",
        label: "Other spaces",
        options: [
          { value: "living", label: "Living room" },
          { value: "kitchen", label: "Kitchen" },
          { value: "dining", label: "Dining area" },
          { value: "stairs", label: "Staircase" },
          { value: "balcony", label: "Balcony" },
          { value: "utility", label: "Utility area" },
          { value: "study", label: "Study" },
          { value: "puja", label: "Puja room" },
          { value: "storage", label: "Storage room" },
        ],
      },
    ],
  },
  {
    id: "preferences",
    title: "Your preferences",
    intro: "Style, budget and how many concept views you would like.",
    fields: [
      { kind: "select", name: "style", label: "Style", required: true, options: BUILDING_STYLES },
      BUDGET_FIELD,
      {
        kind: "select",
        name: "vastu",
        label: "Vastu preference",
        required: true,
        options: [
          { value: "undecided", label: "No preference" },
          { value: "yes", label: "Follow Vastu where possible" },
          { value: "no", label: "Do not apply Vastu" },
        ],
      },
      { kind: "number", name: "exteriorViews", label: "Exterior views", required: true, integer: true, min: 1, max: 6 },
      { kind: "number", name: "interiorViews", label: "Interior views", required: true, integer: true, min: 0, max: 6 },
      { kind: "checkbox", name: "frontGarden", label: "Include a front garden concept" },
    ],
  },
  DESCRIPTION_STEP,
];

const INTERIOR_ROOMS: readonly Option[] = [
  { value: "living_room", label: "Living room" },
  { value: "bedroom", label: "Bedroom" },
  { value: "kitchen", label: "Kitchen" },
  { value: "dining", label: "Dining area" },
  { value: "bathroom", label: "Bathroom" },
  { value: "study", label: "Study" },
  { value: "other", label: "Other room" },
];

const INTERIOR_STEPS: readonly StepSpec[] = [
  {
    id: "space",
    title: "Existing space",
    intro: "Which rooms to refresh. Dimensions are optional; give both or neither.",
    showsUploadNotice: true,
    check: pairedDimensions("roomWidth", "roomLength", "room"),
    fields: [
      { kind: "checkboxes", name: "rooms", label: "Rooms to refresh", required: true, options: INTERIOR_ROOMS },
      { kind: "number", name: "roomWidth", label: "Approximate room width", min: 1, max: 1000, step: 0.1 },
      { kind: "number", name: "roomLength", label: "Approximate room length", min: 1, max: 1000, step: 0.1 },
      { kind: "select", name: "unit", label: "Unit", required: true, options: UNIT_LENGTH },
    ],
  },
  {
    id: "preferences",
    title: "Your preferences",
    intro: "Style, colours and how many concept views per room.",
    fields: [
      { kind: "select", name: "style", label: "Style", required: true, options: BUILDING_STYLES },
      { kind: "text", name: "palette", label: "Colours and materials", max: 300, hint: "For example warm wood, off-white walls." },
      { kind: "text", name: "storageNeeds", label: "Storage needs", max: 300 },
      BUDGET_FIELD,
      { kind: "number", name: "viewsPerRoom", label: "Concept views per room", required: true, integer: true, min: 1, max: 4 },
      { kind: "checkbox", name: "materialSheet", label: "Include a material and colour sheet" },
    ],
  },
  {
    id: "preserve",
    title: "Must preserve",
    intro: "Anything that has to stay as it is. Concepts will work around these.",
    fields: [
      {
        kind: "checkboxes",
        name: "keep",
        label: "Keep in place",
        options: [
          { value: "doors", label: "Doors" },
          { value: "windows", label: "Windows" },
          { value: "columns", label: "Columns and beams" },
          { value: "plumbing", label: "Plumbing points" },
          { value: "electrical", label: "Electrical points" },
          { value: "furniture", label: "Furniture I want to keep" },
        ],
      },
      { kind: "textarea", name: "keepNotes", label: "Details", max: 500, rows: 3, hint: "For example which sofa, which window." },
    ],
  },
  DESCRIPTION_STEP,
];

const LANDSCAPE_STEPS: readonly StepSpec[] = [
  {
    id: "area",
    title: "Your outdoor area",
    intro: "Which part of the property and roughly how large.",
    showsUploadNotice: true,
    fields: [
      {
        kind: "select",
        name: "areaType",
        label: "Area",
        required: true,
        options: [
          { value: "front", label: "Front yard" },
          { value: "back", label: "Back yard" },
          { value: "side", label: "Side yard" },
          { value: "terrace", label: "Terrace or rooftop" },
          { value: "other", label: "Other" },
        ],
      },
      { kind: "number", name: "approxArea", label: "Approximate area", required: true, min: 1, max: 1000000 },
      {
        kind: "select",
        name: "areaUnit",
        label: "Unit",
        required: true,
        options: [
          { value: "sqft", label: "Square feet" },
          { value: "sqm", label: "Square metres" },
        ],
      },
    ],
  },
  {
    id: "conditions",
    title: "Local conditions",
    intro: "Conditions that decide what can grow and how it is used.",
    fields: [
      { kind: "text", name: "location", label: "City or area", required: true, min: 2, max: 120 },
      { kind: "text", name: "climate", label: "Climate notes", max: 120 },
      {
        kind: "select",
        name: "sunlight",
        label: "Sunlight",
        required: true,
        options: [
          { value: "unsure", label: "Not sure" },
          { value: "full", label: "Full sun most of the day" },
          { value: "partial", label: "Partial shade" },
          { value: "shade", label: "Mostly shade" },
        ],
      },
      {
        kind: "select",
        name: "water",
        label: "Water availability",
        required: true,
        options: [
          { value: "unsure", label: "Not sure" },
          { value: "good", label: "A water point nearby" },
          { value: "limited", label: "Limited" },
          { value: "none", label: "None" },
        ],
      },
      {
        kind: "select",
        name: "maintenance",
        label: "Upkeep you want",
        required: true,
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
      { kind: "checkbox", name: "children", label: "Children will use the space" },
      { kind: "checkbox", name: "pets", label: "Pets will use the space" },
    ],
  },
  {
    id: "features",
    title: "Features and style",
    intro: "What to include and what to keep.",
    fields: [
      { kind: "textarea", name: "retain", label: "Existing trees or features to keep", max: 500, rows: 3 },
      { kind: "checkbox", name: "paths", label: "Paths and hard surfaces" },
      { kind: "checkbox", name: "seating", label: "A place to sit" },
      { kind: "checkbox", name: "privacy", label: "Privacy screening" },
      { kind: "checkbox", name: "vegetableGarden", label: "Vegetable or herb garden" },
      {
        kind: "select",
        name: "style",
        label: "Style",
        required: true,
        options: [
          { value: "undecided", label: "Not sure yet" },
          { value: "native", label: "Native, low water" },
          { value: "formal", label: "Formal" },
          { value: "tropical", label: "Tropical" },
          { value: "contemporary", label: "Contemporary" },
        ],
      },
      BUDGET_FIELD,
      { kind: "number", name: "views", label: "Concept views", required: true, integer: true, min: 1, max: 6 },
    ],
  },
  DESCRIPTION_STEP,
];

export const JOURNEY_STEPS: Readonly<Record<ProjectType, readonly StepSpec[]>> = {
  EMPTY_PLOT: EMPTY_PLOT_STEPS,
  INTERIOR: INTERIOR_STEPS,
  LANDSCAPE: LANDSCAPE_STEPS,
};

/** The review stage follows the last question step. */
export function stepCount(type: ProjectType): number {
  return JOURNEY_STEPS[type].length;
}

export function findStep(type: ProjectType, stepId: string): StepSpec | undefined {
  return JOURNEY_STEPS[type].find((s) => s.id === stepId);
}

export function optionLabel(field: FieldSpec, value: unknown): string {
  if (field.kind !== "select" && field.kind !== "checkboxes") return String(value);
  return field.options.find((o) => o.value === value)?.label ?? String(value);
}
