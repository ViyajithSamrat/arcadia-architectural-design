import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PHOTOS, type Photo } from "@/components/landing/photos";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { buttonPrimary, buttonSecondary } from "@/components/journey/styles";
import type { ProjectStatus, ProjectType } from "@/lib/db/schema";
import { getPageAccess } from "@/lib/journeys/access";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { listOwnProjects, type ProjectSummary } from "@/lib/journeys/service";
import { PROGRESS_STAGES, stageState, STATUS_INFO } from "@/lib/journeys/status";
import { countPendingPayments } from "@/lib/payments/service";

export const metadata: Metadata = { title: "My projects" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** A reference photograph per project type, used as a decorative cover. It is not the customer's project. */
const COVERS: Readonly<Record<ProjectType, { photo: Photo; kind: string }>> = {
  EMPTY_PLOT: { photo: PHOTOS.keralaHouse, kind: "New build" },
  INTERIOR: { photo: PHOTOS.jogloRoom, kind: "Interior" },
  LANDSCAPE: { photo: PHOTOS.lalbaghTree, kind: "Landscape" },
};

/** How a status reads on a card: the customer's turn, waiting on the team, finished, or stopped. */
type Tone = "yours" | "waiting" | "released" | "attention" | "closed";
const TONE: Readonly<Record<ProjectStatus, Tone>> = {
  DRAFT: "yours",
  TRANSCRIPT_READY: "yours",
  BRIEF_REVIEW: "yours",
  BRIEF_APPROVED: "yours",
  QUOTED: "yours",
  AWAITING_PAYMENT: "yours",
  PAYMENT_REJECTED: "attention",
  PAYMENT_PROOF_SUBMITTED: "waiting",
  PAYMENT_VERIFIED: "waiting",
  GENERATING: "waiting",
  GENERATION_FAILED: "waiting",
  READY_FOR_REVIEW: "waiting",
  RELEASED: "released",
  CANCELLED: "closed",
};
const TONE_TEXT: Readonly<Record<Tone, string>> = { yours: "Your turn", waiting: "With the team", released: "Ready to view", attention: "Needs your attention", closed: "Closed" };
const TONE_DOT: Readonly<Record<Tone, string>> = { yours: "bg-accent", waiting: "bg-sandstone", released: "bg-success-fg", attention: "bg-danger-fg", closed: "bg-muted" };

function StatusBadge({ status }: { status: ProjectStatus }) {
  const tone = TONE[status];
  return (
    <span className="inline-flex items-center gap-2 rounded-[3px] bg-paper/95 px-3 py-1.5 text-xs font-semibold text-foreground shadow-soft">
      <span aria-hidden="true" className={`size-2 rounded-full ${TONE_DOT[tone]}`} />
      {TONE_TEXT[tone]}
    </span>
  );
}

/** The four stages as a thin bar, with the words for screen readers. */
function StageBar({ status }: { status: ProjectStatus }) {
  const done = PROGRESS_STAGES.filter((s, i) => stageState(status, s, i) === "done").length;
  return (
    <div className="space-y-2">
      <div aria-hidden="true" className="flex gap-1.5">
        {PROGRESS_STAGES.map((s, i) => {
          const st = stageState(status, s, i);
          return <span key={s.id} className={`h-[3px] flex-1 rounded-full ${st === "done" ? "bg-accent" : st === "current" ? "bg-sandstone" : "bg-border"}`} />;
        })}
      </div>
      <p className="text-xs text-muted">
        {status === "RELEASED" ? "All stages complete" : `${done} of ${PROGRESS_STAGES.length} stages complete`}
        <span className="sr-only">: {PROGRESS_STAGES.map((s, i) => `${s.label} ${stageState(status, s, i) === "done" ? "done" : stageState(status, s, i) === "current" ? "current" : "not started"}`).join(", ")}</span>
      </p>
    </div>
  );
}

function ProjectCard({ project, feature = false }: { project: ProjectSummary; feature?: boolean }) {
  const info = STATUS_INFO[project.status];
  const cover = COVERS[project.project_type];
  const href = info.actionPath === "/results" ? `/projects/${project.id}/results` : `/projects/${project.id}`;
  return (
    <Link
      href={href}
      className={`group grid overflow-hidden rounded-[4px] border border-border bg-paper transition-shadow duration-500 hover:shadow-lift ${feature ? "md:grid-cols-12" : ""}`}
    >
      <span className={`gn-zoom relative block bg-forest ${feature ? "aspect-[4/3] md:col-span-7 md:aspect-auto md:min-h-[24rem]" : "aspect-[3/2]"}`}>
        <Image
          src={cover.photo.src}
          alt=""
          fill
          sizes={feature ? "(max-width: 768px) 100vw, 60vw" : "(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 33vw"}
          className="object-cover"
        />
        <span className="absolute left-4 top-4">
          <StatusBadge status={project.status} />
        </span>
      </span>
      <span className={`flex flex-col gap-5 p-6 sm:p-8 ${feature ? "md:col-span-5 md:justify-between md:p-10" : ""}`}>
        <span className="block space-y-3">
          <span className="eyebrow">
            {cover.kind} · <span className="tabular">#{project.id.slice(0, 6).toUpperCase()}</span>
          </span>
          <span className={`block font-display font-medium leading-tight underline-offset-4 group-hover:underline ${feature ? "text-4xl sm:text-5xl" : "text-3xl"}`}>
            {JOURNEYS[project.project_type].title}
          </span>
          <span className="block font-semibold">{info.label}</span>
          <span className={`block leading-relaxed text-muted ${feature ? "" : "text-sm"}`}>{info.next}</span>
        </span>
        <span className="block space-y-5">
          <StageBar status={project.status} />
          <span className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            <span className="text-xs text-muted">Updated {dateFormat.format(new Date(project.updated_at))}</span>
            <span className="inline-flex min-h-11 items-center gap-2 rounded-[3px] bg-accent px-5 text-sm font-semibold text-accent-contrast transition-colors duration-300 group-hover:bg-accent-soft">
              {project.status === "RELEASED" ? "View concepts" : "Continue project"} <span aria-hidden="true" className="gn-arrow">→</span>
            </span>
          </span>
        </span>
      </span>
    </Link>
  );
}

/**
 * For an administrator only: how many customer payments wait for review. This page lists the
 * projects the signed-in account created, which is where everyone lands after signing in, so
 * without this an administrator sees no sign of the customers' payments or of where to decide
 * them. Null for everyone else, and then no count is read.
 */
async function pendingPaymentsForAdmin(supabase: SupabaseClient): Promise<{ count: number | null } | null> {
  const admin = await supabase.rpc("is_admin");
  if (admin.error || admin.data !== true) return null;
  return { count: await countPendingPayments(supabase) };
}

function AdminPaymentsNotice({ count }: { count: number | null }) {
  const title =
    count === null
      ? "Customer payments are reviewed in the admin area"
      : count === 0
        ? "No customer payments are waiting for review"
        : `${count} customer ${count === 1 ? "payment is" : "payments are"} waiting for your review`;
  return (
    <Notice title={title}>
      <p>You are signed in as an administrator. This page lists only the projects created with this account; customers&apos; payments are verified or rejected on the payments page.</p>
      <p>
        <Link href="/admin/payments" className="font-semibold underline underline-offset-4">
          Review payments
        </Link>
      </p>
    </Notice>
  );
}

async function ProjectList() {
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;
  const [projects, adminPayments] = await Promise.all([listOwnProjects(access.supabase, access.user.id), pendingPaymentsForAdmin(access.supabase)]);
  const [latest, ...rest] = projects;
  const yourTurn = projects.filter((p) => TONE[p.status] === "yours" || TONE[p.status] === "attention").length;

  return (
    <div className="space-y-12">
      <header className="flex flex-wrap items-end justify-between gap-8 border-b border-border-strong pb-10">
        <div className="space-y-4">
          <p className="eyebrow">Your workspace</p>
          <h1 className="font-display">{projects.length === 0 ? "Welcome" : "Welcome back"}</h1>
          <p className="max-w-xl text-muted">
            {projects.length === 0
              ? "Your projects will appear here. Start one below."
              : `${projects.length} ${projects.length === 1 ? "project" : "projects"}${yourTurn > 0 ? `, ${yourTurn} waiting for you` : ""}. Most recently updated first.`}
          </p>
        </div>
        {projects.length > 0 ? (
          <details className="group relative">
            <summary className={`${buttonPrimary} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
              <span aria-hidden="true">+</span> Create new project
            </summary>
            <div className="absolute right-0 z-20 mt-2 w-[min(18rem,calc(100vw-2.5rem))] rounded-[4px] border border-border bg-paper p-2 shadow-lift">
              <ul>
                {Object.values(JOURNEYS).map((j) => (
                  <li key={j.slug}>
                    <Link href={`/new/${j.slug}`} className="flex min-h-11 items-center rounded-[3px] px-3 text-sm font-medium hover:bg-surface">
                      {j.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        ) : null}
      </header>

      {adminPayments ? <AdminPaymentsNotice count={adminPayments.count} /> : null}

      {!latest ? (
        <section aria-labelledby="empty-title" className="space-y-8">
          <h2 id="empty-title" className="font-display text-4xl font-medium leading-tight">
            You have no projects yet
          </h2>
          <p className="max-w-xl text-muted">Choose the kind of project you want to describe. Describing it costs nothing; you pay only after reading the brief and accepting the quote.</p>
          <ul className="grid gap-4 md:grid-cols-3">
            {Object.values(JOURNEYS).map((j) => {
              const cover = COVERS[j.type];
              return (
                <li key={j.slug}>
                  <Link href={`/new/${j.slug}`} className="group relative block min-h-[20rem] overflow-hidden rounded-[4px] bg-forest text-white">
                    <span className="gn-zoom absolute inset-0">
                      <Image src={cover.photo.src} alt="" fill sizes="(max-width: 768px) 100vw, 33vw" className="object-cover" />
                    </span>
                    <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-[rgb(15_28_24/0.9)] via-[rgb(15_28_24/0.35)] to-transparent" />
                    <span className="relative flex h-full min-h-[20rem] flex-col justify-end gap-2 p-6">
                      <span className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">{cover.kind}</span>
                      <span className="font-display text-3xl font-medium leading-tight">{j.title}</span>
                      <span className="text-sm text-white/80">{j.summary}</span>
                      <span className="mt-2 inline-flex items-center gap-2 text-sm font-semibold">
                        Start this project <span aria-hidden="true" className="gn-arrow">→</span>
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted">Reference photographs from open collections, not ARCADIA projects.</p>
        </section>
      ) : (
        <>
          <section aria-labelledby="latest-title" className="space-y-4">
            <h2 id="latest-title" className="eyebrow">
              Most recent
            </h2>
            <ProjectCard project={latest} feature />
          </section>
          {rest.length > 0 ? (
            <section aria-labelledby="all-title" className="space-y-4">
              <h2 id="all-title" className="eyebrow">
                All projects
              </h2>
              <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {rest.map((p) => (
                  <li key={p.id} className="grid">
                    <ProjectCard project={p} />
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <section aria-label="Start another project" className="flex flex-wrap items-center justify-between gap-6 rounded-[4px] border border-dashed border-border-strong p-6 sm:p-8">
              <p className="max-w-lg text-muted">Planning another space? Each project has its own brief, quote and concepts.</p>
              <ul className="flex flex-wrap gap-3">
                {Object.values(JOURNEYS).map((j) => (
                  <li key={j.slug}>
                    <Link href={`/new/${j.slug}`} className={buttonSecondary}>
                      {j.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<Loading label="Loading your projects…" />}>
      <ProjectList />
    </Suspense>
  );
}
