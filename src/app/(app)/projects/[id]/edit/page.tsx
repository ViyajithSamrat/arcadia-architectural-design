import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { StepForm } from "@/components/journey/step-form";
import { EDITABLE_PROJECT_STATUSES } from "@/lib/db/schema";
import { getPageAccess } from "@/lib/journeys/access";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { getOwnedProject } from "@/lib/journeys/service";
import { findStep, JOURNEY_STEPS } from "@/lib/journeys/steps";
import { getVoiceState } from "@/lib/journeys/voice";

export const metadata: Metadata = { title: "Your answers" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ step?: string }> };

async function EditContent({ params, searchParams }: Props) {
  const [{ id }, { step: requested }] = await Promise.all([params, searchParams]);
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;
  const project = await getOwnedProject(access.supabase, access.user.id, id);
  if (!project) notFound();
  if (!EDITABLE_PROJECT_STATUSES.includes(project.status)) redirect(`/projects/${project.id}`);

  const steps = JOURNEY_STEPS[project.project_type];
  const step = (requested && findStep(project.project_type, requested)) || steps[0];
  const stored = project.requirements_json as Record<string, unknown>;
  const saved = stored[step.id];
  const initial = typeof saved === "object" && saved !== null && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const journey = JOURNEYS[project.project_type];

  return (
    <>
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-medium tracking-tight">{journey.title}</h1>
      </header>
      {project.status === "BRIEF_REVIEW" ? (
        <Notice tone="warning" title="Changing an answer clears your brief">
          <p>You will create the brief again after saving, so it always matches your answers.</p>
        </Notice>
      ) : null}
      <StepForm
        key={step.id}
        projectId={project.id}
        projectType={project.project_type}
        stepId={step.id}
        initial={initial}
        voice={getVoiceState()}
      />
      <Notice tone="info">
        <p>{journey.disclaimer}</p>
      </Notice>
    </>
  );
}

export default function EditPage(props: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <EditContent {...props} />
    </Suspense>
  );
}
