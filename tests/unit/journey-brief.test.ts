import { describe, expect, it } from "vitest";
import { PROJECT_TYPES } from "@/lib/db/schema";
import {
  BriefProviderUnavailableError,
  describeAnswers,
  getBriefProvider,
  mockBriefProvider,
  parseBrief,
  type Brief,
} from "@/lib/journeys/brief";
import { validateRequirements } from "@/lib/journeys/validation";
import { REQUIREMENTS } from "./support/journey-fixtures";

async function briefFor(type: (typeof PROJECT_TYPES)[number]): Promise<Brief> {
  const check = validateRequirements(type, { schemaVersion: 1, ...REQUIREMENTS[type] });
  if (!check.complete) throw new Error("fixture must be complete");
  const raw = await mockBriefProvider.generate({ projectType: type, sourceLanguage: "en", requirements: check.requirements });
  const parsed = parseBrief(raw);
  if (!parsed.ok) throw new Error("mock brief must parse");
  return parsed.brief;
}

describe("mock brief provider", () => {
  it.each(PROJECT_TYPES)("produces a brief with the predictable structure for %s", async (type) => {
    const brief = await briefFor(type);
    expect(brief.projectType).toBe(type);
    expect(brief.englishBrief.length).toBeGreaterThan(40);
    expect(brief.assumptions.length).toBeGreaterThan(0);
    expect(brief.meta.provider).toBe("mock");
    expect(brief.meta.model).toBeNull();
    expect(brief.missingRequiredFields).toEqual([]);
    expect(brief.referenceAssetIds).toEqual([]);
  });

  it("is deterministic apart from its timestamp", async () => {
    const a = await briefFor("EMPTY_PLOT");
    const b = await briefFor("EMPTY_PLOT");
    expect({ ...a, meta: null }).toEqual({ ...b, meta: null });
  });

  it("states the customer's own numbers and nothing the customer did not give (empty plot)", async () => {
    const brief = await briefFor("EMPTY_PLOT");
    expect(brief.englishBrief).toContain("30 × 40 ft");
    expect(brief.englishBrief).toContain("Bengaluru");
    expect(brief.englishBrief).toMatch(/3 bedrooms/);
    expect(brief.dimensionsAndUnits).toMatchObject({ plotWidth: 30, plotLength: 40, unit: "ft", builtUpArea: null });
  });

  it("lists unknowns as open details instead of filling them in", async () => {
    const landscape = await briefFor("LANDSCAPE");
    expect(landscape.missingOptionalDetails).toEqual(expect.arrayContaining(["Climate notes", "Existing trees or features to keep"]));
    const interior = await briefFor("INTERIOR");
    expect(interior.missingOptionalDetails).toEqual(expect.arrayContaining(["Budget band"]));
    const plot = await briefFor("EMPTY_PLOT");
    expect(plot.missingOptionalDetails.join(" ")).toMatch(/Built-up area/);
    // The uploads gap is stated plainly rather than pretending a photo was considered.
    expect(plot.missingOptionalDetails.join(" ")).toMatch(/uploads are not configured/i);
  });

  it("carries must-preserve features forward (interior)", async () => {
    const brief = await briefFor("INTERIOR");
    expect(brief.englishBrief).toMatch(/windows/i);
    expect(brief.englishBrief).toMatch(/furniture/i);
    expect(brief.englishBrief).toContain("The teak sofa stays.");
    expect(brief.roomOrZoneList).toEqual(["living room", "bedroom"]);
  });

  it("includes the customer's own description verbatim", async () => {
    const brief = await briefFor("EMPTY_PLOT");
    expect(brief.englishBrief).toContain("We want plenty of light in the living room.");
  });
});

describe("brief parsing treats the producer as untrusted", () => {
  it("accepts a well-formed brief", async () => {
    expect(parseBrief(await briefFor("LANDSCAPE")).ok).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "A lovely house"],
    ["an empty object", {}],
    ["an array", []],
  ])("rejects %s", (_name, value) => {
    expect(parseBrief(value).ok).toBe(false);
  });

  it("rejects a brief with a missing field, an extra field, a bad enum, or a bad id", async () => {
    const good = await briefFor("INTERIOR");
    const withoutText: Partial<Brief> = { ...good };
    delete withoutText.englishBrief;
    expect(parseBrief(withoutText).ok).toBe(false);
    expect(parseBrief({ ...good, price: 100 }).ok).toBe(false);
    expect(parseBrief({ ...good, paymentVerified: true }).ok).toBe(false);
    expect(parseBrief({ ...good, projectType: "TOWER" }).ok).toBe(false);
    expect(parseBrief({ ...good, referenceAssetIds: ["not-a-uuid"] }).ok).toBe(false);
    expect(parseBrief({ ...good, englishBrief: "   " }).ok).toBe(false);
    expect(parseBrief({ ...good, meta: { ...good.meta, provider: "somebody-else" } }).ok).toBe(false);
  });

  it("does not coerce: numbers in text fields are rejected", async () => {
    const good = await briefFor("INTERIOR");
    expect(parseBrief({ ...good, assumptions: [42] }).ok).toBe(false);
  });
});

describe("provider selection", () => {
  it("uses the mock by default and for mock mode", () => {
    expect(getBriefProvider(undefined).id).toBe("mock");
    expect(getBriefProvider("mock").id).toBe("mock");
  });

  it("reports the live provider as unavailable instead of silently using the mock", () => {
    expect(() => getBriefProvider("live")).toThrow(BriefProviderUnavailableError);
  });
});

describe("describing answers for people", () => {
  it("words units and options and leaves out empty and unit-only entries", () => {
    const check = validateRequirements("EMPTY_PLOT", { schemaVersion: 1, ...REQUIREMENTS.EMPTY_PLOT });
    if (!check.complete) throw new Error("fixture must be complete");
    const facts = describeAnswers("EMPTY_PLOT", check.requirements);
    const get = (label: string) => facts.find((f) => f.label === label)?.value;
    expect(get("Plot width")).toBe("30 ft");
    expect(get("Direction the plot faces")).toBe("East");
    expect(get("Other spaces")).toBe("Living room, Kitchen, Staircase");
    expect(get("Include a front garden concept")).toBe("Yes");
    expect(facts.some((f) => f.label === "Unit")).toBe(false);
    expect(facts.some((f) => f.label === "Built-up area (all floors)")).toBe(false);
  });
});
