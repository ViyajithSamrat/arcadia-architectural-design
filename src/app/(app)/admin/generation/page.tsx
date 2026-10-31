import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { card } from "@/components/journey/styles";
import { getAdminAccess } from "@/lib/admin/access";
import { GENERATION_MODE_NOTICE } from "@/lib/generation/copy";
import { getImageGenerationMode, type ImageGenerationMode } from "@/lib/generation/provider";
import { listGenerationQueue, PHASE_TEXT, type QueueRow } from "@/lib/generation/read";
import { JOURNEYS } from "@/lib/journeys/project-types";

export const metadata: Metadata = { title: "Image generation", robots: { index: false, follow: false } };

const MODE_TONE: Record<ImageGenerationMode, "info" | "warning" | "danger"> = { mock: "info", live: "warning", live_unavailable: "danger" };

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

function Row({ item }: { item: QueueRow }) {
  const type = item.projectType in JOURNEYS ? JOURNEYS[item.projectType].title : "Project";
  const text = PHASE_TEXT[item.phase];
  return (
    <li className={`${card} space-y-1`}>
      <p className="font-medium">
        <Link href={`/admin/generation/${item.projectId}`} className="underline underline-offset-4">
          {type} · customer {item.customerId.slice(0, 8)}
        </Link>
      </p>
      <p className="text-sm">
        <span className="font-medium">{text.label}.</span> {text.detail}
      </p>
      <p className="text-sm text-muted">
        {item.jobCount} {item.jobCount === 1 ? "attempt" : "attempts"} · {item.assetCount} generated {item.assetCount === 1 ? "file" : "files"} · updated {dateTime.format(new Date(item.updatedAt))}
      </p>
    </li>
  );
}

function Section({ id, title, empty, rows }: { id: string; title: string; empty: string; rows: QueueRow[] }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-xl font-semibold">
        {title} ({rows.length})
      </h2>
      {rows.length === 0 ? <p className="text-muted">{empty}</p> : <ul className="space-y-3">{rows.map((r) => <Row key={r.projectId} item={r} />)}</ul>}
    </section>
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
  const rows = await listGenerationQueue(access.supabase);
  const by = (...phases: QueueRow["phase"][]) => rows.filter((r) => phases.includes(r.phase));
  // Read after the access check, so it is this server's setting at request time (never one baked in at build).
  const mode = getImageGenerationMode();
  const modeNotice = GENERATION_MODE_NOTICE[mode];
  return (
    <>
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-medium tracking-tight">Image generation</h1>
        <p className="text-muted">
          Projects whose payment an administrator has verified. Generation never releases anything: a person reviews the images and releases them.
        </p>
        <p>
          <Link href="/admin/payments" className="underline underline-offset-4">
            Payments to review
          </Link>
          {" · "}
          <Link href="/admin/pricing" className="underline underline-offset-4">
            Pricing
          </Link>
        </p>
      </header>
      <Notice tone={MODE_TONE[mode]} title={modeNotice.title}>
        <p>{modeNotice.body}</p>
      </Notice>
      <Section id="ready-title" title="Ready to generate" empty="No project is waiting to be generated." rows={by("can_start", "blocked_leftovers")} />
      <Section id="attention-title" title="In progress or needs attention" empty="Nothing is running or interrupted." rows={by("starting", "can_resume", "running", "stale_job", "can_finalize")} />
      <Section id="review-title" title="Awaiting release" empty="No images are waiting for release." rows={by("ready_for_review")} />
      <Section id="released-title" title="Released" empty="Nothing has been released yet." rows={by("released")} />
    </>
  );
}

export default function GenerationQueuePage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<Loading />}>
        <Queue />
      </Suspense>
    </div>
  );
}
