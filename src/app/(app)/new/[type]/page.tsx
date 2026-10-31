import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PHOTOS, type Photo } from "@/components/landing/photos";
import { AccessGate } from "@/components/journey/access-gate";
import { SignInLink } from "@/components/layout/auth-controls";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { StartProjectButton } from "@/components/journey/start-project-button";
import type { ProjectType } from "@/lib/db/schema";
import { getPageAccess } from "@/lib/journeys/access";
import { JOURNEY_SLUGS, JOURNEYS, projectTypeFromSlug, type JourneySlug } from "@/lib/journeys/project-types";
import { JOURNEY_STEPS } from "@/lib/journeys/steps";

type Props = { params: Promise<{ type: string }> };

/** A reference photograph per journey for the page banner. Not a GNANI project; credited in the caption. */
const BANNERS: Readonly<Record<ProjectType, { photo: Photo; kind: string }>> = {
  EMPTY_PLOT: { photo: PHOTOS.vacantPlot, kind: "New build" },
  INTERIOR: { photo: PHOTOS.livingRoom, kind: "Interior" },
  LANDSCAPE: { photo: PHOTOS.lalbaghGarden, kind: "Landscape" },
};

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
  const banner = BANNERS[type];
  const photoStep = steps.find((s) => s.showsUploadNotice);
  return (
    <div className="space-y-14">
      <section aria-labelledby="journey-title" className="grid overflow-hidden rounded-[4px] bg-forest text-white lg:grid-cols-12">
        <div className="space-y-6 p-8 sm:p-12 lg:col-span-6 lg:py-16">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">{banner.kind} · new project</p>
          <h1 id="journey-title" className="font-display">
            {journey.title}
          </h1>
          <p className="max-w-lg text-lg leading-relaxed text-white/80">{journey.summary}</p>
          <div className="pt-2 [&_button]:bg-white [&_button]:text-forest [&_button]:hover:bg-limestone">
            <Suspense fallback={<Loading />}>
              <Start slug={slug as JourneySlug} />
            </Suspense>
          </div>
        </div>
        <figure className="gn-zoom relative min-h-[18rem] lg:col-span-6">
          <Image src={banner.photo.src} alt={banner.photo.alt} fill sizes="(max-width: 1024px) 100vw, 50vw" loading="eager" className="object-cover" />
          <figcaption className="absolute bottom-3 right-3 max-w-[90%] rounded-[3px] bg-[rgb(15_28_24/0.7)] px-2.5 py-1 text-[0.6875rem] text-white/85">
            Reference photograph: {banner.photo.title}, {banner.photo.creator} ({banner.photo.license})
          </figcaption>
        </figure>
      </section>

      <Suspense fallback={null}>
        <SignInFirst />
      </Suspense>

      <section aria-labelledby="steps-title" className="grid gap-10 lg:grid-cols-12">
        <div className="space-y-3 lg:col-span-4">
          <p className="eyebrow">Your brief, step by step</p>
          <h2 id="steps-title" className="font-display text-4xl font-medium leading-tight">
            What happens next
          </h2>
        </div>
        <ol className="grid gap-x-8 sm:grid-cols-2 lg:col-span-8">
          {steps.map((s, i) => (
            <li key={s.id} className="flex gap-5 border-t border-border-strong py-5">
              <span className="font-display text-3xl leading-none text-sandstone tabular">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-muted">Step {i + 1}</span>
                <span className="block font-medium">{s.title}</span>
              </span>
            </li>
          ))}
          <li className="flex gap-5 border-t border-border-strong py-5">
            <span aria-hidden="true" className="font-display text-3xl leading-none text-sandstone">→</span>
            <span>
              <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-muted">Then</span>
              <span className="block font-medium">Review and approve your brief, then see an itemized quote</span>
            </span>
          </li>
        </ol>
      </section>

      <Notice tone="info">
        <p>{journey.disclaimer}</p>
        <p>
          Everything works by typing. When voice input is switched on, the &ldquo;In your own words&rdquo; step also lets you speak
          your description.
          {photoStep ? ` You can add reference photos of your space on the “${photoStep.title}” step; they are stored privately.` : ""}
        </p>
      </Notice>
    </div>
  );
}

/** For signed-out visitors, says up front that starting a project needs an account. */
async function SignInFirst() {
  const access = await getPageAccess();
  if (access.state !== "signed_out") return null;
  return (
    <Notice tone="info" title="Sign in to start this project">
      <p>You can read what happens below. Saving answers, the brief, the quote and payment all need you to sign in first.</p>
      <p>
        <SignInLink className="font-medium underline underline-offset-4" />
      </p>
    </Notice>
  );
}

async function Start({ slug }: { slug: JourneySlug }) {
  const access = await getPageAccess();
  if (access.state !== "ok") {
    // Signed out: point to sign-in here; the notice below the banner explains why.
    if (access.state === "signed_out") {
      return (
        <SignInLink className="inline-flex min-h-12 items-center rounded-[3px] bg-white px-6 text-[0.9375rem] font-semibold text-forest transition-colors hover:bg-limestone">
          Sign in to start
        </SignInLink>
      );
    }
    return <AccessGate access={access} />;
  }
  return <StartProjectButton slug={slug} />;
}

export default function NewProjectPage({ params }: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <Intro params={params} />
    </Suspense>
  );
}
