"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { removeReferenceAction } from "@/app/(app)/projects/actions";
import { Notice } from "@/components/journey/notice";
import { buttonSecondary, fileInput } from "@/components/journey/styles";
import type { ReferenceView } from "@/lib/references/service";

/**
 * Reference photos and floor plans (PR-010). The photos are stored PRIVATELY: this component only
 * asks the server, which checks the owner, the project state, the file's real type and its size.
 * Thumbnails use short-lived signed links, which expire; reloading the page makes new ones.
 *
 * Constants mirror src/lib/references/service.ts (kept as literals so the server-only service is
 * not pulled into the browser bundle); the server enforces the real limits.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 6;
const ACCEPT = "image/jpeg,image/png,image/webp";

type Upload = { kind: "idle" } | { kind: "uploading"; percent: number } | { kind: "error"; message: string };

function send(projectId: string, file: File, onProgress: (percent: number) => void): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/projects/${encodeURIComponent(projectId)}/references`);
    request.timeout = 60_000;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let body: { ok?: boolean; message?: string; error?: { message?: string } } | null = null;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        body = null;
      }
      if (request.status >= 200 && request.status < 300 && body?.ok) resolve({ ok: true });
      else resolve({ ok: false, message: body?.message ?? body?.error?.message ?? "The photo could not be saved. Please try again." });
    };
    request.onerror = () => resolve({ ok: false, message: "The upload did not complete. Check your connection and try again." });
    request.ontimeout = () => resolve({ ok: false, message: "The upload took too long. Try a smaller photo." });
    const form = new FormData();
    form.append("file", file);
    request.send(form);
  });
}

export function ReferenceUploads({ projectId, items, sentToImageService }: { projectId: string; items: ReferenceView[]; sentToImageService: boolean }) {
  const id = useId();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload>({ kind: "idle" });
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();
  const full = items.length >= MAX_FILES;
  const busy = upload.kind === "uploading" || removing;

  async function choose(file: File | undefined) {
    if (!file) return;
    if (file.size === 0) return setUpload({ kind: "error", message: "That file is empty. Choose another." });
    if (file.size > MAX_BYTES) return setUpload({ kind: "error", message: "That photo is larger than 5 MB. Choose a smaller one." });
    if (!ACCEPT.split(",").includes(file.type)) return setUpload({ kind: "error", message: "Use a JPEG, PNG or WebP image." });
    setUpload({ kind: "uploading", percent: 0 });
    const result = await send(projectId, file, (percent) => setUpload({ kind: "uploading", percent }));
    if (input.current) input.current.value = "";
    if (!result.ok) return setUpload({ kind: "error", message: result.message ?? "The photo could not be saved." });
    setUpload({ kind: "idle" });
    router.refresh();
  }

  function remove(assetId: string) {
    setRemoveError(null);
    startRemoving(async () => {
      const result = await removeReferenceAction(projectId, assetId);
      if (result && !result.ok) setRemoveError(result.message);
      else router.refresh();
    });
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <h3 id={`${id}-title`} className="text-lg font-semibold">
        Photos or a floor plan (optional)
      </h3>
      <p className="text-sm text-muted">
        JPEG, PNG or WebP, up to 5 MB each, up to {MAX_FILES} files. They are stored privately: only you and our reviewer can see them.{" "}
        {sentToImageService
          ? "When concept images are made with the live image service, up to three of these photos are sent to it as reference input."
          : "In this setup they are not sent to any outside service."}{" "}
        Concept images are only inspired by them: layouts, openings and sizes may change.
      </p>

      {items.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-3" aria-label="Your reference photos">
          {items.map((item, index) => (
            <li key={item.id} className="space-y-2">
              {item.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.url}
                  alt={`Reference photo ${index + 1}`}
                  width={item.width ?? 320}
                  height={item.height ?? 240}
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="h-32 w-full rounded-lg border border-border bg-background object-cover"
                />
              ) : (
                <p className="flex h-32 items-center rounded-lg border border-border bg-background p-2 text-sm text-muted">This photo could not be shown. Reload the page.</p>
              )}
              <button type="button" className={buttonSecondary} onClick={() => remove(item.id)} disabled={busy} aria-label={`Remove reference photo ${index + 1}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No photos added yet. You can continue without them.</p>
      )}

      <div>
        <label htmlFor={`${id}-file`} className="block text-sm font-medium">
          {items.length > 0 ? "Add another photo" : "Add a photo"}
        </label>
        <input
          ref={input}
          id={`${id}-file`}
          type="file"
          accept={ACCEPT}
          disabled={busy || full}
          onChange={(e) => void choose(e.target.files?.[0])}
          className={`mt-2 ${fileInput}`}
          aria-describedby={full ? `${id}-full` : undefined}
        />
        {full ? (
          <p id={`${id}-full`} className="mt-1 text-sm text-muted">
            You have added the most photos allowed. Remove one to add another.
          </p>
        ) : null}
      </div>

      {upload.kind === "uploading" ? (
        <div role="status" className="space-y-1">
          <p className="text-sm">Uploading… {upload.percent}%</p>
          <progress className="w-full" max={100} value={upload.percent} aria-label="Upload progress" />
        </div>
      ) : null}
      {upload.kind === "error" ? (
        <Notice tone="danger" role="alert" title="That photo was not added">
          <p>{upload.message}</p>
        </Notice>
      ) : null}
      {removeError ? (
        <Notice tone="danger" role="alert" title="That photo was not removed">
          <p>{removeError}</p>
        </Notice>
      ) : null}
    </section>
  );
}
