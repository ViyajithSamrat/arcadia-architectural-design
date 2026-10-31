/** Shared class names for the journey pages, so buttons and fields look the same everywhere. */
export const button =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[3px] px-6 py-2 text-[0.9375rem] font-semibold tracking-[0.01em] transition-[background-color,border-color,color,transform,box-shadow] duration-300 ease-[var(--ease-out)] active:translate-y-px focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0";
export const buttonPrimary = `${button} bg-accent text-accent-contrast shadow-soft hover:bg-accent-soft hover:shadow-lift`;
export const buttonSecondary = `${button} border border-border-strong bg-transparent text-foreground hover:border-foreground hover:bg-paper`;
export const input =
  "block min-h-11 w-full rounded-[3px] border border-border bg-paper px-3.5 py-2.5 text-base text-foreground shadow-[inset_0_1px_2px_rgb(24_41_35/0.04)] transition-colors duration-200 placeholder:text-muted hover:border-border-strong focus:border-accent focus-visible:outline-offset-1 aria-[invalid=true]:border-danger-fg";
/** A native file input with its browse button styled like a secondary button. */
export const fileInput =
  "block w-full text-sm text-muted file:mr-4 file:inline-flex file:min-h-11 file:cursor-pointer file:rounded-[3px] file:border file:border-solid file:border-border-strong file:bg-paper file:px-4 file:text-sm file:font-semibold file:text-foreground file:transition-colors hover:file:border-foreground disabled:cursor-not-allowed disabled:opacity-60";
export const card ="rounded-[4px] border border-border bg-surface p-6";
