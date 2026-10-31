import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { getAdminAccess } from "@/lib/admin/access";
import { GENERATION_MODE_NOTICE } from "@/lib/generation/copy";
import { getImageGenerationMode } from "@/lib/generation/provider";
import { listGenerationQueue, PHASE_TEXT, type GenerationPhase, type QueueRow } from "@/lib/generation/read";
import { formatMoney, toMinor } from "@/lib/journeys/money";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { isMockGatewayReference } from "@/lib/payments/mock-gateway";
import { listPaymentQueue, type QueueItem } from "@/lib/payments/service";

export const metadata: Metadata = { title: "Admin overview", robots: { index: false, follow: false } };

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** Phases grouped for the overview. Every phase belongs to at most one group. */
const ACTIVE: readonly GenerationPhase[] = ["starting", "running"];
const ATTENTION: readonly GenerationPhase[] = ["stale_job", "can_resume", "can_finalize", "blocked_leftovers"];

const typeTitle = (type: string) => (type in JOURNEYS ? JOURNEYS[type as keyof typeof JOURNEYS].title : "Project");

function Stat({ label, value, href, note }: { label: string; value: number; href: string; note: string }) {
  return (
    <Link href={href} className="group block space-y-3 border-t-2 border-foreground/80 pt-5 transition-colors hover:border-accent">
      <span className="eyebrow">{label}</span>
      <span className="block font-display text-6xl font-medium leading-none tabular">{value}</span>
      <span className="flex items-center gap-2 text-sm text-muted group-hover:text-foreground">
        {note} <span aria-hidden="true" className="gn-arrow">→</span>
      </span>
    </Link>
  );
}

function List({ id, title, empty, children, count }: { id: string; title: string; empty: string; children: React.ReactNode; count: number }) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h2 id={id} className="font-display text-3xl font-medium">
        {title}
      </h2>
      {count === 0 ? <p className="border-t border-border py-4 text-muted">{empty}</p> : <ul className="divide-y divide-border border-y border-border">{children}</ul>}
    </section>
  );
}

function ProjectRow({ row }: { row: QueueRow }) {
  const failed = row.status === "GENERATION_FAILED";
  const text = PHASE_TEXT[row.phase];
  return (
    <li>
      <Link href={`/admin/generation/${row.projectId}`} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-4 hover:bg-surface sm:px-2">
        <span>
          <span className="font-medium underline-offset-4 hover:underline">{typeTitle(row.projectType)}</span>
          <span className="text-sm text-muted"> · customer {row.customerId.slice(0, 8)}</span>
          <span className="block text-sm">
            {failed ? "Last attempt failed. " : ""}
            {text.label}
          </span>
        </span>
        <span className="text-sm text-muted tabular">{dateTime.format(new Date(row.updatedAt))}</span>
      </Link>
    </li>
  );
}

type Activity = { at: string; text: string; href: string };

function activityFrom(payments: QueueItem[], rows: QueueRow[]): Activity[] {
  const items: Activity[] = [];
  for (const p of payments) {
    items.push({ at: p.createdAt, text: `Payment claim submitted for a ${typeTitle(p.projectType).toLowerCase()} project (${p.utrReference})`, href: `/admin/payments/${p.id}` });
    if (p.verifiedAt) {
      items.push({ at: p.verifiedAt, text: `Payment ${p.status === "VERIFIED" ? "verified" : "rejected"} (${p.utrReference})`, href: `/admin/payments/${p.id}` });
    }
  }
  for (const r of rows) {
    items.push({ at: r.updatedAt, text: `${typeTitle(r.projectType)}: ${PHASE_TEXT[r.phase].label.toLowerCase()}`, href: `/admin/generation/${r.projectId}` });
  }
  return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10);
}

async function Overview() {
  const access = await getAdminAccess();
  if (access.state === "forbidden") {
    return (
      <Notice tone="danger" title="You do not have access to this area">
        <p>This area is for administrators.</p>
      </Notice>
    );
  }
  if (access.state !== "ok") return <AccessGate access={access} />;

  // Both reads use the administrator's own session: row level security decides what they return.
  const [{ pending, decided }, rows] = await Promise.all([listPaymentQueue(access.supabase), listGenerationQueue(access.supabase)]);
  const active = rows.filter((r) => ACTIVE.includes(r.phase));
  const failed = rows.filter((r) => ATTENTION.includes(r.phase) || (r.phase === "can_start" && r.status === "GENERATION_FAILED"));
  const ready = rows.filter((r) => r.phase === "can_start" && r.status === "PAYMENT_VERIFIED");
  const review = rows.filter((r) => r.phase === "ready_for_review");
  const activity = activityFrom([...pending, ...decided], rows);
  const mode = GENERATION_MODE_NOTICE[getImageGenerationMode()];

  return (
    <div className="space-y-16">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="space-y-3">
          <h1 className="font-display">Studio overview</h1>
          <p className="max-w-2xl text-muted">
            What needs a person now: payment claims to check, generation that stopped, and images waiting for release.
          </p>
        </div>
        <p className="rounded-[3px] border border-border-strong bg-paper px-3 py-2 text-sm">
          <span className="font-semibold">Image generation:</span> {mode.title}
        </p>
      </header>

      <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pending payments" value={pending.length} href="/admin/payments" note="Review claims" />
        <Stat label="Generating now" value={active.length} href="/admin/generation" note="Open the queue" />
        <Stat label="Failed or interrupted" value={failed.length} href="/admin/generation" note="Resolve" />
        <Stat label="Awaiting release" value={review.length} href="/admin/generation" note="Review images" />
      </div>
      <p className="-mt-8 text-xs text-muted">
        Counts cover up to 100 pending payment claims and the 50 most recently updated paid projects.
        {ready.length > 0 ? ` ${ready.length} verified ${ready.length === 1 ? "project is" : "projects are"} ready to generate.` : ""}
      </p>

      <div className="grid gap-14 lg:grid-cols-2">
        <List id="pending-title" title="Payments to review" empty="No payment claims are waiting." count={pending.length}>
          {pending.slice(0, 6).map((p) => (
            <li key={p.id}>
              <Link href={`/admin/payments/${p.id}`} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-4 hover:bg-surface sm:px-2">
                <span>
                  <span className="font-medium underline-offset-4 hover:underline">{typeTitle(p.projectType)}</span>
                  <span className="text-sm text-muted"> · {p.utrReference}</span>
                  {isMockGatewayReference(p.utrReference) ? (
                    <span className="ml-2 rounded-[3px] bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning-fg">Simulated gateway</span>
                  ) : null}
                  <span className="block text-sm text-muted">Submitted {dateTime.format(new Date(p.createdAt))}</span>
                </span>
                <span className="font-medium tabular">{formatMoney(toMinor(p.amountClaimed), p.currency)}</span>
              </Link>
            </li>
          ))}
        </List>

        <List id="attention-title" title="Failed or interrupted generation" empty="Nothing has failed or stalled." count={failed.length}>
          {failed.slice(0, 6).map((r) => (
            <ProjectRow key={r.projectId} row={r} />
          ))}
        </List>

        <List id="review-title" title="Awaiting release" empty="No images are waiting for review." count={review.length}>
          {review.slice(0, 6).map((r) => (
            <ProjectRow key={r.projectId} row={r} />
          ))}
        </List>

        <List id="activity-title" title="Recent activity" empty="No recent activity." count={activity.length}>
          {activity.map((a, i) => (
            <li key={`${a.href}-${a.at}-${i}`}>
              <Link href={a.href} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3.5 hover:bg-surface sm:px-2">
                <span className="text-sm">{a.text}</span>
                <span className="text-xs text-muted tabular">{dateTime.format(new Date(a.at))}</span>
              </Link>
            </li>
          ))}
        </List>
      </div>
    </div>
  );
}

export default function AdminOverviewPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Overview />
    </Suspense>
  );
}
