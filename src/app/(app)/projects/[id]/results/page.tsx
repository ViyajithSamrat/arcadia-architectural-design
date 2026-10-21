import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FloorPlanSketch } from "@/components/generation/floor-plan";
import { ConceptDisclaimer, ImageGallery } from "@/components/generation/image-gallery";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { buttonSecondary } from "@/components/journey/styles";
import { getCustomerResults, RESULT_URL_SECONDS } from "@/lib/generation/read";
import { getPageAccess } from "@/lib/journeys/access";
import { STATUS_INFO } from "@/lib/journeys/status";

export const metadata: Metadata = { title: "Your concepts", robots: { index: false, follow: false } };

type Props = { params: Promise<{ id: string }> };

async function Results({ params }: Props) {
  const { id } = await params;
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;

  const results = await getCustomerResults(access.supabase, access.user.id, id);
  if (results.state === "not_found") notFound();

  return (
    <>
      <p>
        <Link href={`/projects/${id}`} className={buttonSecondary}>
          Back to your project
        </Link>
      </p>
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-medium tracking-tight">Your concepts</h1>
      </header>

      {results.state === "pending" ? (
        <Notice tone="info" title={STATUS_INFO[results.status].label}>
          <p>{STATUS_INFO[results.status].next}</p>
          <p>Your concept images appear here only after they have been reviewed and released to you. Nothing is available to view yet.</p>
        </Notice>
      ) : (
        <>
          <ConceptDisclaimer />
          {results.assets.length === 0 ? (
            <Notice tone="warning" title="Your images could not be loaded">
              <p>Reload the page to try again. If this keeps happening, contact us.</p>
            </Notice>
          ) : (
            <section aria-labelledby="images-title" className="space-y-3">
              <h2 id="images-title" className="text-xl font-semibold">
                Images ({results.assets.length})
              </h2>
              <ImageGallery images={results.assets} caption="Your released concept images" />
              <p className="text-sm text-muted">These links expire after {Math.round(RESULT_URL_SECONDS / 60)} minutes. Reload the page for new ones.</p>
              {results.unavailable > 0 ? <p className="text-sm text-muted">{results.unavailable} {results.unavailable === 1 ? "image" : "images"} could not be loaded. Reload to try again.</p> : null}
            </section>
          )}
          {results.floorPlan ? <FloorPlanSketch plan={results.floorPlan} audience="customer" /> : null}
        </>
      )}
    </>
  );
}

export default function ResultsPage({ params }: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <Results params={params} />
    </Suspense>
  );
}
