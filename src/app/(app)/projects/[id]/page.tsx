import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { Progress } from "@/components/journey/progress";
import { getPageAccess } from "@/lib/journeys/access";
import { describeAnswers } from "@/lib/journeys/brief";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { getOwnedProject } from "@/lib/journeys/service";
import { STATUS_INFO } from "@/lib/journeys/status";
import { validateRequirements } from "@/lib/journeys/validation";

export const metadata: Metadata = { title: "Project" };

type Props = { params: Promise<{ id: string }> };

async function ProjectHub({ params }: Props) {
  const { id } = await params;
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;
  const project = await getOwnedProject(access.supabase, access.user.id, id);
  if (!project) notFound();

  const info = STATUS_INFO[project.status];
  const check = validateRequirements(project.project_type, project.requirements_json);
  const facts = check.complete ? describeAnswers(project.project_type, check.requirements) : [];

  return (
    <>
      <p>
        <Link href="/projects" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted hover:text-foreground">
          <span aria-hidden="true">←</span> My projects
        </Link>
      </p>
      <header className="space-y-4 border-b border-border-strong pb-8">
        <p className="eyebrow">
          Project <span className="tabular">#{project.id.slice(0, 6).toUpperCase()}</span>
        </p>
        <h1 className="font-display">{JOURNEYS[project.project_type].title}</h1>
        <p className="inline-flex items-center gap-2 rounded-[3px] border border-border-strong bg-paper px-3 py-1.5 text-sm">
          <span className="font-semibold">Status:</span> {info.label}
        </p>
      </header>
      <Progress status={project.status} />
      <section aria-labelledby="next-title" className="grid gap-6 rounded-[4px] bg-forest p-7 text-white sm:grid-cols-[1fr_auto] sm:items-center sm:p-9">
        <div className="space-y-2">
          <h2 id="next-title" className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
            What to do next
          </h2>
          <p className="font-display text-2xl leading-snug sm:text-3xl">{info.next}</p>
        </div>
        {info.actionPath !== null && info.actionLabel ? (
          <Link
            href={`/projects/${project.id}${info.actionPath}`}
            className="inline-flex min-h-12 items-center justify-center gap-3 rounded-[3px] bg-white px-6 text-[0.9375rem] font-semibold text-forest transition-colors duration-300 hover:bg-limestone active:translate-y-px"
          >
            {info.actionLabel} <span aria-hidden="true" className="gn-arrow">→</span>
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="answers-title" className="space-y-4">
        <h2 id="answers-title" className="font-display text-3xl font-medium">
          Your answers
        </h2>
        {facts.length === 0 ? (
          <Notice tone="info">
            <p>{check.complete ? "No answers recorded yet." : "Your answers are not complete yet."}</p>
          </Notice>
        ) : (
          <dl className="grid gap-x-10 sm:grid-cols-2">
            {facts.map((f) => (
              <div key={`${f.stepTitle}-${f.label}`} className="border-t border-border py-4">
                <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{f.label}</dt>
                <dd className="mt-1">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  );
}

export default function ProjectPage({ params }: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <ProjectHub params={params} />
    </Suspense>
  );
}
