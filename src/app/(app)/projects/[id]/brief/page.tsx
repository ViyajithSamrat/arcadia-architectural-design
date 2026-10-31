import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { BriefReviewForm } from "@/components/journey/brief-review-form";
import { CreateBriefButton } from "@/components/journey/journey-actions";
import { ReadbackSummary } from "@/components/journey/readback-summary";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { ProjectHeader } from "@/components/journey/project-header";
import { buttonPrimary, buttonSecondary } from "@/components/journey/styles";
import { EDITABLE_PROJECT_STATUSES } from "@/lib/db/schema";
import { getPageAccess } from "@/lib/journeys/access";
import { getGnaniTtsReadiness } from "@/lib/providers/config";
import { describeAnswers } from "@/lib/journeys/brief";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { getOwnedProject, readStoredBrief } from "@/lib/journeys/service";
import { validateRequirements } from "@/lib/journeys/validation";

export const metadata: Metadata = { title: "Your brief" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> };

function List({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function BriefContent({ params, searchParams }: Props) {
  const [{ id }, { saved }] = await Promise.all([params, searchParams]);
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;
  const project = await getOwnedProject(access.supabase, access.user.id, id);
  if (!project) notFound();

  const journey = JOURNEYS[project.project_type];
  const check = validateRequirements(project.project_type, project.requirements_json);
  const heading = <ProjectHeader projectId={project.id} kind={journey.title} title="Your brief" />;

  // Before a brief exists, or after the answers changed and cleared it.
  const brief = readStoredBrief(project);
  const editable = EDITABLE_PROJECT_STATUSES.includes(project.status);

  if (editable && !brief) {
    return (
      <>
        {heading}
        {check.complete ? (
          <div className="space-y-4">
            <Notice tone="info" title="Ready to create your brief">
              <p>Your answers are complete. The brief turns them into a clear English summary you can read and edit.</p>
            </Notice>
            <CreateBriefButton projectId={project.id} />
          </div>
        ) : (
          <div className="space-y-4">
            <Notice tone="warning" title="Some required answers are missing">
              <ul className="list-disc pl-5">
                {check.missingRequiredFields.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Notice>
            <Link href={`/projects/${project.id}/edit`} className={buttonPrimary}>
              Finish your answers
            </Link>
          </div>
        )}
      </>
    );
  }

  if (!brief) {
    return (
      <>
        {heading}
        <Notice tone="warning" title="No brief found">
          <p>This project does not have a readable brief. Please contact support.</p>
        </Notice>
      </>
    );
  }

  const facts = describeAnswers(project.project_type, brief.requirements);
  const text = project.english_brief_text ?? brief.englishBrief;

  return (
    <>
      {heading}
      {brief.meta.provider === "mock" ? (
        <Notice tone="warning" title="Demo/mock output">
          <p>
            Demo/mock output: this brief was written by a built-in template from your answers, not by the live AI
            provider.
          </p>
        </Notice>
      ) : (
        <Notice tone="info" title="Drafted with AI from your answers">
          <p>
            The wording was drafted by an AI model ({brief.meta.model ?? brief.meta.provider}) from your answers. The
            measurements and counts under &ldquo;What you told us&rdquo; are your own answers. Read the brief and correct
            anything before you approve it.
          </p>
        </Notice>
      )}
      {saved === "1" ? (
        <Notice tone="success" role="status" title="Your edits are saved">
          <p>Approve the brief when you are happy with it.</p>
        </Notice>
      ) : null}

      <section aria-labelledby="facts-title" className="space-y-3">
        <h2 id="facts-title" className="text-xl font-semibold">
          What you told us
        </h2>
        <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
          {facts.map((f) => (
            <div key={`${f.stepTitle}-${f.label}`}>
              <dt className="text-sm text-muted">{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="gaps-title" className="grid gap-6 sm:grid-cols-2">
        <h2 id="gaps-title" className="sr-only">
          Assumptions and open questions
        </h2>
        <List title="What we assumed" items={brief.assumptions} empty="Nothing was assumed." />
        <List
          title="Still open (optional)"
          items={brief.missingOptionalDetails}
          empty="Nothing else is open."
        />
      </section>

      <ReadbackSummary text={brief.customerReadbackText} audioProjectId={getGnaniTtsReadiness().ready ? project.id : null} />

      <section aria-labelledby="text-title" className="space-y-3">
        <h2 id="text-title" className="text-xl font-semibold">
          Review the brief
        </h2>
        {editable ? (
          <>
            <BriefReviewForm
              projectId={project.id}
              initialText={text}
              canApprove={check.complete}
              blockedReason={check.complete ? undefined : check.missingRequiredFields.join("; ")}
            />
            <div className="flex flex-wrap gap-3 pt-2">
              <Link href={`/projects/${project.id}/edit`} className={buttonSecondary}>
                Change my answers
              </Link>
              <CreateBriefButton projectId={project.id} again />
            </div>
          </>
        ) : (
          <>
            <p className="whitespace-pre-line rounded-lg border border-border bg-surface p-4">{text}</p>
            <Notice tone="success" title="Brief approved">
              <p>This brief is approved and can no longer be edited.</p>
            </Notice>
            <Link href={`/projects/${project.id}/quote`} className={buttonPrimary}>
              Go to your quote
            </Link>
          </>
        )}
      </section>

      <Notice tone="info">
        <p>{journey.disclaimer}</p>
      </Notice>
    </>
  );
}

export default function BriefPage(props: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <BriefContent {...props} />
    </Suspense>
  );
}
