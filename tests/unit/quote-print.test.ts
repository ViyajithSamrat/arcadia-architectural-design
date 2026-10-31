import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrintButton } from "@/components/journey/print-button";
import { SiteFooter } from "@/components/layout/site-footer";

/**
 * The original plan promises a "downloadable/shareable quote summary". It is the quote page printed or saved
 * as a PDF from the browser: these pin the pieces that keep that printout to the quote itself. How the page
 * really prints is checked in a browser (see docs/IMPLEMENTATION_REQUIREMENTS_AUDIT.md).
 */
describe("printing the quote", () => {
  it("offers a plain button that is not itself printed", () => {
    const out = renderToStaticMarkup(createElement(PrintButton));
    expect(out).toContain('type="button"');
    expect(out).toContain("Print or save as PDF");
    expect(out).toContain("print:hidden");
    expect(out).not.toContain("<form");
  });

  it("keeps the concept disclaimer in a printout but leaves out the system-status link", () => {
    const out = renderToStaticMarkup(createElement(SiteFooter));
    const disclaimer = out.slice(out.indexOf("<p>"), out.indexOf("</p>"));
    expect(disclaimer).toContain("not construction drawings");
    expect(disclaimer).not.toContain("print:hidden");
    expect(out).toMatch(/<p class="print:hidden"><a [^>]*href="\/status"/);
  });
});
