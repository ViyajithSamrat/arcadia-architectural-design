import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const { AccessGate } = await import("@/components/journey/access-gate");

describe("the sign-in gate shown in place of a protected page", () => {
  const html = renderToStaticMarkup(createElement(AccessGate, { access: { state: "signed_out" } }));

  it("has a page heading, offers both Sign in and Create account, and returns the visitor to the page", () => {
    expect(html).toContain('<h1 class="sr-only">Sign in to continue</h1>');
    expect(html).toContain('href="/sign-in?next=%2Fprojects"');
    expect(html).toContain('href="/sign-in?mode=sign-up&amp;next=%2Fprojects"');
    expect(html).toContain("Create account");
  });

  it("does not offer a sign-in method that is not set up (Google)", () => {
    expect(html).not.toMatch(/google/i);
  });

  it("has a heading when sign-in is unavailable too", () => {
    expect(renderToStaticMarkup(createElement(AccessGate, { access: { state: "not_configured" } }))).toContain("<h1");
  });
});

describe("public claims stay true whether or not automatic release is on", () => {
  const files = ["src/app/(marketing)/page.tsx", "src/app/layout.tsx", "src/app/(app)/projects/[id]/payment/page.tsx"];
  it.each(files)("%s never says a person reviews or releases every image before the customer sees it", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/each checked by a person before it reaches you/i);
    expect(source).not.toMatch(/(reviews?|reviewed)[^.]{0,40}(every|each) image/i);
    expect(source).not.toMatch(/reviewed (by a person )?and released/i);
    expect(source).not.toMatch(/reviewed, then released/i);
  });
});
