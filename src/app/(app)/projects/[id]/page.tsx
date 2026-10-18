import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { Progress } from "@/components/journey/progress";
import { buttonPrimary } from "@/components/journey/styles";
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
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-medium tracking-tight">{JOURNEYS[project.project_type].title}</h1>
        <p>
          <span className="font-medium">Status:</span> {info.label}
        </p>
      </header>
      <Progress status={project.status} />
      <Notice tone="info" title="What to do next">
        <p>{info.next}</p>
      </Notice>
      {info.actionPath !== null && info.actionLabel ? (
        <p>
          <Link href={`/projects/${project.id}${info.actionPath}`} className={buttonPrimary}>
            {info.actionLabel}
          </Link>
        </p>
      ) : null}

      <section aria-labelledby="answers-title" className="space-y-3">
        <h2 id="answers-title" className="text-xl font-semibold">
          Your answers
        </h2>
        {facts.length === 0 ? (
          <p className="text-muted">{check.complete ? "No answers recorded yet." : "Your answers are not complete yet."}</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
            {facts.map((f) => (
              <div key={`${f.stepTitle}-${f.label}`}>
                <dt className="text-sm text-muted">{f.label}</dt>
                <dd>{f.value}</dd>
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
