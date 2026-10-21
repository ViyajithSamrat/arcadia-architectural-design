"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { VoiceLanguageOption } from "@/lib/journeys/voice";
import { VoiceCaptureController, type CaptureResult, type CaptureState } from "@/lib/voice/capture";
import { requestTranscription } from "@/lib/voice/client";
import { DEMO_LANGUAGE_NOTE, MOCK_RESULT_NOTICE, MOCK_VOICE_NOTICE, VOICE_CONSENT_LIVE, VOICE_CONSENT_MOCK } from "@/lib/voice/copy";
import { browserRecorderEnv, WavRecorder } from "@/lib/voice/recorder";
import { Notice } from "./notice";
import { buttonPrimary, buttonSecondary, input } from "./styles";

/**
 * Speak (or choose a WAV file), get text back, review it, and put it into the description.
 *
 * Nothing touches the microphone or the network until the consent box is ticked. The audio
 * is held in memory only until it is sent; the server does not store it. Typing in the
 * description field always works, whatever happens here.
 */

export type TranscriptChoice = {
  /** The text the customer chose to use (after any edits here). */
  text: string;
  /** The text exactly as it came back. */
  original: string;
  /** Provider language code, or null for a demo-only selection. */
  sourceLanguage: string | null;
  mock: boolean;
  /** The server's signed proof for `original`; without it the save treats the text as typed. */
  provenance: string | null;
};

type Props = {
  projectId: string;
  mode: "mock" | "live";
  languages: VoiceLanguageOption[];
  maxSeconds: number;
  /** Upload time limit from the server: its provider timeout plus a margin. */
  uploadTimeoutMs: number;
  onUse: (choice: TranscriptChoice) => void;
};

const IDLE: CaptureState = { phase: "idle", elapsed: 0, error: null, result: null };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function VoiceCapture({ projectId, mode, languages, maxSeconds, uploadTimeoutMs, onUse }: Props) {
  const id = useId();
  const [consent, setConsent] = useState(false);
  const [language, setLanguage] = useState(languages[0]?.value ?? "");
  const [capture, setCapture] = useState<CaptureState>(IDLE);
  const [draft, setDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // What an upload sends, kept current from the event handlers (both are locked while busy).
  const sendWith = useRef({ language: languages[0]?.value ?? "", consent: false });
  const shownResult = useRef<CaptureResult | null>(null);
  const controllerRef = useRef<VoiceCaptureController | null>(null);

  // Unmounting stops the microphone, the audio context and any upload in flight.
  useEffect(() => () => controllerRef.current?.teardown(), []);

  const { phase, elapsed, error, result } = capture;
  const busy = phase === "starting" || phase === "recording" || phase === "sending";
  const hasDemoOption = languages.some((l) => l.demoOnly);

  /** The one controller for this screen, made on first use (in an event handler, never while rendering). */
  function controller(): VoiceCaptureController {
    controllerRef.current ??= new VoiceCaptureController({
      maxSeconds,
      uploadTimeoutMs,
      createRecorder: (options) => new WavRecorder(browserRecorderEnv(), options),
      transcribe: (audio, signal) => requestTranscription(projectId, { audio, ...sendWith.current, signal }),
      onChange: (next) => {
        if (next.result && next.result !== shownResult.current) setDraft(next.result.transcript);
        shownResult.current = next.result;
        setCapture(next);
      },
    });
    return controllerRef.current;
  }

  function changeConsent(value: boolean) {
    sendWith.current = { ...sendWith.current, consent: value };
    setConsent(value);
  }

  function changeLanguage(value: string) {
    sendWith.current = { ...sendWith.current, language: value };
    setLanguage(value);
  }

  function startRecording() {
    if (!consent) return;
    void controller().start();
  }

  function chooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // the same file can be chosen again
    if (!file || !consent) return;
    controller().sendFile(file);
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${id}-title`} className="text-lg font-semibold">
          Speak your description
        </h3>
        {mode === "mock" ? (
          <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm font-semibold text-warning-fg" data-testid="voice-mode-badge">
            Mock
          </span>
        ) : null}
      </div>
      {mode === "mock" ? (
        <Notice tone="warning" title="Mock voice input">
          <p>{MOCK_VOICE_NOTICE}</p>
        </Notice>
      ) : null}

      <label className="flex items-start gap-3">
        <input type="checkbox" checked={consent} onChange={(e) => changeConsent(e.target.checked)} disabled={busy} className="mt-1 size-5 accent-[var(--accent)]" />
        <span>{mode === "mock" ? VOICE_CONSENT_MOCK : VOICE_CONSENT_LIVE}</span>
      </label>

      <div>
        <label htmlFor={`${id}-language`} className="block text-sm font-medium">
          Language you will speak
        </label>
        <select id={`${id}-language`} value={language} onChange={(e) => changeLanguage(e.target.value)} disabled={busy} className={`${input} mt-1`}>
          {languages.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        {hasDemoOption ? <p className="mt-1 text-sm text-muted">{DEMO_LANGUAGE_NOTE}</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {phase === "starting" ? (
          <>
            <button type="button" className={buttonPrimary} disabled aria-busy="true">
              Starting the microphone…
            </button>
            <button type="button" className={buttonSecondary} onClick={() => controller().cancel()}>
              Cancel
            </button>
          </>
        ) : phase === "recording" ? (
          <>
            <button type="button" className={buttonPrimary} onClick={() => controller().stop()}>
              Stop and send
            </button>
            <button type="button" className={buttonSecondary} onClick={() => controller().cancel()}>
              Cancel
            </button>
            <p role="timer" aria-live="off" className="font-mono text-base">
              <span aria-hidden="true">● </span>
              {clock(elapsed)} / {clock(maxSeconds)}
            </p>
          </>
        ) : (
          <button type="button" className={buttonPrimary} onClick={startRecording} disabled={!consent || busy}>
            {result ? "Record again" : "Start recording"}
          </button>
        )}
        <button type="button" className={buttonSecondary} onClick={() => fileInput.current?.click()} disabled={!consent || busy}>
          Choose a WAV file
        </button>
        <input ref={fileInput} type="file" accept=".wav,audio/wav,audio/x-wav" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={chooseFile} disabled={!consent || busy} />
      </div>
      <p className="text-sm text-muted">
        Up to {maxSeconds} seconds. Recording stops by itself at the limit. Files must be mono 16-bit WAV.
        {!consent ? " Tick the box above to enable the microphone and file choice." : ""}
      </p>

      {phase === "sending" ? (
        <p role="status" className="text-sm">
          Turning your recording into text…
        </p>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert" title="Voice input did not work">
          <p>{error}</p>
        </Notice>
      ) : null}

      {result && phase === "result" ? (
        <div className="space-y-3">
          {result.mock ? (
            <Notice tone="warning" title="Mock transcript">
              <p>{MOCK_RESULT_NOTICE}</p>
            </Notice>
          ) : null}
          {result.truncated ? <p className="text-sm text-muted">The text was cut to fit the description field.</p> : null}
          <div>
            <label htmlFor={`${id}-transcript`} className="block text-sm font-medium">
              Transcript (you can edit it)
            </label>
            <textarea id={`${id}-transcript`} rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} className={`${input} mt-1`} />
          </div>
          <button
            type="button"
            className={buttonSecondary}
            disabled={draft.trim().length === 0}
            onClick={() => onUse({ text: draft.trim(), original: result.transcript, sourceLanguage: result.sourceLanguage, mock: result.mock, provenance: result.provenance })}
          >
            Use this text
          </button>
        </div>
      ) : null}
    </section>
  );
}
