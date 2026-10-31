import { Notice } from "@/components/journey/notice";
import { ANNOTATIONS_NOTE, CONCEPT_DISCLAIMER, CONCEPT_DISCLAIMER_AI, CUSTOMER_MOCK_DETAIL, MOCK_WARNING } from "@/lib/generation/copy";

/** The persistent warning for mock output. It is a heading-level message, not a tooltip. */
export function MockWarning() {
  return (
    <Notice tone="warning" title={MOCK_WARNING}>
      <p>These pictures come from the prototype&apos;s test generator. No AI model made them and they must not be shown to a customer as a design.</p>
    </Notice>
  );
}

/**
 * The conceptual-use disclaimer for released images. `allAi` only when the server has confirmed
 * that no released image is mock; otherwise the wording that also explains the mock marker.
 */
export function ConceptDisclaimer({ allAi = false }: { allAi?: boolean }) {
  return (
    <Notice tone="info" title="Conceptual illustrations only">
      <p>{allAi ? CONCEPT_DISCLAIMER_AI : CONCEPT_DISCLAIMER}</p>
      <p>{ANNOTATIONS_NOTE}</p>
    </Notice>
  );
}

/** The customer's mock warning, shown only when the server found released images from the test generator. */
export function CustomerMockWarning({ count, total }: { count: number; total: number }) {
  return (
    <Notice tone="warning" title={MOCK_WARNING} role="status">
      <p>
        {count === total ? (total === 1 ? "This image is a placeholder." : "All of these images are placeholders.") : `${count} of these ${total} images ${count === 1 ? "is a placeholder" : "are placeholders"}, marked on the image.`}{" "}
        {CUSTOMER_MOCK_DETAIL}
      </p>
    </Notice>
  );
}

/** `downloadUrl` is a signed link that saves the file; only the customer's released results pass one. */
export type GalleryImage = { id: string; label: string; width: number | null; height: number | null; url: string | null; downloadUrl?: string | null };

/**
 * Images behind short-lived signed links to a private bucket. next/image cannot optimise
 * these, so they are lazy-loaded with explicit dimensions to avoid layout shift. A missing
 * link is said so in words instead of showing a broken picture.
 */
export function ImageGallery({ images, caption, children }: { images: GalleryImage[]; caption: string; children?: React.ReactNode }) {
  if (images.length === 0) return <p className="text-muted">No images to show.</p>;
  return (
    <ul className="grid gap-x-6 gap-y-10 sm:grid-cols-2" aria-label={caption}>
      {images.map((image, i) => (
        // The first image is the centrepiece: full width, the rest in pairs below it.
        <li key={image.id} className={`space-y-3 ${i === 0 ? "sm:col-span-2" : ""}`}>
          {image.url ? (
            <div className="gn-zoom rounded-[4px] border border-border bg-forest shadow-soft">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={`${image.label} (conceptual illustration)`}
                width={image.width ?? 640}
                height={image.height ?? 360}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                className="h-auto w-full bg-surface object-contain"
              />
            </div>
          ) : (
            <p className="flex aspect-video items-center justify-center rounded-[4px] border border-dashed border-border-strong bg-surface p-6 text-center text-sm text-muted">
              This image could not be loaded. Reload the page to try again.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="eyebrow mr-2 tabular">{String(i + 1).padStart(2, "0")}</span>
              <span className="font-medium">{image.label}</span>
            </p>
            {image.url && image.downloadUrl ? (
              <a
                href={image.downloadUrl}
                referrerPolicy="no-referrer"
                aria-label={`Download ${image.label.toLowerCase()}`}
                className="inline-flex min-h-11 items-center gap-2 rounded-[3px] border border-border-strong px-4 text-sm font-semibold transition-colors duration-300 hover:border-foreground hover:bg-paper"
              >
                <span aria-hidden="true">↓</span>Download
              </a>
            ) : null}
          </div>
        </li>
      ))}
      {children}
    </ul>
  );
}
