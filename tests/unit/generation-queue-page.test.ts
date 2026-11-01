import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATION_MODE_NOTICE } from "@/lib/generation/copy";

/**
 * The administrator's generation queue tells the truth about the image generator the server will
 * use. It used to say, whatever the configuration, "mock placeholder images only; no AI image
 * provider is connected". These render the real page with only the data layer replaced.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/generation" }));

const getAdminAccess = vi.fn();
vi.mock("@/lib/admin/access", () => ({ getAdminAccess: () => getAdminAccess() }));

const listGenerationQueue = vi.fn();
vi.mock("@/lib/generation/read", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listGenerationQueue: () => listGenerationQueue(),
}));

const { default: GenerationQueuePage } = await import("@/app/(app)/admin/generation/page");

/** Renders the page's async content the way the Suspense boundary would. */
async function render(): Promise<string> {
  const page = GenerationQueuePage() as ReactElement<{ children: ReactElement<{ children: ReactElement }> }>;
  const content = page.props.children.props.children as ReactElement<object, (p: object) => Promise<ReactElement>>;
  return renderToStaticMarkup(await content.type(content.props));
}

const ROW = { projectId: "04e96bc2-8011-48fe-9f5f-3100839e2da5", customerId: "1a5ed48c-0000-4000-8000-000000000000", projectType: "EMPTY_PLOT", phase: "can_start", jobCount: 0, assetCount: 0, updatedAt: "2026-10-28T12:00:00.000Z" };
const LIVE_SETTINGS = { OPENROUTER_API_KEY: "sk-or-test-key-NOT-A-REAL-KEY-0000000000", OPENROUTER_IMAGE_MODEL: "bytedance-seed/seedream-4.5" };
const STALE = /no AI image provider is connected/i;

beforeEach(() => {
  getAdminAccess.mockReset().mockResolvedValue({ state: "ok", supabase: {}, user: { id: "admin" } });
  listGenerationQueue.mockReset().mockResolvedValue([]);
  for (const name of ["PROVIDER_MODE", "OPENROUTER_API_KEY", "OPENROUTER_IMAGE_MODEL"]) vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("the generation queue banner", () => {
  it("mock mode: says mock generation is on and clearly labelled, nothing is called or spent, and does not claim live is configured", async () => {
    vi.stubEnv("PROVIDER_MODE", "mock");
    const html = await render();
    expect(html).toContain("Mock generation is on: test images only");
    expect(html).toContain("labelled “MOCK — NOT A DESIGN.”");
    expect(html).toContain("No AI image model is called and nothing is spent");
    expect(html).toContain("Live image generation is not switched on for this server");
    expect(html).not.toContain("Live image generation is on");
    expect(html).not.toContain("uses credits");
    expect(html).not.toMatch(STALE);
  });

  it("mock mode is also what an unset PROVIDER_MODE means, even with OpenRouter fully configured", async () => {
    const variants: Record<string, string>[] = [{}, LIVE_SETTINGS];
    for (const settings of variants) {
      for (const [k, v] of Object.entries(settings)) vi.stubEnv(k, v);
      expect(await render()).toContain(GENERATION_MODE_NOTICE.mock.title);
    }
  });

  it("live mode with complete settings: says live generation is on and uses credits, never mock", async () => {
    vi.stubEnv("PROVIDER_MODE", "live");
    for (const [k, v] of Object.entries(LIVE_SETTINGS)) vi.stubEnv(k, v);
    const html = await render();
    expect(html).toContain("Live image generation is on: it uses credits");
    expect(html).toContain("Each image is billed and there is no automatic retry");
    expect(html).not.toContain("Mock generation is on");
    expect(html).not.toMatch(STALE);
  });

  it("live mode with incomplete settings: says generation cannot start and does not fall back to mock images", async () => {
    vi.stubEnv("PROVIDER_MODE", "live");
    const html = await render();
    expect(html).toContain("Live image generation is requested but not available");
    expect(html).toContain("does not fall back to mock images");
    expect(html).not.toContain("Mock generation is on");
    expect(html).not.toMatch(STALE);
  });

  it("every mode has its own wording, so the screen cannot show another mode's text", () => {
    const titles = Object.values(GENERATION_MODE_NOTICE).map((n) => n.title);
    expect(new Set(titles).size).toBe(3);
    for (const n of Object.values(GENERATION_MODE_NOTICE)) expect(n.body.length).toBeGreaterThan(40);
  });

  it("keeps the rest of the page: the queue sections, links and the rule that placeholders and held images wait for a person", async () => {
    listGenerationQueue.mockResolvedValue([ROW]);
    const html = await render();
    expect(html).toContain("Projects whose payment an administrator has verified");
    expect(html).toContain("Generation starts by itself when a payment is verified.");
    expect(html).toContain("wait here for a person to review and release them");
    expect(html).toContain("Ready to generate (1)");
    expect(html).toContain('href="/admin/generation/04e96bc2-8011-48fe-9f5f-3100839e2da5"');
    for (const section of ["In progress or needs attention (0)", "Awaiting release (0)", "Released (0)"]) expect(html).toContain(section);
  });

  it("is shown only inside the administrator view: a customer or a signed-out visitor gets no banner", async () => {
    getAdminAccess.mockResolvedValue({ state: "forbidden" });
    const customer = await render();
    expect(customer).toContain("You do not have access to this area");
    expect(customer).not.toContain("Mock generation is on");
    expect(listGenerationQueue).not.toHaveBeenCalled();

    getAdminAccess.mockResolvedValue({ state: "signed_out" });
    const anonymous = await render();
    expect(anonymous).toContain("Sign in to continue");
    expect(anonymous).not.toContain("Mock generation is on");
    expect(listGenerationQueue).not.toHaveBeenCalled();
  });
});
