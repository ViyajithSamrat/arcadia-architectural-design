import Link from "next/link";

/** The heading of a project's sub-page: a way back to the project, the project's reference, and the page title. */
export function ProjectHeader({ projectId, title, kind }: { projectId: string; title: string; kind?: string }) {
  return (
    <header className="space-y-4 border-b border-border-strong pb-8 print:border-0 print:pb-0">
      <p className="print:hidden">
        <Link href={`/projects/${projectId}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-muted hover:text-foreground">
          <span aria-hidden="true">←</span> Project overview
        </Link>
      </p>
      <p className="eyebrow">
        {kind ? `${kind} · ` : ""}Project <span className="tabular">#{projectId.slice(0, 6).toUpperCase()}</span>
      </p>
      <h1 className="font-display">{title}</h1>
    </header>
  );
}
