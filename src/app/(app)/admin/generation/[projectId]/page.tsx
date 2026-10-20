import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ClearStaleJobForm, ReleaseForm, StartGenerationForm } from "@/components/generation/controls";
import { ImageGallery, MockWarning } from "@/components/generation/image-gallery";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { buttonSecondary, card } from "@/components/journey/styles";
import { getAdminAccess } from "@/lib/admin/access";
import { getGenerationDetail, PHASE_TEXT, PREVIEW_URL_SECONDS, type GenerationDetail, type JobView } from "@/lib/generation/read";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { STATUS_INFO } from "@/lib/journeys/status";

export const metadata: Metadata = { title: "Generate and release", robots: { index: false, follow: false } };

type Props = { params: Promise<{ projectId: string }>; searchParams: Promise<{ started?: string; released?: string; cleared?: string }> };

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

function Job({ job }: { job: JobView }) {
  return (
    <li className={`${card} space-y-1`}>
      <p className="font-medium">
        {job.status === "SUCCEEDED" ? "Succeeded" : job.status === "FAILED" ? "Failed" : job.status === "RUNNING" ? "Running" : "Queued"} · {job.mock ? "mock test generator" : job.provider}
      </p>
      <p className="text-sm text-muted">
        Started {dateTime.format(new Date(job.startedAt ?? job.createdAt))} · prompt {job.promptVersion} · attempts {job.attemptCount}
        {job.durationMs !== null ? ` · ${(job.durationMs / 1000).toFixed(1)} s` : ""}
      </p>
      {job.status === "FAILED" ? (
        <p className="text-sm">
          {job.errorSummary ?? "The attempt failed."}
          {job.errorCode ? <span className="font-mono text-muted"> ({job.errorCode})</span> : null}
        </p>
      ) : null}
    </li>
  );
}

function Actions({ detail }: { detail: GenerationDetail }) {
  const id = detail.projectId;
  switch (detail.phase) {
    case "can_start":
      return <StartGenerationForm projectId={id} mode={detail.status === "GENERATION_FAILED" ? "retry" : "start"} />;
    case "can_resume":
      return <StartGenerationForm projectId={id} mode="resume" />;
    case "can_finalize":
      return <StartGenerationForm projectId={id} mode="finish" />;
    case "blocked_leftovers":
      return (
        <Notice tone="warning" title="A new run is blocked">
          <p>Generated files from an earlier attempt are still attached to this project. Releasing or generating again could publish them, so both are refused until they are removed. This screen cannot remove them; ask a developer to clear them.</p>
        </Notice>
      );
    case "starting":
    case "running":
      return (
        <Notice tone="info" role="status" title="Generation is in progress">
          <p>Reload this page in a moment to see the result. If nothing changes for ten minutes, the job is treated as interrupted and can be cleared.</p>
        </Notice>
      );
    case "stale_job":
      return (
        <div className="space-y-3">
          <Notice tone="warning" title="This job made no progress for over ten minutes">
            <p>The request that was running it probably stopped. Clearing it marks the job failed so generation can be tried again. Nothing is released.</p>
          </Notice>
          <ClearStaleJobForm projectId={id} />
        </div>
      );
    case "ready_for_review":
      return detail.releaseBlockers.length > 0 ? (
        <Notice tone="danger" title="Release is blocked">
          <ul className="list-disc pl-5">
            {detail.releaseBlockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        <ReleaseForm projectId={id} assetCount={detail.previews.length} mock={detail.mock} />
      );
    case "released":
      return <p>These images have been released to the customer.</p>;
    default:
      return <p className="text-muted">{PHASE_TEXT.not_ready.detail}</p>;
  }
}

async function Detail({ params, searchParams }: Props) {
  const { projectId } = await params;
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

  const detail = await getGenerationDetail(access.supabase, projectId);
  if (!detail) notFound();

  const type = detail.projectType in JOURNEYS ? JOURNEYS[detail.projectType].title : "Project";
  const phase = PHASE_TEXT[detail.phase];
  const showImages = detail.status === "READY_FOR_REVIEW" || detail.status === "RELEASED";

  return (
    <>
      <p>
        <Link href="/admin/generation" className={buttonSecondary}>
          Back to the generation queue
        </Link>
      </p>
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-medium tracking-tight">Generate and release</h1>
        <p className="text-muted">
          {type} · customer {detail.customerId.slice(0, 8)} · project status: {STATUS_INFO[detail.status].label}
        </p>
        <p>
          <span className="font-medium">{phase.label}.</span> {phase.detail}
        </p>
      </header>

      {/* A confirmation is shown only when the stored state agrees with it. */}
      {flags.started === "1" && (detail.status === "READY_FOR_REVIEW" || detail.status === "RELEASED") ? (
        <Notice tone="success" role="status" title="Images created">
          <p>They are private and have not been released.</p>
        </Notice>
      ) : null}
      {flags.released === "1" && detail.status === "RELEASED" ? (
        <Notice tone="success" role="status" title="Released">
          <p>The customer can now see these images. The release is recorded in the audit trail.</p>
        </Notice>
      ) : null}
      {flags.cleared === "1" && detail.status === "GENERATION_FAILED" ? (
        <Notice tone="success" role="status" title="Interrupted job cleared">
          <p>Generation can be tried again. Nothing was released.</p>
        </Notice>
      ) : null}

      {detail.mock && showImages ? <MockWarning /> : null}

      {showImages ? (
        <section aria-labelledby="images-title" className="space-y-3">
          <h2 id="images-title" className="text-xl font-semibold">
            Images ({detail.previews.length})
          </h2>
          <ImageGallery images={detail.previews} caption="Generated images for review" />
          <p className="text-sm text-muted">
            {detail.status === "RELEASED" ? "These links are for administrators and expire" : "Only administrators can see these until they are released. Links expire"} after {PREVIEW_URL_SECONDS} seconds; reload for new ones.
          </p>
          {detail.leftoverCount > 0 ? (
            <Notice tone="danger" title={`${detail.leftoverCount} file${detail.leftoverCount === 1 ? "" : "s"} from a failed attempt ${detail.leftoverCount === 1 ? "is" : "are"} still attached`}>
              <p>They are not shown here and will not be released while they remain.</p>
            </Notice>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="action-title" className={`${card} space-y-3`}>
        <h2 id="action-title" className="text-xl font-semibold">
          {detail.phase === "ready_for_review" ? "Release" : "Next step"}
        </h2>
        <Actions detail={detail} />
      </section>

      <section aria-labelledby="jobs-title" className="space-y-3">
        <h2 id="jobs-title" className="text-xl font-semibold">
          Attempts ({detail.jobs.length})
        </h2>
        {detail.jobs.length === 0 ? <p className="text-muted">Nothing has been generated for this project yet.</p> : <ul className="space-y-3">{detail.jobs.map((j) => <Job key={j.id} job={j} />)}</ul>}
      </section>
    </>
  );
}

export default function GenerationDetailPage({ params, searchParams }: Props) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<Loading />}>
        <Detail params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
