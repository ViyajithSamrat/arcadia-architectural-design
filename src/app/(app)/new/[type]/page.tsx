import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { StartProjectButton } from "@/components/journey/start-project-button";
import { getPageAccess } from "@/lib/journeys/access";
import { JOURNEY_SLUGS, JOURNEYS, projectTypeFromSlug, type JourneySlug } from "@/lib/journeys/project-types";
import { JOURNEY_STEPS } from "@/lib/journeys/steps";

type Props = { params: Promise<{ type: string }> };

export function generateStaticParams() {
  return JOURNEY_SLUGS.map((type) => ({ type }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const type = projectTypeFromSlug((await params).type);
  return { title: type ? JOURNEYS[type].title : "Not found" };
}

async function Intro({ params }: Props) {
  const slug = (await params).type;
  const type = projectTypeFromSlug(slug);
  if (!type) notFound();
  const journey = JOURNEYS[type];
  const steps = JOURNEY_STEPS[type];
  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="font-display text-3xl font-medium tracking-tight sm:text-4xl">{journey.title}</h1>
        <p className="max-w-2xl text-lg text-muted">{journey.summary}</p>
      </header>

      <section aria-labelledby="steps-title" className="space-y-3">
        <h2 id="steps-title" className="text-xl font-semibold">
          What happens next
        </h2>
        <ol className="grid gap-3 sm:grid-cols-2">
          {steps.map((s, i) => (
            <li key={s.id} className="rounded-lg border border-border bg-surface p-4">
              <p className="text-sm text-muted">Step {i + 1}</p>
              <p className="font-medium">{s.title}</p>
            </li>
          ))}
          <li className="rounded-lg border border-border bg-surface p-4">
            <p className="text-sm text-muted">Then</p>
            <p className="font-medium">Review and approve your brief, then see an itemized quote</p>
          </li>
        </ol>
      </section>

      <Notice tone="info">
        <p>{journey.disclaimer}</p>
        <p>Voice input is not configured and uploads are not configured yet. Everything works by typing.</p>
      </Notice>

      <Suspense fallback={<Loading />}>
        <Start slug={slug as JourneySlug} />
      </Suspense>
    </div>
  );
}

async function Start({ slug }: { slug: JourneySlug }) {
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;
  return <StartProjectButton slug={slug} />;
}

export default function NewProjectPage({ params }: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <Intro params={params} />
    </Suspense>
  );
}
