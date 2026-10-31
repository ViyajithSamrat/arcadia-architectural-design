"use client";

import { useEffect, useRef, useState } from "react";
import { Notice } from "@/components/journey/notice";
import { button, buttonPrimary } from "@/components/journey/styles";
import { READBACK_AUDIO_FAILED, READBACK_CONSENT, READBACK_SHORTENED_NOTE } from "@/lib/voice/copy";

type State = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; url: string; shortened: boolean } | { kind: "error"; message: string };

/**
 * Spoken read-back of the stored summary. Shown only when the server says text-to-speech is
 * configured. The server speaks its own stored summary: this component sends only the consent
 * and the project id (in the address). If anything goes wrong the text above stays the answer.
 */
export function ReadbackAudio({ projectId }: { projectId: string }) {
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  async function listen() {
    if (!consent || state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/readback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consent: true }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
        const message = typeof body?.error?.message === "string" ? body.error.message : READBACK_AUDIO_FAILED;
        setState({ kind: "error", message });
        return;
      }
      const blob = await response.blob();
      if (!blob.type.startsWith("audio/") || blob.size === 0) {
        setState({ kind: "error", message: READBACK_AUDIO_FAILED });
        return;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setState({ kind: "ready", url, shortened: response.headers.get("x-readback-shortened") === "1" });
    } catch {
      setState({ kind: "error", message: READBACK_AUDIO_FAILED });
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-3">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={state.kind === "loading"} className="mt-1 size-5 accent-[var(--accent)]" />
        <span>{READBACK_CONSENT}</span>
      </label>
      <button type="button" className={state.kind === "ready" ? button : buttonPrimary} onClick={listen} disabled={!consent || state.kind === "loading"} aria-busy={state.kind === "loading"}>
        {state.kind === "loading" ? "Preparing the audio…" : state.kind === "ready" ? "Listen again" : "Listen to this summary"}
      </button>
      {state.kind === "ready" ? (
        <div className="space-y-2">
          <audio controls src={state.url} className="w-full">
            Your browser cannot play audio. The summary above is the same text.
          </audio>
          {state.shortened ? <p className="text-sm text-muted">{READBACK_SHORTENED_NOTE}</p> : null}
        </div>
      ) : null}
      {state.kind === "error" ? (
        <Notice tone="warning" role="alert" title="Audio is not available right now">
          <p>{state.message}</p>
        </Notice>
      ) : null}
    </div>
  );
}
