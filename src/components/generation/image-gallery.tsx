import { Notice } from "@/components/journey/notice";
import { CONCEPT_DISCLAIMER, MOCK_WARNING } from "@/lib/generation/copy";

/** The persistent warning for mock output. It is a heading-level message, not a tooltip. */
export function MockWarning() {
  return (
    <Notice tone="warning" title={MOCK_WARNING}>
      <p>These pictures come from the prototype&apos;s test generator. No AI model made them and they must not be shown to a customer as a design.</p>
    </Notice>
  );
}

/** The conceptual-use disclaimer for released images. */
export function ConceptDisclaimer() {
  return (
    <Notice tone="info" title="Conceptual illustrations only">
      <p>{CONCEPT_DISCLAIMER}</p>
    </Notice>
  );
}

export type GalleryImage = { id: string; label: string; width: number | null; height: number | null; url: string | null };

/**
 * Images behind short-lived signed links to a private bucket. next/image cannot optimise
 * these, so they are lazy-loaded with explicit dimensions to avoid layout shift. A missing
 * link is said so in words instead of showing a broken picture.
 */
export function ImageGallery({ images, caption, children }: { images: GalleryImage[]; caption: string; children?: React.ReactNode }) {
  if (images.length === 0) return <p className="text-muted">No images to show.</p>;
  return (
    <ul className="grid gap-4 sm:grid-cols-2" aria-label={caption}>
      {images.map((image) => (
        <li key={image.id} className="space-y-2">
          {image.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image.url}
              alt={`${image.label} (conceptual illustration)`}
              width={image.width ?? 640}
              height={image.height ?? 360}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="h-auto w-full rounded-lg border border-border bg-surface object-contain"
            />
          ) : (
            <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted">This image could not be loaded. Reload the page to try again.</p>
          )}
          <p className="text-sm font-medium">{image.label}</p>
        </li>
      ))}
      {children}
    </ul>
  );
}
