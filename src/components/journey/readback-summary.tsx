import { Notice } from "@/components/journey/notice";
import { READBACK_TEXT_FALLBACK } from "@/lib/voice/copy";

/**
 * The brief's read-back summary (PR-009). Spoken read-back needs a text-to-speech service, which
 * is not connected, so the summary stays visible as text and the screen says why; there is no
 * play button that could appear to work.
 */
export function ReadbackSummary({ text }: { text: string }) {
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
      <Notice tone="info" title="Shown as text">
        <p>{READBACK_TEXT_FALLBACK}</p>
      </Notice>
    </section>
  );
}
