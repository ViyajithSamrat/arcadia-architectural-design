import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConceptDisclaimer, CustomerMockWarning } from "@/components/generation/image-gallery";
import { ANNOTATIONS_NOTE, CONCEPT_DISCLAIMER, CONCEPT_DISCLAIMER_AI, MOCK_WARNING } from "@/lib/generation/copy";
import { getReleasedImageProvenance } from "@/lib/generation/read";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";

const project = (patch: Record<string, unknown> = {}) => ({ id: P1, customer_id: ME, project_type: "EMPTY_PLOT", status: "RELEASED", requirements_json: {}, ...patch });
const job = (id: string, provider: string, usage: Record<string, unknown> = {}) => ({ id, project_id: P1, status: "SUCCEEDED", provider, usage_json: usage });
const asset = (id: string, jobId: string, released = true) => ({ id, project_id: P1, generation_job_id: jobId, asset_type: "EXTERIOR_CONCEPT", is_released: released });

function clients(jobs: ReturnType<typeof job>[], assets: ReturnType<typeof asset>[], proj = project()) {
  const db = new FakeDb().seed("projects", [proj]).seed("generation_jobs", jobs).seed("design_assets", assets);
  const c = db.client() as unknown as SupabaseClient;
  return { customer: c, service: c };
}

describe("which released images are mock (results page)", () => {
  it("real OpenRouter images are never reported as mock", async () => {
    const { customer, service } = clients([job("j1", "openrouter", { mock: false })], [asset("a1", "j1"), asset("a2", "j1")]);
    expect(await getReleasedImageProvenance(customer, service, ME, P1)).toEqual({ state: "known", mockAssetIds: [] });
  });

  it("images from the test generator are reported, by provider or by the usage marker", async () => {
    const { customer, service } = clients([job("j1", "mock"), job("j2", "openrouter", { mock: true }), job("j3", "openrouter")], [asset("a1", "j1"), asset("a2", "j2"), asset("a3", "j3")]);
    expect(await getReleasedImageProvenance(customer, service, ME, P1)).toEqual({ state: "known", mockAssetIds: ["a1", "a2"] });
  });

  it("looks only at released images", async () => {
    const { customer, service } = clients([job("j1", "openrouter"), job("j2", "mock")], [asset("a1", "j1"), asset("a2", "j2", false)]);
    expect(await getReleasedImageProvenance(customer, service, ME, P1)).toEqual({ state: "known", mockAssetIds: [] });
  });

  it("claims nothing when it cannot tell: no trusted client, a missing job, another owner or not released", async () => {
    const ok = clients([job("j1", "openrouter")], [asset("a1", "j1")]);
    expect(await getReleasedImageProvenance(ok.customer, null, ME, P1)).toEqual({ state: "unknown" });
    const missing = clients([], [asset("a1", "j1")]);
    expect(await getReleasedImageProvenance(missing.customer, missing.service, ME, P1)).toEqual({ state: "unknown" });
    expect(await getReleasedImageProvenance(ok.customer, ok.service, OTHER, P1)).toEqual({ state: "unknown" });
    const pending = clients([job("j1", "mock")], [asset("a1", "j1")], project({ status: "READY_FOR_REVIEW" }));
    expect(await getReleasedImageProvenance(pending.customer, pending.service, ME, P1)).toEqual({ state: "unknown" });
  });
});

describe("results-page wording", () => {
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

  it("the confirmed-AI disclaimer has no mock wording; the fallback keeps it", () => {
    expect(CONCEPT_DISCLAIMER_AI).not.toMatch(/MOCK/);
    expect(CONCEPT_DISCLAIMER_AI).toContain("not construction drawings");
    const ai = decode(renderToStaticMarkup(createElement(ConceptDisclaimer, { allAi: true })));
    expect(ai).toContain(CONCEPT_DISCLAIMER_AI);
    expect(ai).not.toContain("MOCK");
    expect(decode(renderToStaticMarkup(createElement(ConceptDisclaimer)))).toContain(CONCEPT_DISCLAIMER);
  });

  it("always says that dimensions and labels inside an image are not verified measurements", () => {
    expect(ANNOTATIONS_NOTE).toMatch(/not verified architectural measurements/);
    for (const allAi of [true, false]) expect(decode(renderToStaticMarkup(createElement(ConceptDisclaimer, { allAi })))).toContain(ANNOTATIONS_NOTE);
  });

  it("the customer mock warning uses the fixed title and counts the placeholders", () => {
    const out = decode(renderToStaticMarkup(createElement(CustomerMockWarning, { count: 1, total: 2 })));
    expect(out).toContain(MOCK_WARNING);
    expect(out).toContain("1 of these 2 images is a placeholder");
  });
});
