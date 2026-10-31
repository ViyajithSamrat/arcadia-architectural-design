import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { buttonSecondary, card } from "@/components/journey/styles";
import { RejectForm, VerifyForm } from "@/components/payments/decision-forms";
import { getAdminAccess } from "@/lib/admin/access";
import { formatMoney, toMinor } from "@/lib/journeys/money";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { createProofPreviewUrl, getPaymentForAdmin, PROOF_URL_SECONDS } from "@/lib/payments/service";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { isMockGatewayReference } from "@/lib/payments/mock-gateway";

export const metadata: Metadata = { title: "Review payment", robots: { index: false, follow: false } };

type Props = { params: Promise<{ paymentId: string }>; searchParams: Promise<{ decided?: string }> };

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

async function Detail({ params, searchParams }: Props) {
  const { paymentId } = await params;
  const { decided } = await searchParams;
  const access = await getAdminAccess();
  if (access.state === "forbidden") {
    return (
      <Notice tone="danger" title="You do not have access to this area">
        <p>This area is for administrators.</p>
      </Notice>
    );
  }
  if (access.state !== "ok") return <AccessGate access={access} />;

  // The trusted client is used only here, after the role check, to read the two columns
  // (verified_by, audit_note) that no session role may select.
  const payment = await getPaymentForAdmin(access.supabase, createSupabaseServiceClient(), paymentId);
  if (!payment) notFound();
  const proofUrl = await createProofPreviewUrl(access.supabase, payment);

  const money = (n: number) => formatMoney(toMinor(n), payment.currency);
  const type = payment.projectType in JOURNEYS ? JOURNEYS[payment.projectType as keyof typeof JOURNEYS].title : "Project";
  const pending = payment.status === "PENDING_REVIEW";

  return (
    <>
      <p>
        <Link href="/admin/payments" className={buttonSecondary}>
          Back to the queue
        </Link>
      </p>
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-medium tracking-tight">Review payment</h1>
        <p className="text-muted">
          {type} · customer {payment.customerId.slice(0, 8)} · submitted {dateTime.format(new Date(payment.createdAt))}
        </p>
      </header>

      {decided === "1" && !pending ? (
        <Notice tone="success" role="status" title={payment.status === "VERIFIED" ? "Payment verified" : "Payment rejected"}>
          <p>The decision has been recorded in the audit trail.</p>
        </Notice>
      ) : null}

      <section aria-labelledby="claim-title" className={`${card} space-y-3`}>
        <h2 id="claim-title" className="text-xl font-semibold">
          What the customer claims
        </h2>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted">Claimed amount</dt>
            <dd>{money(payment.amountClaimed)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Accepted quote total</dt>
            <dd>{payment.quoteTotal === null ? "Unknown" : money(payment.quoteTotal)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Method</dt>
            <dd>{payment.method === "UPI" ? "UPI" : "Net banking"}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Reference (UTR)</dt>
            <dd className="font-mono">{payment.utrReference}</dd>
            {isMockGatewayReference(payment.utrReference) ? (
              <dd className="mt-1 text-sm font-medium text-warning-fg">Simulated demo gateway: no money moved. Verify only for a demonstration.</dd>
            ) : null}
          </div>
          <div>
            <dt className="text-sm text-muted">Transfer date</dt>
            <dd>{payment.transferDate}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted">These are the customer&apos;s own statements. Compare them with the receiving account.</p>
      </section>

      <section aria-labelledby="proof-title" className="space-y-3">
        <h2 id="proof-title" className="text-xl font-semibold">
          Receipt image
        </h2>
        {proofUrl ? (
          <div className="space-y-2">
            {/* A short-lived signed link to a private file: next/image cannot optimise it, so it is
                lazy-loaded with a fixed box instead. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={proofUrl}
              alt="Receipt image submitted by the customer"
              width={640}
              height={480}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="h-auto max-h-[32rem] w-full max-w-xl rounded-lg border border-border bg-surface object-contain"
            />
            <p className="text-sm text-muted">This link expires after {PROOF_URL_SECONDS} seconds. Reload the page for a new one.</p>
          </div>
        ) : payment.proofPath ? (
          <Notice tone="warning" title="The image could not be loaded">
            <p>Reload the page to try again.</p>
          </Notice>
        ) : (
          <p className="text-muted">No receipt image was attached.</p>
        )}
      </section>

      {pending ? (
        <section aria-labelledby="decide-title" className="space-y-6">
          <h2 id="decide-title" className="text-xl font-semibold">
            Your decision
          </h2>
          <div className={card}>
            <VerifyForm paymentId={payment.id} totalLabel={payment.quoteTotal === null ? "unknown" : money(payment.quoteTotal)} />
          </div>
          <div className={card}>
            <RejectForm paymentId={payment.id} />
          </div>
        </section>
      ) : (
        <section aria-labelledby="decision-title" className={`${card} space-y-2`}>
          <h2 id="decision-title" className="text-xl font-semibold">
            Decision
          </h2>
          <p>
            <span className="font-medium">{payment.status === "VERIFIED" ? "Verified" : "Rejected"}</span>
            {payment.verifiedAt ? ` on ${dateTime.format(new Date(payment.verifiedAt))}` : ""}
            {payment.verifiedBy ? ` by administrator ${payment.verifiedBy.slice(0, 8)}` : ""}.
          </p>
          {payment.confirmedAmount !== null ? <p>Confirmed amount: {money(payment.confirmedAmount)}</p> : null}
          {payment.rejectionReason ? <p>Reason given to the customer: {payment.rejectionReason}</p> : null}
          {payment.auditNote ? <p>Internal note: {payment.auditNote}</p> : null}
          <p className="text-sm text-muted">A decision is final. Starting generation is a separate step that is not part of this screen.</p>
        </section>
      )}
    </>
  );
}

export default function PaymentReviewPage({ params, searchParams }: Props) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<Loading />}>
        <Detail params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
