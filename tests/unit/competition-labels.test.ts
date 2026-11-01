import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/(app)/projects/actions", () => ({ mockGatewayPayAction: async () => ({ ok: false, message: "unused" }) }));

import { MockCheckout, SIMULATED_PAYMENT_LABEL } from "@/components/payments/mock-checkout";
import { QuoteTable } from "@/components/journey/quote-table";
import { DEMO_QUOTE_LABEL } from "@/lib/journeys/quote";
import type { StoredQuote } from "@/lib/journeys/service";

const quote = (version: string): StoredQuote => ({
  id: "q1",
  currency: "INR",
  lines: [{ key: "base_fee", label: "Brief and project setup", quantity: 1, unit: "project", rateMinor: 150000, includedQuantity: 0, amountMinor: 150000 }],
  subtotal: 1500,
  taxAmount: 270,
  discountAmount: 0,
  totalAmount: 1770,
  pricingRuleVersion: version,
  validUntil: null,
  acceptedAt: null,
});

describe("competition labels", () => {
  it("labels a quote built from demo rates, on the notice and inside the quotation itself", () => {
    expect(DEMO_QUOTE_LABEL).toBe("DEMO RATES — NOT COMMERCIAL PRICING");
    const out = renderToStaticMarkup(createElement(QuoteTable, { quote: quote("DEMO:base_fee@1,tax_percent@1") }));
    expect(out.split(DEMO_QUOTE_LABEL).length - 1).toBe(2); // notice title + the line in the quotation header
    expect(out).toContain("₹1,770.00");
  });

  it("does not label a quote built from approved rates", () => {
    const out = renderToStaticMarkup(createElement(QuoteTable, { quote: quote("base_fee@1,tax_percent@1") }));
    expect(out).not.toContain("DEMO RATES");
  });

  it("states on the payment page and in the checkout dialog that no money is transferred", () => {
    expect(SIMULATED_PAYMENT_LABEL).toBe("SIMULATED PAYMENT — NO MONEY IS TRANSFERRED");
    const out = renderToStaticMarkup(createElement(MockCheckout, { projectId: "p1", amountLabel: "₹1,770.00" }));
    expect(out.split(SIMULATED_PAYMENT_LABEL).length - 1).toBe(2); // page + dialog
  });
});
