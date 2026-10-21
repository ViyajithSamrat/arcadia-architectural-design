import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { card } from "@/components/journey/styles";
import { RuleForm } from "@/components/pricing/rule-form";
import { getAdminAccess } from "@/lib/admin/access";
import { formatMoney, toMinor } from "@/lib/journeys/money";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { getPricingOverview, type PricingRow } from "@/lib/pricing/admin";

export const metadata: Metadata = { title: "Pricing", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ published?: string }> };

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

function describe(row: PricingRow): string {
  const r = row.current;
  if (!r) return "Not priced yet";
  if (row.isTax) return `${r.rate}% (${r.currency})`;
  const parts = [`${formatMoney(toMinor(r.rate), r.currency)} per ${r.unit}`];
  if (r.includedQuantity > 0) parts.push(`first ${r.includedQuantity} included`);
  if (r.minimumCharge > 0) parts.push(`minimum ${formatMoney(toMinor(r.minimumCharge), r.currency)}`);
  return parts.join(" · ");
}

async function Pricing({ searchParams }: Props) {
  const flags = await searchParams;
  const access = await getAdminAccess();
  if (access.state === "forbidden") {
    return (
      <Notice tone="danger" title="You do not have access to this area">
        <p>This area is for administrators.</p>
      </Notice>
    );
  }
  if (access.state !== "ok") return <AccessGate access={access} />;

  const overview = await getPricingOverview(access.supabase);
  if (!overview) {
    return (
      <Notice tone="danger" title="Pricing could not be loaded">
        <p>Reload the page to try again. Nothing was changed.</p>
      </Notice>
    );
  }

  return (
    <>
      {flags.published === "1" ? (
        <Notice tone="success" role="status" title="New version published">
          <p>The table below shows the values now in force. New quotes use them; accepted quotes are unchanged. The change is recorded in the audit trail.</p>
        </Notice>
      ) : null}

      {overview.demoRates ? (
        <Notice tone="warning" title="Quotes are labelled “Demo rates”">
          <p>The pricing mode is set to demo, so every quote says its rates are for demonstration only. Switching to real rates is a decision for the project owner and is not made from this screen.</p>
        </Notice>
      ) : (
        <Notice tone="info" title="Quotes are not labelled as demo rates">
          <p>Quotes show these rates without a demo label.</p>
        </Notice>
      )}

      <Notice tone="info" title="What this screen changes">
        <p>
          Publishing creates a new version of one rate, in force immediately. Earlier versions stay in the history and accepted quotes keep the rates they were accepted with. Discounts and the payment instructions are not set here: payment instructions come
          from protected server configuration.
        </p>
      </Notice>

      {overview.types.map((view) => (
        <section key={view.type} aria-labelledby={`${view.type}-title`} className="space-y-3">
          <h2 id={`${view.type}-title`} className="text-xl font-semibold">
            {JOURNEYS[view.type].title}
            {view.currency ? <span className="text-base font-normal text-muted"> · {view.currency}</span> : null}
          </h2>
          {view.mixedCurrency ? (
            <Notice tone="danger" title="These rates use more than one currency">
              <p>Quotes for this project type cannot be calculated until every rate uses the same currency.</p>
            </Notice>
          ) : null}
          {view.missing.length > 0 ? (
            <Notice tone="warning" title="Some rates are not priced yet">
              <p>Not priced: {view.missing.join(", ")}. A quote that needs one of these shows “Pricing not configured” until it is published.</p>
            </Notice>
          ) : null}
          <ul className="space-y-3">
            {view.rows.map((row) => (
              <li key={row.key} className={`${card} space-y-2`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{row.label}</p>
                  <p className="text-sm text-muted">
                    {row.current ? `Version ${row.current.version} since ${dateTime.format(new Date(row.current.effectiveFrom))}` : "No version in force"}
                    {row.versions > 1 ? ` · ${row.versions} versions in total` : ""}
                  </p>
                </div>
                <p>{describe(row)}</p>
                <details>
                  <summary className="cursor-pointer text-sm font-medium underline">Publish a new version</summary>
                  <div className="pt-3">
                    <RuleForm
                      projectType={view.type}
                      ruleKey={row.key}
                      isTax={row.isTax}
                      defaults={{
                        rate: row.current ? String(row.current.rate) : "",
                        unit: row.current?.unit ?? "",
                        minimumCharge: row.current ? String(row.current.minimumCharge) : "0",
                        includedQuantity: row.current ? String(row.current.includedQuantity) : "0",
                        currency: row.current?.currency ?? view.currency ?? "",
                      }}
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

export default function PricingPage({ searchParams }: Props) {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-medium tracking-tight">Pricing</h1>
        <p className="text-muted">The rates the server uses to calculate quotes. Only administrators can see or change them.</p>
        <p className="flex flex-wrap gap-4">
          <Link href="/admin/payments" className="underline underline-offset-4">
            Payments to review
          </Link>
          <Link href="/admin/generation" className="underline underline-offset-4">
            Image generation
          </Link>
        </p>
      </header>
      <Suspense fallback={<Loading />}>
        <Pricing searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
