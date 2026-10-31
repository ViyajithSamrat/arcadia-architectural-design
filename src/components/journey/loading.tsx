/** A quiet placeholder in the shape of a page: a title bar and two lines, with the label for screen readers and sighted users. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="space-y-4 py-2">
      <span aria-hidden="true" className="block h-9 w-2/3 max-w-md animate-pulse rounded-[3px] bg-border/70" />
      <span aria-hidden="true" className="block h-3 w-full max-w-xl animate-pulse rounded-[3px] bg-border/50" />
      <span aria-hidden="true" className="block h-3 w-1/2 max-w-sm animate-pulse rounded-[3px] bg-border/50" />
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}
