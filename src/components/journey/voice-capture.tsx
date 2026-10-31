"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { VoiceLanguageOption } from "@/lib/journeys/voice";
import { VoiceCaptureController, type CaptureResult, type CaptureState } from "@/lib/voice/capture";
import { requestTranscription } from "@/lib/voice/client";
import { requestTranslation } from "@/lib/translation/client";
import { isEnglishLanguage } from "@/lib/translation/language";
import type { TranslationView } from "@/lib/translation/mode";
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
  /** Whether a non-English transcript can be translated automatically ("off" or "unavailable": typed only). */
  translation?: TranslationView;
  onUse: (choice: TranscriptChoice) => void;
};

/** The HTML lang value for a provider code such as "ta-IN", so screen readers and fonts pick the script. */
const htmlLang = (code: string | null) => (code ? code.split("-")[0] : undefined);

const IDLE: CaptureState = { phase: "idle", elapsed: 0, error: null, result: null };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function VoiceCapture({ projectId, mode, languages, maxSeconds, uploadTimeoutMs, translation = "off", onUse }: Props) {
  const id = useId();
  const [consent, setConsent] = useState(false);
  const [language, setLanguage] = useState(languages[0]?.value ?? "");
  const [capture, setCapture] = useState<CaptureState>(IDLE);
  const [draft, setDraft] = useState("");
  // The English version of a non-English transcript: a translation suggestion or the customer's own typing.
  const [english, setEnglish] = useState("");
  const [translatedFrom, setTranslatedFrom] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const translateAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // What an upload sends, kept current from the event handlers (both are locked while busy).
  const sendWith = useRef({ language: languages[0]?.value ?? "", consent: false });
  const shownResult = useRef<CaptureResult | null>(null);
  const controllerRef = useRef<VoiceCaptureController | null>(null);

  // Unmounting stops the microphone, the audio context and any upload or translation in flight.
  useEffect(
    () => () => {
      controllerRef.current?.teardown();
      translateAbort.current?.abort();
    },
    [],
  );

  const { phase, elapsed, error, result } = capture;
  const busy = phase === "starting" || phase === "recording" || phase === "sending" || translating;
  const hasDemoOption = languages.some((l) => l.demoOnly);
  // A real transcript in another language gets an English version before it becomes the description.
  const needsEnglish = result !== null && !result.mock && result.sourceLanguage !== null && !isEnglishLanguage(result.sourceLanguage);
  const languageLabel = languages.find((l) => l.sourceLanguage === result?.sourceLanguage)?.label ?? "the original language";

  async function translate(from: CaptureResult) {
    const text = draft.trim();
    if (!from.provenance || text.length === 0 || translating) return;
    translateAbort.current?.abort();
    const controller = new AbortController();
    translateAbort.current = controller;
    setTranslating(true);
    setTranslateError(null);
    const outcome = await requestTranslation(projectId, { text, original: from.transcript, provenance: from.provenance, signal: controller.signal });
    if (controller.signal.aborted || translateAbort.current !== controller) return;
    translateAbort.current = null;
    setTranslating(false);
    if (!outcome.ok) {
      setTranslateError(outcome.message);
      return;
    }
    setEnglish(outcome.english);
    setTranslatedFrom(text);
    setNumbers(outcome.numbersToCheck);
  }

  /** The one controller for this screen, made on first use (in an event handler, never while rendering). */
  function controller(): VoiceCaptureController {
    controllerRef.current ??= new VoiceCaptureController({
      maxSeconds,
      uploadTimeoutMs,
      createRecorder: (options) => new WavRecorder(browserRecorderEnv(), options),
      transcribe: (audio, signal) => requestTranscription(projectId, { audio, ...sendWith.current, signal }),
      onChange: (next) => {
        if (next.result && next.result !== shownResult.current) {
          // A new recording starts a new review: nothing from the previous one carries over.
          translateAbort.current?.abort();
          translateAbort.current = null;
          setTranslating(false);
          setDraft(next.result.transcript);
          setEnglish("");
          setTranslatedFrom(null);
          setNumbers([]);
          setTranslateError(null);
        }
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
          {needsEnglish ? (
            <div>
              <p className="text-sm font-medium">What the speech service heard (unchanged)</p>
              <p lang={htmlLang(result.sourceLanguage)} className="mt-1 whitespace-pre-wrap rounded-md border border-border p-3" data-testid="original-transcript">
                {result.transcript}
              </p>
            </div>
          ) : null}
          <div>
            <label htmlFor={`${id}-transcript`} className="block text-sm font-medium">
              {needsEnglish ? `Transcript in ${languageLabel} (correct any mistakes)` : "Transcript (you can edit it)"}
            </label>
            <textarea
              id={`${id}-transcript`}
              rows={5}
              lang={htmlLang(result.sourceLanguage)}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className={`${input} mt-1`}
            />
          </div>
          {needsEnglish ? (
            <EnglishVersion
              idPrefix={id}
              translation={translation}
              translating={translating}
              translateError={translateError}
              canTranslate={draft.trim().length > 0 && result.provenance !== null}
              stale={english.length > 0 && translatedFrom !== null && translatedFrom !== draft.trim()}
              numbers={numbers}
              english={english}
              onEnglish={setEnglish}
              onTranslate={() => void translate(result)}
              onUse={() => onUse({ text: english.trim(), original: result.transcript, sourceLanguage: result.sourceLanguage, mock: result.mock, provenance: result.provenance })}
            />
          ) : null}
          <button
            type="button"
            className={buttonSecondary}
            disabled={draft.trim().length === 0}
            onClick={() => onUse({ text: draft.trim(), original: result.transcript, sourceLanguage: result.sourceLanguage, mock: result.mock, provenance: result.provenance })}
          >
            {needsEnglish ? `Use the ${languageLabel} text instead` : "Use this text"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The English version of a non-English transcript. Automatic translation is a separate step the
 * customer asks for; its result is a labelled suggestion they correct before using it. When
 * translation is off, unavailable or fails, they type the English themselves.
 */
function EnglishVersion(props: {
  idPrefix: string;
  translation: TranslationView;
  translating: boolean;
  translateError: string | null;
  canTranslate: boolean;
  stale: boolean;
  numbers: string[];
  english: string;
  onEnglish: (value: string) => void;
  onTranslate: () => void;
  onUse: () => void;
}) {
  const { idPrefix, translation, translating, translateError, canTranslate, stale, numbers, english } = props;
  return (
    <section aria-labelledby={`${idPrefix}-english-title`} className="space-y-3 rounded-md border border-border p-3">
      <h4 id={`${idPrefix}-english-title`} className="font-semibold">
        English version for your brief
      </h4>
      {translation === "live" ? (
        <>
          <p className="text-sm text-muted">
            The speech service writes down what you said; it does not translate. Ask for an automatic English translation, then check and correct it.
          </p>
          <button type="button" className={buttonSecondary} onClick={props.onTranslate} disabled={!canTranslate || translating} aria-busy={translating}>
            {translating ? "Translating…" : english ? "Translate again" : "Translate to English"}
          </button>
        </>
      ) : (
        <p className="text-sm text-muted">
          {translation === "unavailable" ? "Automatic translation is unavailable right now." : "Automatic translation is not switched on."} Type the English
          version of your description below.
        </p>
      )}
      {translating ? (
        <p role="status" className="text-sm">
          Translating your transcript…
        </p>
      ) : null}
      {translateError ? (
        <Notice tone="danger" role="alert" title="Translation did not work">
          <p>{translateError}</p>
        </Notice>
      ) : null}
      {english && translation === "live" && !translateError ? (
        <Notice tone="info" title="Machine translation: please check it">
          <p>This English text was produced automatically and may contain mistakes. Correct anything that is wrong before you use it.</p>
          {numbers.length > 0 ? <p>Check these figures against what you said: {numbers.join(", ")}.</p> : null}
        </Notice>
      ) : null}
      {stale ? <p className="text-sm text-muted">You changed the transcript after it was translated. Translate again or edit the English below.</p> : null}
      <div>
        <label htmlFor={`${idPrefix}-english`} className="block text-sm font-medium">
          English text (you can edit it)
        </label>
        <textarea id={`${idPrefix}-english`} lang="en" rows={5} value={english} onChange={(e) => props.onEnglish(e.target.value)} className={`${input} mt-1`} />
      </div>
      <button type="button" className={buttonPrimary} disabled={english.trim().length === 0 || translating} onClick={props.onUse}>
        Use the English text
      </button>
    </section>
  );
}
