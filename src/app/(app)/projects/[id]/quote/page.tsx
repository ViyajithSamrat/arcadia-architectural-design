import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { AcceptQuoteButton, CreateQuoteButton } from "@/components/journey/journey-actions";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { QuoteTable } from "@/components/journey/quote-table";
import { buttonPrimary } from "@/components/journey/styles";
import { AuthError } from "@/lib/auth/errors";
import { getPageAccess } from "@/lib/journeys/access";
import { getLatestQuote, getOwnedProject, previewQuote, type QuotePreparation } from "@/lib/journeys/service";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export const metadata: Metadata = { title: "Your quote" };

type Props = { params: Promise<{ id: string }> };

/** Whether a quote can be prepared right now. Null means the server could not check. */
async function checkPricing(project: NonNullable<Awaited<ReturnType<typeof getOwnedProject>>>): Promise<QuotePreparation | null> {
  try {
    return await previewQuote(createSupabaseServiceClient(), project);
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }
}

function missingText(prep: Extract<QuotePreparation, { configured: false }>): string {
  if (prep.reason === "mixed_currency") return "The configured rates use more than one currency.";
  if (prep.reason === "no_rules") return "No rates have been configured for this kind of project.";
  return `Rates are missing for: ${prep.missingKeys.join(", ")}.`;
}

async function QuoteContent({ params }: Props) {
  const { id } = await params;
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;
  const project = await getOwnedProject(access.supabase, access.user.id, id);
  if (!project) notFound();

  const heading = (
    <header className="space-y-1">
      <h1 className="font-display text-3xl font-medium tracking-tight">Your quote</h1>
    </header>
  );

  const early = ["DRAFT", "TRANSCRIPT_READY", "BRIEF_REVIEW"].includes(project.status);
  if (early) {
    return (
      <>
        {heading}
        <Notice tone="info" title="Approve your brief first">
          <p>A quote is prepared only after you have approved the brief.</p>
        </Notice>
        <Link href={`/projects/${project.id}/brief`} className={buttonPrimary}>
          Go to your brief
        </Link>
      </>
    );
  }

  if (project.status === "BRIEF_APPROVED") {
    const prep = await checkPricing(project);
    return (
      <>
        {heading}
        {prep === null ? (
          <Notice tone="warning" title="Quotes are not available yet">
            <p>The server could not load the pricing settings. Nothing has been charged or committed.</p>
          </Notice>
        ) : prep.configured ? (
          <Notice tone="info" title="Ready to prepare your quote">
            <p>
              The quote is calculated on the server from the configured rates and your approved brief. You can review it
              before accepting.
            </p>
          </Notice>
        ) : (
          <Notice tone="warning" title="Pricing not configured">
            <p>A quote cannot be prepared until the business has configured its rates. {missingText(prep)}</p>
          </Notice>
        )}
        <CreateQuoteButton projectId={project.id} disabled={!prep || !prep.configured} />
      </>
    );
  }

  const quote = await getLatestQuote(access.supabase, project.id);
  if (!quote) {
    return (
      <>
        {heading}
        <Notice tone="warning" title="No quote found">
          <p>This project does not have a readable quote.</p>
        </Notice>
      </>
    );
  }

  if (project.status === "QUOTED") {
    return (
      <>
        {heading}
        <QuoteTable quote={quote} />
        <Notice tone="info" title="Before you accept">
          <p>
            Accepting confirms these items and amounts. Payment instructions will be available in the next phase of this
            prototype; nothing is due now.
          </p>
        </Notice>
        <AcceptQuoteButton projectId={project.id} quoteId={quote.id} />
      </>
    );
  }

  return (
    <>
      {heading}
      <Notice tone="success" title="Quote accepted">
        <p>You accepted this quote. It is saved exactly as shown below.</p>
      </Notice>
      <QuoteTable quote={quote} />
      {project.status === "AWAITING_PAYMENT" ? (
        <Notice tone="warning" title="Payment instructions are not available yet">
          <p>
            Payment instructions will be available in the next phase of this prototype. Do not transfer any money yet.
            Nothing here has been paid or verified.
          </p>
        </Notice>
      ) : null}
      <Link href={`/projects/${project.id}`} className={buttonPrimary}>
        Back to project
      </Link>
    </>
  );
}

export default function QuotePage({ params }: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <QuoteContent params={params} />
    </Suspense>
  );
}
