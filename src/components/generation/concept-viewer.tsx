"use client";

import { useState } from "react";
import type { ReleasedAsset } from "@/lib/generation/read";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The customer's released concepts: one large image at a time, previous and next controls
 * (buttons and the arrow keys), and a strip of the others. Images come through short-lived signed
 * links to private storage, so they are plain <img> elements with their own dimensions to avoid
 * layout shift; nothing here decides what is visible, the server already did.
 */
export function ConceptViewer({ images, mockIds = null }: { images: ReleasedAsset[]; mockIds?: string[] | null }) {
  const [index, setIndex] = useState(0);
  if (images.length === 0) return null;
  const count = images.length;
  const current = images[Math.min(index, count - 1)];
  // null: the server could not tell, so no image is labelled either way (the page notice covers both).
  const kind = (id: string): "mock" | "ai" | null => (mockIds === null ? null : mockIds.includes(id) ? "mock" : "ai");
  const currentKind = kind(current.id);
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);

  return (
    <div className="space-y-5">
      <div
        role="region"
        aria-roledescription="carousel"
        aria-label="Your released concept images"
        tabIndex={count > 1 ? 0 : undefined}
        onKeyDown={(e) => {
          if (count < 2) return;
          if (e.key === "ArrowRight") {
            e.preventDefault();
            go(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            go(-1);
          }
        }}
        className="group relative overflow-hidden rounded-[4px] bg-forest shadow-lift"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current.id}
          src={current.url}
          alt={`${current.label} (conceptual illustration)`}
          width={current.width ?? 1600}
          height={current.height ?? 900}
          loading={index === 0 ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          className="gn-fade block h-auto w-full bg-forest"
        />
        {currentKind === "mock" ? (
          <span className="absolute left-4 top-4 rounded-[3px] bg-warning-bg px-3 py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-warning-fg shadow-soft">
            Mock — not a design
          </span>
        ) : null}
        {count > 1 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 bg-gradient-to-t from-[rgb(15_28_24/0.75)] to-transparent p-4 pt-16 sm:p-6 sm:pt-20">
            <p className="font-display text-2xl text-white tabular sm:text-3xl">
              {pad(index + 1)} <span className="text-white/50">/ {pad(count)}</span>
            </p>
            <div className="pointer-events-auto flex gap-2">
              <button
                type="button"
                onClick={() => go(-1)}
                aria-label="Previous image"
                className="inline-flex size-12 items-center justify-center rounded-full border border-white/40 bg-[rgb(15_28_24/0.35)] text-lg text-white backdrop-blur-sm transition-colors duration-300 hover:border-white hover:bg-[rgb(15_28_24/0.6)] active:translate-y-px"
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                aria-label="Next image"
                className="inline-flex size-12 items-center justify-center rounded-full border border-white/40 bg-[rgb(15_28_24/0.35)] text-lg text-white backdrop-blur-sm transition-colors duration-300 hover:border-white hover:bg-[rgb(15_28_24/0.6)] active:translate-y-px"
              >
                →
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p aria-live="polite" className="text-sm">
          <span className="eyebrow mr-3 tabular">
            Image {index + 1} of {count}
            {currentKind === "ai" ? " · AI-generated concept" : currentKind === "mock" ? " · Test placeholder" : ""}
          </span>
          <span className="font-display text-2xl font-medium">{current.label}</span>
        </p>
        {current.downloadUrl ? (
          <a
            href={current.downloadUrl}
            referrerPolicy="no-referrer"
            aria-label={`Download ${current.label.toLowerCase()}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-[3px] bg-accent px-5 text-sm font-semibold text-accent-contrast shadow-soft transition-colors duration-300 hover:bg-accent-soft active:translate-y-px"
          >
            <span aria-hidden="true">↓</span>Download
          </a>
        ) : null}
      </div>

      {count > 1 ? (
        <ul aria-label="All concept images" className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {images.map((image, i) => (
            <li key={image.id}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show image ${i + 1}: ${image.label}`}
                aria-current={i === index ? "true" : undefined}
                className={`gn-zoom block w-full overflow-hidden rounded-[3px] border-2 bg-forest transition-[border-color,opacity] duration-300 ${
                  i === index ? "border-accent" : "border-transparent opacity-70 hover:opacity-100"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt=""
                  width={image.width ?? 1600}
                  height={image.height ?? 900}
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="block aspect-[4/3] h-auto w-full object-cover"
                />
                {kind(image.id) === "mock" ? <span className="block bg-warning-bg py-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-warning-fg">Mock</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
