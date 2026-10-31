import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { StepForm } from "@/components/journey/step-form";
import { EDITABLE_PROJECT_STATUSES } from "@/lib/db/schema";
import { referencesSentToImageService } from "@/lib/generation/provider";
import { getPageAccess } from "@/lib/journeys/access";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { getOwnedProject } from "@/lib/journeys/service";
import { findStep, JOURNEY_STEPS } from "@/lib/journeys/steps";
import { getVoiceView } from "@/lib/journeys/voice";
import { getTranslationView } from "@/lib/translation/mode";
import { listReferences, type ReferenceView } from "@/lib/references/service";

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

  // Reference photos are listed only on the steps that take them, through the owner's own session.
  let references: { items: ReferenceView[]; sentToImageService: boolean } | null = null;
  if (step.showsUploadNotice) {
    const items = await listReferences(access.supabase, access.user.id, project.id);
    references = items ? { items, sentToImageService: referencesSentToImageService() } : null;
  }

  return (
    <>
      <p>
        <Link href={`/projects/${project.id}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted hover:text-foreground">
          <span aria-hidden="true">←</span> Project overview
        </Link>
      </p>
      <header className="space-y-3">
        <p className="eyebrow">Your brief · {journey.title}</p>
        <h1 className="font-display">Tell us about your project</h1>
      </header>
      {project.status === "BRIEF_REVIEW" ? (
        <Notice tone="warning" title="Changing an answer clears your brief">
          <p>You will create the brief again after saving, so it always matches your answers.</p>
        </Notice>
      ) : null}
      <div className="rounded-[4px] border border-border bg-paper p-6 shadow-soft sm:p-10">
        <StepForm
          key={step.id}
          projectId={project.id}
          projectType={project.project_type}
          stepId={step.id}
          initial={initial}
          voice={getVoiceView()}
          translation={getTranslationView()}
          references={references}
        />
      </div>
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
