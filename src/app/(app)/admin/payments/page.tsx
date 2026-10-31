import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { card } from "@/components/journey/styles";
import { getAdminAccess } from "@/lib/admin/access";
import { formatMoney, toMinor } from "@/lib/journeys/money";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { listPaymentQueue, type QueueItem } from "@/lib/payments/service";
import { isMockGatewayReference } from "@/lib/payments/mock-gateway";

export const metadata: Metadata = { title: "Payments to review", robots: { index: false, follow: false } };

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

function Row({ item }: { item: QueueItem }) {
  const type = item.projectType in JOURNEYS ? JOURNEYS[item.projectType as keyof typeof JOURNEYS].title : "Project";
  const claimed = formatMoney(toMinor(item.amountClaimed), item.currency);
  const total = item.quoteTotal === null ? "unknown" : formatMoney(toMinor(item.quoteTotal), item.currency);
  const matches = item.quoteTotal !== null && toMinor(item.quoteTotal) === toMinor(item.amountClaimed);
  return (
    <li className={`${card} space-y-1`}>
      <p className="font-medium">
        <Link href={`/admin/payments/${item.id}`} className="underline underline-offset-4">
          {type} · reference {item.utrReference}
        </Link>
        {isMockGatewayReference(item.utrReference) ? <span className="ml-2 rounded-md bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning-fg">Simulated gateway</span> : null}
      </p>
      <p className="text-sm text-muted">
        Claimed {claimed} against a quote of {total} ({matches ? "amounts match" : "amounts differ"}) · {item.method === "UPI" ? "UPI" : "Net banking"} ·{" "}
        {item.hasProof ? "receipt image attached" : "no receipt image"} · submitted {dateTime.format(new Date(item.createdAt))} · customer{" "}
        {item.customerId.slice(0, 8)}
      </p>
      {item.status !== "PENDING_REVIEW" ? (
        <p className="text-sm">{item.status === "VERIFIED" ? "Verified" : "Rejected"} {item.verifiedAt ? dateTime.format(new Date(item.verifiedAt)) : ""}</p>
      ) : null}
    </li>
  );
}

async function Queue() {
  const access = await getAdminAccess();
  if (access.state === "forbidden") {
    return (
      <Notice tone="danger" title="You do not have access to this area">
        <p>This area is for administrators.</p>
      </Notice>
    );
  }
  if (access.state !== "ok") return <AccessGate access={access} />;
  const { pending, decided } = await listPaymentQueue(access.supabase);
  return (
    <>
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-medium tracking-tight">Payments to review</h1>
        <p className="text-muted">
          A customer&apos;s submission is a claim, not proof. Verify only after you have seen the credit in the receiving account.
        </p>
        <p>
          <Link href="/admin/generation" className="underline underline-offset-4">
            Image generation
          </Link>
          {" · "}
          <Link href="/admin/pricing" className="underline underline-offset-4">
            Pricing
          </Link>
        </p>
      </header>
      <section aria-labelledby="pending-title" className="space-y-3">
        <h2 id="pending-title" className="text-xl font-semibold">
          Waiting for review ({pending.length})
        </h2>
        {pending.length === 0 ? <p className="text-muted">Nothing is waiting for review.</p> : <ul className="space-y-3">{pending.map((p) => <Row key={p.id} item={p} />)}</ul>}
      </section>
      <section aria-labelledby="decided-title" className="space-y-3">
        <h2 id="decided-title" className="text-xl font-semibold">
          Recent decisions
        </h2>
        {decided.length === 0 ? <p className="text-muted">No payments have been decided yet.</p> : <ul className="space-y-3">{decided.map((p) => <Row key={p.id} item={p} />)}</ul>}
      </section>
    </>
  );
}

export default function PaymentsAdminPage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<Loading />}>
        <Queue />
      </Suspense>
    </div>
  );
}
