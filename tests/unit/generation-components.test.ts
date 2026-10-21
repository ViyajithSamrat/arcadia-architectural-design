import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The controls only call these; the server logic behind them is tested in generation-actions.test.ts.
vi.mock("@/app/(app)/admin/generation/actions", () => ({
  startGenerationAction: vi.fn(),
  releaseProjectAction: vi.fn(),
  clearStaleJobAction: vi.fn(),
}));

const { ClearStaleJobForm, ReleaseForm, StartGenerationForm } = await import("@/components/generation/controls");
const { ConceptDisclaimer, ImageGallery, MockWarning } = await import("@/components/generation/image-gallery");
const { CONCEPT_DISCLAIMER, MOCK_WARNING, RELEASE_EXPLANATION } = await import("@/lib/generation/copy");
const { FloorPlanSketch } = await import("@/components/generation/floor-plan");
const { describeFloorPlan } = await import("@/lib/generation/floor-plan");

const ID = "33333333-3333-4333-8333-333333333333";
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("the fixed wording", () => {
  it("keeps the mock warning exactly as specified", () => {
    expect(MOCK_WARNING).toBe("MOCK — NOT A DESIGN. Illustrative placeholder only; not construction-ready.");
  });

  it("states what the disclaimer must: conceptual, not construction, CAD/BIM, code-compliant or approved", () => {
    for (const phrase of ["conceptual illustrations", "not construction drawings", "CAD or BIM", "not code-compliant", "MOCK — NOT A DESIGN"]) {
      expect(CONCEPT_DISCLAIMER).toContain(phrase);
    }
  });

  it("tells the administrator what becomes visible, that it cannot be undone and that nothing is automatic", () => {
    expect(RELEASE_EXPLANATION).toMatch(/visible to the customer/);
    expect(RELEASE_EXPLANATION).toMatch(/cannot be undone/);
    expect(RELEASE_EXPLANATION).toMatch(/Nothing is released automatically/);
  });
});

describe("the warning and disclaimer components", () => {
  it("renders the mock warning prominently, as text", () => {
    const out = decode(html(createElement(MockWarning)));
    expect(out).toContain(MOCK_WARNING);
    expect(out).toMatch(/must not be shown to a customer as a design/);
  });

  it("renders the customer disclaimer", () => {
    expect(decode(html(createElement(ConceptDisclaimer)))).toContain(CONCEPT_DISCLAIMER);
  });
});

describe("ImageGallery", () => {
  const image = (patch = {}) => ({ id: "a1", label: "Exterior concept", width: 640, height: 360, url: "https://signed.test/x?t=60", ...patch });

  it("renders accessible, lazy, sized images and no storage path", () => {
    const out = html(createElement(ImageGallery, { images: [image()], caption: "Generated images" }));
    expect(out).toContain('alt="Exterior concept (conceptual illustration)"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('width="640"');
    expect(out).toContain('height="360"');
    expect(out.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(out).not.toMatch(/storage_path|\/generated\//);
  });

  it("says so in words when a link is missing, and when there is nothing to show", () => {
    expect(html(createElement(ImageGallery, { images: [image({ url: null })], caption: "x" }))).toContain("could not be loaded");
    expect(html(createElement(ImageGallery, { images: [], caption: "x" }))).toContain("No images to show");
  });
});

describe("FloorPlanSketch", () => {
  const ANSWERS = {
    space: { plotWidth: 30, plotLength: 40, unit: "ft", floors: 2, location: "Chennai" },
    rooms: { bedrooms: 2, bathrooms: 1, parkingSpaces: 0, spaces: ["living"] },
    preferences: { style: "modern", budgetBand: "standard", vastu: "undecided", exteriorViews: 1, interiorViews: 0 },
    description: {},
  };
  const plan = () => {
    const p = describeFloorPlan("EMPTY_PLOT", ANSWERS);
    if (!p) throw new Error("expected a plan");
    return p;
  };

  it("shows each floor as a sized, lazy image from an SVG data URL, with the disclaimer and the numbered blocks as text", () => {
    const out = decode(html(createElement(FloorPlanSketch, { plan: plan(), audience: "customer" })));
    expect(out.match(/<img /g)).toHaveLength(2);
    expect(out).toContain('src="data:image/svg+xml;charset=utf-8,');
    expect(out).toContain('alt="Ground floor: illustrative layout sketch of the plot and the requested rooms"');
    expect(out).toContain('width="720"');
    expect(out).toContain('height="540"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain("Illustrative layout only — not CAD or a construction drawing.");
    expect(out).toContain("not by an AI model");
    expect(out).toMatch(/1\. Living room/);
    expect(out).toMatch(/Bedroom 1/);
    expect(out).not.toContain("only after the project is released");
    expect(out).not.toMatch(/MOCK/);
  });

  it("tells the administrator when the customer will see it", () => {
    expect(decode(html(createElement(FloorPlanSketch, { plan: plan(), audience: "admin" })))).toContain("The customer sees this sketch only after the project is released");
  });

  it("says so in words, with no image, when the sketch cannot be drawn", () => {
    const out = html(createElement(FloorPlanSketch, { plan: { state: "unavailable" }, audience: "customer" }));
    expect(out).toContain("The layout sketch could not be drawn");
    expect(out).not.toContain("<img");
  });
});

describe("administrator controls", () => {
  it.each([
    ["start", "Start mock generation", /test generator\. No AI model is used and nothing is spent/],
    ["retry", "Try generation again", /last attempt failed and left nothing behind/],
    ["resume", "Start generation again", /never began/],
    ["finish", "Finish and move to review", /without generating again/],
  ] as const)("StartGenerationForm (%s) says what it does", (mode, label, hint) => {
    const out = html(createElement(StartGenerationForm, { projectId: ID, mode }));
    expect(out).toContain(label);
    expect(out).toMatch(hint);
    expect(out).toContain('type="submit"');
    expect(out).not.toMatch(/\sdisabled(=|\s|>)/); // the attribute, not the Tailwind variant in the class names
  });

  it("ReleaseForm explains the consequence and asks for a review confirmation plus, for mock output, a second one", () => {
    const mock = decode(html(createElement(ReleaseForm, { projectId: ID, assetCount: 2, mock: true })));
    expect(mock).toContain(RELEASE_EXPLANATION);
    expect(mock).toContain("I reviewed all 2 images above");
    expect(mock).toContain("I understand these are MOCK placeholders");
    expect(mock.match(/type="checkbox"/g)).toHaveLength(2);
    expect(mock.match(/required/g)).toHaveLength(2);
    expect(mock).toContain("Release 2 images to the customer");

    const real = decode(html(createElement(ReleaseForm, { projectId: ID, assetCount: 1, mock: false })));
    expect(real.match(/type="checkbox"/g)).toHaveLength(1);
    expect(real).not.toContain("MOCK placeholders");
    expect(real).toContain("Release 1 image to the customer");
  });

  it("ClearStaleJobForm needs a confirmation and says nothing is released", () => {
    const out = decode(html(createElement(ClearStaleJobForm, { projectId: ID })));
    expect(out).toContain("Nothing is released");
    expect(out.match(/type="checkbox"/g)).toHaveLength(1);
    expect(out).toContain("required");
    expect(out).toContain("Clear the interrupted job");
  });
});
