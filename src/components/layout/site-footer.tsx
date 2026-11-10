import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto bg-forest text-white/75">
      <div className="mx-auto w-full max-w-7xl space-y-6 px-5 py-12 text-sm sm:px-8">
        <div className="max-w-2xl leading-relaxed">
          <p>
            These are conceptual design ideas, not construction drawings. Have a qualified
            professional validate dimensions, structure, safety, and local regulations before
            building.
          </p>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-6 border-t border-white/15 pt-6 print:hidden">
          <span className="font-display text-2xl font-semibold tracking-[0.18em] text-white">ARCADIA</span>
          <p className="print:hidden"><Link href="/status" className="inline-flex min-h-11 items-center underline-offset-4 transition-colors hover:text-white hover:underline">System status</Link></p>
        </div>
      </div>
    </footer>
  );
}
