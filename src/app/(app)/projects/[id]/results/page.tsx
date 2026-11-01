import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ConceptViewer } from "@/components/generation/concept-viewer";
import { GenerationWatcher } from "@/components/generation/generation-watcher";
import { FloorPlanSketch } from "@/components/generation/floor-plan";
import { ConceptDisclaimer, CustomerMockWarning } from "@/components/generation/image-gallery";
import { ResultsStatus } from "@/components/generation/results-status";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { ProjectHeader } from "@/components/journey/project-header";
import { getCustomerResults, getReleasedImageProvenance, RESULT_URL_SECONDS } from "@/lib/generation/read";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { getPageAccess } from "@/lib/journeys/access";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { getOwnedProject } from "@/lib/journeys/service";

export const metadata: Metadata = { title: "Your concepts", robots: { index: false, follow: false } };

type Props = { params: Promise<{ id: string }> };

/** The opening of the approved brief, cut at a sentence end: the concept's own description. */
function briefExcerpt(text: string | null | undefined, max = 360): string | null {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

async function Results({ params }: Props) {
  const { id } = await params;
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;

  // Both reads are the owner's own: getCustomerResults decides what may be seen; the project gives the title.
  const [results, project] = await Promise.all([getCustomerResults(access.supabase, access.user.id, id), getOwnedProject(access.supabase, access.user.id, id)]);
  if (results.state === "not_found" || !project) notFound();
  const journey = JOURNEYS[project.project_type];

  if (results.state === "pending") {
    return (
      <>
        <ProjectHeader projectId={id} kind={journey.title} title="Your concepts" />
        <GenerationWatcher projectId={id} status={results.status} />
        <ResultsStatus projectId={id} status={results.status} />
      </>
    );
  }

  const excerpt = briefExcerpt(project.english_brief_text);
  let service = null;
  try {
    service = createSupabaseServiceClient();
  } catch {
    service = null; // Not configured: provenance stays unknown and the neutral wording is shown.
  }
  const provenance = await getReleasedImageProvenance(access.supabase, service, access.user.id, id);
  const visible = new Set(results.assets.map((a) => a.id));
  const mockIds = provenance.state === "known" ? provenance.mockAssetIds.filter((m) => visible.has(m)) : null;
  return (
    <>
      <ProjectHeader projectId={id} kind="Your concepts" title={journey.title} />

      {results.assets.length === 0 ? (
        <Notice tone="warning" title="Your images could not be loaded">
          <p>Reload the page to try again. If this keeps happening, contact us.</p>
        </Notice>
      ) : (
        <section aria-labelledby="images-title" className="gn-wide space-y-6">
          <h2 id="images-title" className="sr-only">
            Images ({results.assets.length})
          </h2>
          {mockIds && mockIds.length > 0 ? <CustomerMockWarning count={mockIds.length} total={results.assets.length} /> : null}
          <ConceptViewer images={results.assets} mockIds={mockIds} />
          <p className="text-sm text-muted">
            These links expire after {Math.round(RESULT_URL_SECONDS / 60)} minutes. Reload the page for new ones.
            {results.unavailable > 0 ? ` ${results.unavailable} ${results.unavailable === 1 ? "image" : "images"} could not be loaded. Reload to try again.` : ""}
          </p>
        </section>
      )}

      <section aria-labelledby="concept-title" className="grid gap-8 border-t border-border-strong pt-10 md:grid-cols-12">
        <div className="space-y-2 md:col-span-4">
          <p className="eyebrow">The concept</p>
          <h2 id="concept-title" className="font-display text-3xl font-medium leading-tight">
            From your approved brief
          </h2>
        </div>
        <div className="space-y-4 md:col-span-8">
          {excerpt ? <p className="font-display text-2xl leading-snug">{excerpt}</p> : <p className="text-muted">Your brief is on the brief page.</p>}
          <p>
            <Link href={`/projects/${id}/brief`} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold underline-offset-4 hover:underline">
              Read the full brief <span aria-hidden="true" className="gn-arrow">→</span>
            </Link>
          </p>
        </div>
      </section>

      <ConceptDisclaimer allAi={mockIds !== null && mockIds.length === 0 && results.assets.length > 0} />
      {results.floorPlan ? (
        <div className="space-y-4 border-t border-border-strong pt-10">
          <p className="eyebrow">Separate from the AI concepts above</p>
          <FloorPlanSketch plan={results.floorPlan} audience="customer" downloadProjectId={id} />
        </div>
      ) : null}
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
