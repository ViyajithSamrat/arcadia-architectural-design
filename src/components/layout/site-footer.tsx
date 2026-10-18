import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-4xl space-y-3 px-4 py-6 text-sm text-muted sm:px-6">
        <p>
          These are conceptual design ideas, not construction drawings. Have a qualified
          professional validate dimensions, structure, safety, and local regulations before
          building.
        </p>
        <p>
          <Link href="/status" className="underline underline-offset-4">
            System status
          </Link>
        </p>
      </div>
    </footer>
  );
}
