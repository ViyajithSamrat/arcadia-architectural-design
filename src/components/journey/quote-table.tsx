import { formatMoney } from "@/lib/journeys/money";
import { DEMO_QUOTE_LABEL, isDemoVersion } from "@/lib/journeys/quote";
import type { StoredQuote } from "@/lib/journeys/service";
import { Notice } from "./notice";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });


/** The itemized quote exactly as stored. Amounts come from the frozen snapshot, never recalculated here. */
export function QuoteTable({ quote }: { quote: StoredQuote }) {
  const cur = quote.currency;
  const demo = isDemoVersion(quote.pricingRuleVersion);
  const money = (major: number) => formatMoney(Math.round(major * 100), cur);
  return (
    <div className="space-y-5">
      {demo ? (
        <Notice tone="warning" title={DEMO_QUOTE_LABEL}>
          <p>
            This quote uses demonstration rates that have not been verified or approved by the business. It is not an
            approved price.
          </p>
        </Notice>
      ) : null}
      <div className="overflow-hidden rounded-[4px] border border-border bg-paper shadow-soft print:shadow-none">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border px-6 py-5 sm:px-8">
          <p className="font-display text-2xl font-medium">Quotation</p>
          {demo ? <p className="w-full text-xs font-bold uppercase tracking-[0.16em] text-warning-fg">{DEMO_QUOTE_LABEL}</p> : null}
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Amounts in {cur}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
            <caption className="sr-only">Itemized quote in {cur}</caption>
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-[0.12em] text-muted">
                <th scope="col" className="px-6 py-3 font-semibold sm:pl-8">Item</th>
                <th scope="col" className="px-4 py-3 font-semibold">Quantity</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Rate</th>
                <th scope="col" className="px-6 py-3 text-right font-semibold sm:pr-8">Amount</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map((l) => (
                <tr key={l.key} className="border-b border-border/70 last:border-0">
                  <th scope="row" className="px-6 py-4 align-top font-medium sm:pl-8">
                    {l.label}
                    {l.includedQuantity > 0 ? (
                      <span className="block font-normal text-muted">{l.includedQuantity} included</span>
                    ) : null}
                  </th>
                  <td className="px-4 py-4 align-top text-muted">
                    {l.quantity} × {l.unit}
                  </td>
                  <td className="px-4 py-4 text-right align-top text-muted">{formatMoney(l.rateMinor, cur)}</td>
                  <td className="px-6 py-4 text-right align-top font-medium sm:pr-8">{formatMoney(l.amountMinor, cur)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-surface">
              <tr className="border-t border-border">
                <th scope="row" colSpan={3} className="px-6 pb-1 pt-4 text-right font-normal text-muted sm:pl-8">Subtotal</th>
                <td className="px-6 pb-1 pt-4 text-right sm:pr-8">{money(quote.subtotal)}</td>
              </tr>
              <tr>
                <th scope="row" colSpan={3} className="px-6 py-1 text-right font-normal text-muted sm:pl-8">Taxes and fees</th>
                <td className="px-6 py-1 text-right sm:pr-8">{money(quote.taxAmount)}</td>
              </tr>
              {quote.discountAmount > 0 ? (
                <tr>
                  <th scope="row" colSpan={3} className="px-6 py-1 text-right font-normal text-muted sm:pl-8">Discount</th>
                  <td className="px-6 py-1 text-right sm:pr-8">-{money(quote.discountAmount)}</td>
                </tr>
              ) : null}
              <tr className="border-t border-border-strong">
                <th scope="row" colSpan={3} className="px-6 py-5 text-right text-base font-semibold sm:pl-8">Total ({cur})</th>
                <td className="px-6 py-5 text-right font-display text-3xl font-semibold leading-none sm:pr-8">{money(quote.totalAmount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p className="text-sm text-muted">
        {quote.validUntil ? `Valid until ${dateFormat.format(new Date(quote.validUntil))}. ` : ""}
        Calculated on the server from the pricing version <span className="break-all">{quote.pricingRuleVersion}</span>.
        Once accepted, this quote is saved as it is shown and later rate changes do not alter it.
      </p>
    </div>
  );
}
