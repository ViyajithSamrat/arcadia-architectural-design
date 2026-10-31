import { Notice } from "@/components/journey/notice";
import { ReadbackAudio } from "@/components/journey/readback-audio";
import { READBACK_TEXT_FALLBACK } from "@/lib/voice/copy";

/**
 * The brief's read-back summary (PR-009). The summary is always shown as text. When the server
 * has spoken read-back configured (`audioProjectId` given), a consent-gated Listen control sits
 * under it; otherwise the screen says listening is not available. There is never a play button
 * that could appear to work when it cannot.
 */
export function ReadbackSummary({ text, audioProjectId }: { text: string; audioProjectId?: string | null }) {
  const summary = text.trim();
  return (
    <section aria-labelledby="readback-title" className="space-y-3">
      <h2 id="readback-title" className="text-xl font-semibold">
        Read-back summary
      </h2>
      {summary ? (
        <p className="whitespace-pre-line rounded-lg border border-border bg-surface p-4">{summary}</p>
      ) : (
        <p className="text-muted">No separate summary was produced for this brief. The full brief is below.</p>
      )}
      {audioProjectId && summary ? (
        <ReadbackAudio projectId={audioProjectId} />
      ) : (
        <Notice tone="info" title="Shown as text">
          <p>{READBACK_TEXT_FALLBACK}</p>
        </Notice>
      )}
    </section>
  );
}
