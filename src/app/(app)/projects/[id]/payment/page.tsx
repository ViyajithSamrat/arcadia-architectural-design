import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { ProjectHeader } from "@/components/journey/project-header";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { buttonPrimary, buttonSecondary, card } from "@/components/journey/styles";
import { MockCheckout } from "@/components/payments/mock-checkout";
import { PaymentForm } from "@/components/payments/payment-form";
import { getPageAccess } from "@/lib/journeys/access";
import { formatMoney, minorToDecimal, toMinor } from "@/lib/journeys/money";
import { getLatestQuote, getOwnedProject } from "@/lib/journeys/service";
import { getPaymentDisplay, PAYMENT_NOT_CONFIGURED, type PaymentDisplay } from "@/lib/payments/config";
import { isMockGatewayEnabled, isMockGatewayReference } from "@/lib/payments/mock-gateway";
import { listOwnPayments, type CustomerPayment } from "@/lib/payments/service";

export const metadata: Metadata = { title: "Payment" };

type Props = { params: Promise<{ id: string }> };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const day = (iso: string) => dateFormat.format(new Date(iso));
const STATUS_WORDS = { PENDING_REVIEW: "Pending review", VERIFIED: "Verified by an administrator", REJECTED: "Rejected" } as const;

function Instructions({ display }: { display: Extract<PaymentDisplay, { state: "ready" }> }) {
  return (
    <section aria-labelledby="how-to-pay" className={`${card} space-y-3`}>
      <h2 id="how-to-pay" className="text-xl font-semibold">
        How to pay
      </h2>
      {display.isDemo ? (
        <Notice tone="danger" title="DEMO — DO NOT TRANSFER MONEY">
          <p>These are demonstration values. Do not send any money to them.</p>
        </Notice>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {display.accountName ? (
          <div>
            <dt className="text-sm text-muted">Pay to</dt>
            <dd>{display.accountName}</dd>
          </div>
        ) : null}
        {display.upiId ? (
          <div>
            <dt className="text-sm text-muted">UPI ID</dt>
            <dd className="font-mono">{display.upiId}</dd>
          </div>
        ) : null}
      </dl>
      {display.instructions ? <p className="whitespace-pre-line">{display.instructions}</p> : null}
      <p className="text-sm text-muted">We never ask for your password, OTP, PIN or full banking details.</p>
    </section>
  );
}

function History({ payments }: { payments: CustomerPayment[] }) {
  if (payments.length === 0) return null;
  return (
    <section aria-labelledby="history" className="space-y-3">
      <h2 id="history" className="text-xl font-semibold">
        Your submissions
      </h2>
      <ul className="space-y-3">
        {payments.map((p) => (
          <li key={p.id} className={`${card} space-y-1 text-sm`}>
            <p className="font-medium">
              {STATUS_WORDS[p.status]} · {formatMoney(Math.round(p.amountClaimed * 100), p.currency)} · {p.method === "UPI" ? "UPI" : "Net banking"}
            </p>
            <p className="text-muted">
              Reference {p.utrReference}
              {isMockGatewayReference(p.utrReference) ? " (simulated demo gateway, no money moved)" : ""} · transfer date {day(p.transferDate)} · submitted {day(p.createdAt)} ·{" "}
              {p.hasProof ? "receipt image attached" : "no receipt image"}
            </p>
            {p.status === "REJECTED" && p.rejectionReason ? (
              <p>
                <span className="font-medium">Reason given:</span> {p.rejectionReason}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

async function PaymentContent({ params }: Props) {
  const { id } = await params;
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;
  const project = await getOwnedProject(access.supabase, access.user.id, id);
  if (!project) notFound();

  const heading = <ProjectHeader projectId={project.id} kind={JOURNEYS[project.project_type].title} title="Payment" />;
  const back = (
    <p>
      <Link href={`/projects/${project.id}`} className={buttonSecondary}>
        Back to project
      </Link>
    </p>
  );

  const early = ["DRAFT", "TRANSCRIPT_READY", "BRIEF_REVIEW", "BRIEF_APPROVED", "QUOTED"].includes(project.status);
  if (early || project.status === "CANCELLED") {
    return (
      <>
        {heading}
        <Notice tone="info" title={project.status === "CANCELLED" ? "This project was cancelled" : "Payment comes after you accept a quote"}>
          <p>{project.status === "CANCELLED" ? "No payment is due." : "Payment instructions appear here once you have accepted your quote. Nothing is due yet."}</p>
        </Notice>
        {project.status === "QUOTED" ? (
          <Link href={`/projects/${project.id}/quote`} className={buttonPrimary}>
            Review your quote
          </Link>
        ) : (
          back
        )}
      </>
    );
  }

  const [quote, payments] = await Promise.all([getLatestQuote(access.supabase, project.id), listOwnPayments(access.supabase, project.id)]);
  if (!quote) {
    return (
      <>
        {heading}
        <Notice tone="warning" title="No quote found">
          <p>This project does not have a readable quote.</p>
        </Notice>
        {back}
      </>
    );
  }

  const total = formatMoney(toMinor(quote.totalAmount), quote.currency);
  const totalCard = (
    <p className="text-lg">
      <span className="font-medium">Amount due:</span> {total}{" "}
      <Link href={`/projects/${project.id}/quote`} className="text-sm underline underline-offset-4">
        View the quote
      </Link>
    </p>
  );

  // After a decision or later in the workflow: report, never promise.
  if (project.status === "PAYMENT_PROOF_SUBMITTED") {
    return (
      <>
        {heading}
        {totalCard}
        <Notice tone="warning" title="Pending review">
          <p>
            Your payment details have been received and are waiting for a person to check them against the receiving account.
            <strong> Submitting them does not mean your payment has been verified.</strong> You will see the result here.
          </p>
        </Notice>
        <History payments={payments} />
        {back}
      </>
    );
  }

  if (!["AWAITING_PAYMENT", "PAYMENT_REJECTED"].includes(project.status)) {
    const verified = payments.find((p) => p.status === "VERIFIED");
    return (
      <>
        {heading}
        {totalCard}
        <Notice tone="success" title="Payment verified">
          <p>
            An administrator checked and verified your payment
            {verified?.verifiedAt ? ` on ${day(verified.verifiedAt)}` : ""}. Your concepts are now being prepared. They stay private to your account and appear on your project page when they are ready.
          </p>
        </Notice>
        <History payments={payments} />
        {back}
      </>
    );
  }

  // AWAITING_PAYMENT or PAYMENT_REJECTED: the form, if the instructions are ready.
  const display = getPaymentDisplay(quote.currency);
  const rejected = project.status === "PAYMENT_REJECTED" ? payments.find((p) => p.status === "REJECTED") : undefined;
  return (
    <>
      {heading}
      {totalCard}
      {rejected ? (
        <Notice tone="danger" title="Your last payment details could not be confirmed">
          <p>{rejected.rejectionReason ? `Reason given: ${rejected.rejectionReason}` : "No reason was recorded."}</p>
          <p>If you have paid, check the details below and submit them again.</p>
        </Notice>
      ) : null}
      {display.state === "ready" ? (
        <>
          {isMockGatewayEnabled() ? <MockCheckout projectId={project.id} amountLabel={total} /> : null}
          <Instructions display={display} />
          <section aria-labelledby="submit-title" className="space-y-4">
            <h2 id="submit-title" className="text-xl font-semibold">
              {isMockGatewayEnabled() ? "Or submit details of a bank or UPI transfer" : "Submit your payment details"}
            </h2>
            <PaymentForm projectId={project.id} defaultAmount={minorToDecimal(toMinor(quote.totalAmount))} currency={quote.currency} />
          </section>
        </>
      ) : (
        <Notice tone="warning" title={PAYMENT_NOT_CONFIGURED}>
          <p>The business has not set up its payment instructions yet, so you cannot submit payment details. Do not transfer any money. Nothing has been paid or verified.</p>
        </Notice>
      )}
      <History payments={payments} />
      {back}
    </>
  );
}

export default function PaymentPage({ params }: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <PaymentContent params={params} />
    </Suspense>
  );
}
