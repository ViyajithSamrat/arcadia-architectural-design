import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The components only call these; the server side is tested in reference-uploads and reference-route.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/projects/actions", () => ({ removeReferenceAction: vi.fn(), saveStepAction: vi.fn() }));

const { ReferenceUploads } = await import("@/components/journey/reference-uploads");
const { StepForm } = await import("@/components/journey/step-form");

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => decode(renderToStaticMarkup(node));
const ID = "33333333-3333-4333-8333-333333333333";
const item = (n: number, url: string | null = `https://signed.test/${n}`) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, url, width: 640, height: 360, createdAt: "2026-10-21T00:00:00Z" });

describe("ReferenceUploads", () => {
  it("states the constraints and that the files are private, and offers a labelled file input for the three image types", () => {
    const out = html(createElement(ReferenceUploads, { projectId: ID, items: [], sentToImageService: false }));
    expect(out).toContain("JPEG, PNG or WebP, up to 5 MB each, up to 6 files");
    expect(out).toContain("stored privately: only you and our reviewer can see them");
    expect(out).toContain("In this setup they are not sent to any outside service.");
    expect(out).toContain("No photos added yet. You can continue without them.");
    expect(out).toMatch(/<label[^>]*>Add a photo<\/label>/);
    expect(out).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(out).not.toContain("Uploads not configured");
  });

  it("tells the truth when photos are sent to the live image service", () => {
    const out = html(createElement(ReferenceUploads, { projectId: ID, items: [], sentToImageService: true }));
    expect(out).toContain("up to three of these photos are sent to it as reference input");
    expect(out).not.toContain("not sent to any outside service");
  });

  it("shows lazy, sized thumbnails with alt text, a remove control per photo, and never a storage path", () => {
    const out = html(createElement(ReferenceUploads, { projectId: ID, items: [item(1), item(2)], sentToImageService: false }));
    expect(out.match(/<img /g)).toHaveLength(2);
    expect(out).toContain('alt="Reference photo 1"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('width="640"');
    expect(out.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(out).toContain('aria-label="Remove reference photo 2"');
    expect(out).toMatch(/<label[^>]*>Add another photo<\/label>/);
    expect(out).not.toMatch(/\/references\/|storage_path/);
  });

  it("says so in words when a thumbnail link is missing, instead of a broken picture", () => {
    const out = html(createElement(ReferenceUploads, { projectId: ID, items: [item(1, null)], sentToImageService: false }));
    expect(out).toContain("This photo could not be shown. Reload the page.");
    expect(out).not.toContain("<img ");
  });

  it("disables adding at the limit and says why", () => {
    const out = html(createElement(ReferenceUploads, { projectId: ID, items: [1, 2, 3, 4, 5, 6].map((n) => item(n)), sentToImageService: false }));
    expect(out).toMatch(/<input[^>]*type="file"[^>]*disabled/);
    expect(out).toContain("You have added the most photos allowed. Remove one to add another.");
  });
});

describe("StepForm and the upload step", () => {
  const step = (references: Parameters<typeof StepForm>[0]["references"]) =>
    html(createElement(StepForm, { projectId: ID, projectType: "INTERIOR", stepId: "space", initial: {}, voice: { state: "off" }, references }));

  it("shows the uploader on the interior step that takes photos, in place of the old not-configured notice", () => {
    const out = step({ items: [], sentToImageService: false });
    expect(out).toContain("Photos or a floor plan (optional)");
    expect(out).not.toContain("Uploads not configured yet");
  });

  it("shows an honest unavailable notice, and still lets the customer continue, when the photos could not be loaded", () => {
    const out = step(null);
    expect(out).toContain("Photo uploads are unavailable right now");
    expect(out).toContain("You can continue without them");
    expect(out).toMatch(/Save and/);
  });

  it("shows no uploader on steps that take no photos, and none for a new build", () => {
    const other = html(createElement(StepForm, { projectId: ID, projectType: "INTERIOR", stepId: "preferences", initial: {}, voice: { state: "off" }, references: { items: [], sentToImageService: false } }));
    expect(other).not.toContain("Photos or a floor plan");
    const plot = html(createElement(StepForm, { projectId: ID, projectType: "EMPTY_PLOT", stepId: "space", initial: {}, voice: { state: "off" }, references: { items: [], sentToImageService: false } }));
    expect(plot).not.toContain("Photos or a floor plan");
  });
});
