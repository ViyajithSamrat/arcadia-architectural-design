import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessGate } from "@/components/journey/access-gate";
import { Loading } from "@/components/journey/loading";
import { buttonSecondary } from "@/components/journey/styles";
import { getPageAccess } from "@/lib/journeys/access";
import { JOURNEYS } from "@/lib/journeys/project-types";
import { listOwnProjects } from "@/lib/journeys/service";
import { STATUS_INFO } from "@/lib/journeys/status";

export const metadata: Metadata = { title: "My projects" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

async function ProjectList() {
  const access = await getPageAccess();
  if (access.state !== "ok") return <AccessGate access={access} />;
  const projects = await listOwnProjects(access.supabase, access.user.id);

  if (projects.length === 0) {
    return (
      <section aria-labelledby="empty-title" className="space-y-4 rounded-lg border border-border bg-surface p-6">
        <h2 id="empty-title" className="text-xl font-semibold">
          You have no projects yet
        </h2>
        <p className="text-muted">Choose the kind of project you want to describe.</p>
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
    );
  }

  return (
    <ul className="space-y-3">
      {projects.map((p) => {
        const info = STATUS_INFO[p.status];
        return (
          <li key={p.id} className="rounded-lg border border-border bg-surface p-4">
            <Link href={`/projects/${p.id}`} className="block space-y-1">
              <span className="block font-semibold underline-offset-4 hover:underline">{JOURNEYS[p.project_type].title}</span>
              <span className="block text-sm">
                <span className="font-medium">Status:</span> {info.label}
              </span>
              <span className="block text-sm text-muted">
                Started {dateFormat.format(new Date(p.created_at))} · {info.next}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function ProjectsPage() {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-medium tracking-tight">My projects</h1>
      <Suspense fallback={<Loading />}>
        <ProjectList />
      </Suspense>
    </div>
  );
}
