import { describe, expect, it } from "vitest";
import { PROJECT_TYPES } from "@/lib/db/schema";
import { JOURNEYS, JOURNEY_SLUGS, projectTypeFromSlug } from "@/lib/journeys/project-types";
import { findStep, JOURNEY_STEPS } from "@/lib/journeys/steps";
import { readStepForm, validateRequirements, validateStep } from "@/lib/journeys/validation";
import { REQUIREMENTS } from "./support/journey-fixtures";

function form(entries: Record<string, string | string[]>) {
  const map = new Map<string, string[]>(Object.entries(entries).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
  return { get: (name: string) => map.get(name)?.[0] ?? null, getAll: (name: string) => map.get(name) ?? [] };
}

describe("journey definitions", () => {
  it("has a distinct journey for each project type", () => {
    for (const type of PROJECT_TYPES) {
      expect(JOURNEYS[type].type).toBe(type);
      expect(JOURNEY_STEPS[type].length).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(JOURNEY_SLUGS).size).toBe(3);
  });

  it("branches: each type asks different questions", () => {
    const fieldNames = (t: (typeof PROJECT_TYPES)[number]) =>
      JOURNEY_STEPS[t].flatMap((s) => s.fields.map((f) => `${s.id}.${f.name}`));
    expect(fieldNames("EMPTY_PLOT")).toContain("space.plotWidth");
    expect(fieldNames("EMPTY_PLOT")).not.toContain("conditions.sunlight");
    expect(fieldNames("INTERIOR")).toContain("preserve.keep");
    expect(fieldNames("INTERIOR")).not.toContain("space.plotWidth");
    expect(fieldNames("LANDSCAPE")).toContain("conditions.sunlight");
    expect(fieldNames("LANDSCAPE")).not.toContain("preserve.keep");
  });

  it("maps URL slugs to database project types and rejects anything else", () => {
    expect(projectTypeFromSlug("empty-plot")).toBe("EMPTY_PLOT");
    expect(projectTypeFromSlug("interior")).toBe("INTERIOR");
    expect(projectTypeFromSlug("landscape")).toBe("LANDSCAPE");
    expect(projectTypeFromSlug("EMPTY_PLOT")).toBeNull();
    expect(projectTypeFromSlug("../etc")).toBeNull();
    expect(projectTypeFromSlug("")).toBeNull();
  });

  it("has unique step ids and field names, and every step has a way to carry on without voice or uploads", () => {
    for (const type of PROJECT_TYPES) {
      const ids = JOURNEY_STEPS[type].map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const step of JOURNEY_STEPS[type]) {
        const names = step.fields.map((f) => f.name);
        expect(new Set(names).size).toBe(names.length);
      }
      // The description step is optional, so a customer without voice can still finish.
      const description = JOURNEY_STEPS[type].find((s) => s.isDescription);
      expect(description).toBeDefined();
      expect(validateStep(description!, {}).ok).toBe(true);
    }
  });
});

describe("reading a form", () => {
  const space = findStep("EMPTY_PLOT", "space")!;

  it("turns blanks into unanswered and numeric text into numbers", () => {
    const data = readStepForm(space, form({ plotWidth: " 30 ", plotLength: "", unit: "ft", location: "  Mysuru " }));
    expect(data).toEqual({ plotWidth: 30, unit: "ft", location: "Mysuru" });
  });

  it("reads checkboxes as booleans and checkbox groups as lists", () => {
    const prefs = findStep("EMPTY_PLOT", "preferences")!;
    expect(readStepForm(prefs, form({ frontGarden: "on" })).frontGarden).toBe(true);
    expect(readStepForm(prefs, form({})).frontGarden).toBe(false);
    const rooms = findStep("EMPTY_PLOT", "rooms")!;
    expect(readStepForm(rooms, form({ spaces: ["living", "study"] })).spaces).toEqual(["living", "study"]);
  });

  it("keeps non-numeric text in a number field so validation can reject it", () => {
    const data = readStepForm(space, form({ plotWidth: "abc" }));
    expect(Number.isNaN(data.plotWidth)).toBe(true);
    const result = validateStep(space, data);
    expect(result.ok).toBe(false);
  });
});

describe("step validation", () => {
  const space = findStep("EMPTY_PLOT", "space")!;
  const valid = REQUIREMENTS.EMPTY_PLOT.space;

  it("accepts a valid step and returns the data", () => {
    const result = validateStep(space, valid);
    expect(result.ok).toBe(true);
  });

  it("reports each missing required field with a useful message", () => {
    const result = validateStep(space, { unit: "ft" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.plotWidth).toMatch(/required/i);
      expect(result.errors.plotLength).toMatch(/required/i);
      expect(result.errors.location).toMatch(/required/i);
      expect(result.errors.floors).toMatch(/required/i);
    }
  });

  it.each([
    ["negative width", { plotWidth: -4 }, "plotWidth"],
    ["zero length", { plotLength: 0 }, "plotLength"],
    ["absurd width", { plotWidth: 5000 }, "plotWidth"],
    ["fractional floors", { floors: 1.5 }, "floors"],
    ["too many floors", { floors: 9 }, "floors"],
    ["unknown unit", { unit: "yards" }, "unit"],
    ["one-letter city", { location: "B" }, "location"],
  ])("rejects %s", (_name, patch, field) => {
    const result = validateStep(space, { ...valid, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toBeTruthy();
  });

  it("rejects fields the form never offered (a forged payload)", () => {
    const result = validateStep(space, { ...valid, status: "RELEASED" });
    expect(result.ok).toBe(false);
  });

  it("requires both room dimensions or neither (interior)", () => {
    const step = findStep("INTERIOR", "space")!;
    const base = { rooms: ["bedroom"], unit: "ft" };
    expect(validateStep(step, base).ok).toBe(true);
    expect(validateStep(step, { ...base, roomWidth: 10, roomLength: 12 }).ok).toBe(true);
    const half = validateStep(step, { ...base, roomWidth: 10 });
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.errors.roomLength).toMatch(/both/i);
  });

  it("requires at least one room (interior)", () => {
    const result = validateStep(findStep("INTERIOR", "space")!, { rooms: [], unit: "ft" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.rooms).toMatch(/at least one/i);
  });

  it("limits free text length", () => {
    const step = findStep("EMPTY_PLOT", "description")!;
    expect(validateStep(step, { text: "x".repeat(2000) }).ok).toBe(true);
    expect(validateStep(step, { text: "x".repeat(2001) }).ok).toBe(false);
  });
});

describe("whole-project validation", () => {
  it.each(PROJECT_TYPES)("accepts the complete %s fixture", (type) => {
    const result = validateRequirements(type, { schemaVersion: 1, ...REQUIREMENTS[type] });
    expect(result.complete).toBe(true);
  });

  it.each(PROJECT_TYPES)("lists what is missing for an empty %s project, without inventing values", (type) => {
    const result = validateRequirements(type, { schemaVersion: 1 });
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.missingRequiredFields.length).toBeGreaterThan(2);
      expect(result.missingRequiredFields.every((m) => /\(.+\)$/.test(m))).toBe(true);
    }
  });

  it("treats a skipped optional step as fine but a skipped required step as missing", () => {
    const partial = { ...REQUIREMENTS.LANDSCAPE };
    delete (partial as Record<string, unknown>).description;
    expect(validateRequirements("LANDSCAPE", partial).complete).toBe(true);
    delete (partial as Record<string, unknown>).conditions;
    expect(validateRequirements("LANDSCAPE", partial).complete).toBe(false);
  });

  it("does not crash on junk stored data", () => {
    for (const junk of [null, undefined, 5, "text", [], { space: "nope" }, { space: [1, 2] }]) {
      expect(validateRequirements("EMPTY_PLOT", junk).complete).toBe(false);
    }
  });
});

describe("empty plot: built-up area must be believable (never guessed)", () => {
  const space = findStep("EMPTY_PLOT", "space")!;
  const base = { plotWidth: 233, plotLength: 323, unit: "ft", orientation: "NE", floors: 2, location: "Madurai" };

  it("refuses 2 sq ft on a 233 × 323 ft plot and says how to fix it", () => {
    const result = validateStep(space, { ...base, builtUpArea: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.builtUpArea).toMatch(/too small for the total floor area.*or leave it empty/);
  });

  it("refuses more than the plot area times the floors", () => {
    const result = validateStep(space, { ...base, builtUpArea: 233 * 323 * 2 + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.builtUpArea).toMatch(/more than the plot area times the number of floors/);
  });

  it("accepts a believable area in feet or metres, and an empty one", () => {
    expect(validateStep(space, { ...base, builtUpArea: 2400 }).ok).toBe(true);
    expect(validateStep(space, { ...base, unit: "m", plotWidth: 12, plotLength: 18, builtUpArea: 9 }).ok).toBe(true);
    expect(validateStep(space, { ...base, unit: "m", plotWidth: 12, plotLength: 18, builtUpArea: 8 }).ok).toBe(false);
    const empty = validateStep(space, base);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.builtUpArea).toBeUndefined();
  });

  it("a stored implausible area blocks the brief instead of reaching it", () => {
    const stored = { ...REQUIREMENTS.EMPTY_PLOT, space: { ...REQUIREMENTS.EMPTY_PLOT.space, builtUpArea: 2 } };
    const check = validateRequirements("EMPTY_PLOT", stored);
    expect(check.complete).toBe(false);
    if (!check.complete) expect(check.missingRequiredFields.join(" ")).toMatch(/Built-up area/);
  });
});
