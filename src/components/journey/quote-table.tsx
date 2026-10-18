import { formatMoney } from "@/lib/journeys/money";
import { isDemoVersion } from "@/lib/journeys/quote";
import type { StoredQuote } from "@/lib/journeys/service";
import { Notice } from "./notice";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** The itemized quote exactly as stored. Amounts come from the frozen snapshot, never recalculated here. */
export function QuoteTable({ quote }: { quote: StoredQuote }) {
  const cur = quote.currency;
  const demo = isDemoVersion(quote.pricingRuleVersion);
  const money = (major: number) => formatMoney(Math.round(major * 100), cur);
  return (
    <div className="space-y-4">
      {demo ? (
        <Notice tone="warning" title="Demo rates">
          <p>
            This quote uses demonstration rates that have not been verified or approved by the business. It is not an
            approved price.
          </p>
        </Notice>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
          <caption className="sr-only">Itemized quote in {cur}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-3 font-semibold">Item</th>
              <th scope="col" className="px-4 py-3 font-semibold">Quantity</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Rate</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((l) => (
              <tr key={l.key} className="border-b border-border last:border-0">
                <th scope="row" className="px-4 py-3 font-normal">
                  {l.label}
                  {l.includedQuantity > 0 ? (
                    <span className="block text-muted">{l.includedQuantity} included</span>
                  ) : null}
                </th>
                <td className="px-4 py-3">
                  {l.quantity} × {l.unit}
                </td>
                <td className="px-4 py-3 text-right">{formatMoney(l.rateMinor, cur)}</td>
                <td className="px-4 py-3 text-right">{formatMoney(l.amountMinor, cur)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border">
              <th scope="row" colSpan={3} className="px-4 py-2 text-right font-normal">Subtotal</th>
              <td className="px-4 py-2 text-right">{money(quote.subtotal)}</td>
            </tr>
            <tr>
              <th scope="row" colSpan={3} className="px-4 py-2 text-right font-normal">Taxes and fees</th>
              <td className="px-4 py-2 text-right">{money(quote.taxAmount)}</td>
            </tr>
            {quote.discountAmount > 0 ? (
              <tr>
                <th scope="row" colSpan={3} className="px-4 py-2 text-right font-normal">Discount</th>
                <td className="px-4 py-2 text-right">-{money(quote.discountAmount)}</td>
              </tr>
            ) : null}
            <tr className="border-t border-border text-base font-semibold">
              <th scope="row" colSpan={3} className="px-4 py-3 text-right">Total ({cur})</th>
              <td className="px-4 py-3 text-right">{money(quote.totalAmount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-sm text-muted">
        {quote.validUntil ? `Valid until ${dateFormat.format(new Date(quote.validUntil))}. ` : ""}
        Calculated on the server from the pricing version <span className="break-all">{quote.pricingRuleVersion}</span>.
        Once accepted, this quote is saved as it is shown and later rate changes do not alter it.
      </p>
    </div>
  );
}
