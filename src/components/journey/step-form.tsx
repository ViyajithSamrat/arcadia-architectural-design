"use client";

import Link from "next/link";
import { useId, useRef, useState, useTransition } from "react";
import { saveStepAction, type ActionState } from "@/app/(app)/projects/actions";
import type { ProjectType } from "@/lib/db/schema";
import { findStep, JOURNEY_STEPS, type FieldSpec } from "@/lib/journeys/steps";
import { readStepForm, validateStep, type StepData } from "@/lib/journeys/validation";
import type { VoiceView } from "@/lib/journeys/voice";
import type { TranslationView } from "@/lib/translation/mode";
import { containsMockTranscript } from "@/lib/providers/mock-speech";
import type { ReferenceView } from "@/lib/references/service";
import { MOCK_DESCRIPTION_REFUSED, MOCK_IN_DESCRIPTION_NOTICE } from "@/lib/voice/copy";
import { Notice } from "./notice";
import { ReferenceUploads } from "./reference-uploads";
import { buttonPrimary, buttonSecondary, input } from "./styles";
import { VoiceCapture, type TranscriptChoice } from "./voice-capture";

type Props = {
  projectId: string;
  projectType: ProjectType;
  stepId: string;
  /** Previously saved answers for this step. */
  initial: StepData;
  voice: VoiceView;
  /** Whether a non-English transcript can be translated automatically. Typing the English always works. */
  translation?: TranslationView;
  /** The project's reference photos, loaded by the page. Null when they could not be loaded. */
  references?: { items: ReferenceView[]; sentToImageService: boolean } | null;
};

/** A selectable tile around a checkbox: the whole row is the target, and the chosen state shows in the border and fill. */
const tile =
  "flex min-h-12 cursor-pointer items-center gap-3 rounded-[3px] border border-border bg-paper px-4 py-2.5 text-base transition-colors duration-200 hover:border-border-strong has-checked:border-accent has-checked:bg-success-bg/50 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent";

/** The description field a chosen transcript fills. */
const DESCRIPTION_FIELD = "text";

function Field({
  field,
  value,
  error,
  idPrefix,
}: {
  field: FieldSpec;
  value: unknown;
  error: string | undefined;
  idPrefix: string;
}) {
  const id = `${idPrefix}-${field.name}`;
  const hintId = field.hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const common = { id, name: field.name, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined };
  const required = "required" in field && field.required;

  const label = (
    <label htmlFor={id} className="block text-sm font-medium">
      {field.label}
      {required ? <span className="text-muted"> (required)</span> : null}
    </label>
  );
  const hint = field.hint ? (
    <p id={hintId} className="mt-1 text-sm text-muted">
      {field.hint}
    </p>
  ) : null;
  const err = error ? (
    <p id={errorId} className="mt-1 text-sm font-medium text-danger-fg">
      <span aria-hidden="true">✕ </span>
      {error}
    </p>
  ) : null;

  switch (field.kind) {
    case "number":
      return (
        <div>
          {label}
          <input
            {...common}
            type="number"
            inputMode={field.integer ? "numeric" : "decimal"}
            min={field.min}
            max={field.max}
            step={field.integer ? 1 : (field.step ?? "any")}
            defaultValue={typeof value === "number" ? value : ""}
            className={`${input} mt-1`}
          />
          {hint}
          {err}
        </div>
      );
    case "text":
      return (
        <div>
          {label}
          <input
            {...common}
            type="text"
            maxLength={field.max}
            defaultValue={typeof value === "string" ? value : ""}
            className={`${input} mt-1`}
          />
          {hint}
          {err}
        </div>
      );
    case "textarea":
      return (
        <div>
          {label}
          <textarea
            {...common}
            rows={field.rows ?? 4}
            maxLength={field.max}
            defaultValue={typeof value === "string" ? value : ""}
            className={`${input} mt-1`}
          />
          {hint}
          {err}
        </div>
      );
    case "select":
      return (
        <div>
          {label}
          <select {...common} defaultValue={typeof value === "string" ? value : ""} className={`${input} mt-1`}>
            {required ? (
              <option value="" disabled>
                Choose…
              </option>
            ) : (
              <option value="">Not specified</option>
            )}
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {hint}
          {err}
        </div>
      );
    case "checkbox":
      return (
        <div>
          <label className={tile}>
            <input
              type="checkbox"
              name={field.name}
              id={id}
              defaultChecked={value === true}
              className="size-5 shrink-0 accent-[var(--accent)]"
            />
            {field.label}
          </label>
          {hint}
          {err}
        </div>
      );
    case "checkboxes": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset aria-describedby={describedBy}>
          <legend className="text-sm font-medium">
            {field.label}
            {required ? <span className="text-muted"> (choose at least one)</span> : null}
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {field.options.map((o) => (
              <label key={o.value} className={tile}>
                <input
                  type="checkbox"
                  name={field.name}
                  value={o.value}
                  defaultChecked={selected.includes(o.value)}
                  className="size-5 shrink-0 accent-[var(--accent)]"
                />
                {o.label}
              </label>
            ))}
          </div>
          {hint}
          {err}
        </fieldset>
      );
    }
  }
}

export function StepForm({ projectId, projectType, stepId, initial, voice, translation = "off", references }: Props) {
  const step = findStep(projectType, stepId);
  const steps = JOURNEY_STEPS[projectType];
  const index = steps.findIndex((s) => s.id === stepId);
  const idPrefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<ActionState>(undefined);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  // The transcript chosen on this visit, saved with the description through the normal step save.
  const [transcript, setTranscript] = useState<TranscriptChoice | null>(null);
  const [mockInDescription, setMockInDescription] = useState(() => containsMockTranscript(initial[DESCRIPTION_FIELD]));

  if (!step) return null;

  function applyTranscript(choice: TranscriptChoice) {
    const field = formRef.current?.querySelector<HTMLTextAreaElement>(`textarea[name="${DESCRIPTION_FIELD}"]`);
    if (!field) return;
    field.value = choice.text;
    field.focus();
    setTranscript(choice);
    setMockInDescription(containsMockTranscript(choice.text));
  }

  /** Keeps the mock warning true to what the description holds now, as the customer types. */
  function onInput(event: React.FormEvent<HTMLFormElement>) {
    const target = event.target as HTMLTextAreaElement;
    if (step?.isDescription && target.name === DESCRIPTION_FIELD) setMockInDescription(containsMockTranscript(target.value));
  }
  const errors = { ...(state && !state.ok ? state.fieldErrors : undefined), ...clientErrors };
  const isLast = index === steps.length - 1;
  const previous = index > 0 ? steps[index - 1].id : null;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!step) return;
    const data = readStepForm(step, new FormData(event.currentTarget));
    // Quick feedback only; the server repeats both checks and is the one that counts.
    const result = validateStep(step, data);
    const found: Record<string, string> = result.ok ? {} : { ...result.errors };
    if (step.isDescription && containsMockTranscript(data[DESCRIPTION_FIELD])) found[DESCRIPTION_FIELD] = MOCK_DESCRIPTION_REFUSED;
    if (Object.keys(found).length > 0) {
      setState(undefined);
      setClientErrors(found);
      const first = step.fields.find((f) => found[f.name]);
      const target = first ? formRef.current?.querySelector<HTMLElement>(`[name="${first.name}"]`) : null;
      target?.focus();
      return;
    }
    setClientErrors({});
    // The transcript goes with the save only while the description is still exactly the text it
    // put there, and only with the server's provenance token (the server verifies it again).
    const voice =
      step.isDescription && transcript && transcript.provenance && data[DESCRIPTION_FIELD] === transcript.text
        ? { original: transcript.original, used: transcript.text, provenance: transcript.provenance }
        : undefined;
    start(async () => setState(await (voice ? saveStepAction(projectId, step.id, data, voice) : saveStepAction(projectId, step.id, data))));
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} onInput={onInput} noValidate className="space-y-6" aria-describedby={`${idPrefix}-intro`}>
      <div className="space-y-6">
        <ol aria-label="Steps of this project" className="flex gap-2">
          {steps.map((s, i) => (
            <li key={s.id} aria-current={i === index ? "step" : undefined} className="min-w-0 flex-1 space-y-2">
              <span
                aria-hidden="true"
                className={`block h-[3px] rounded-full transition-colors duration-500 ${i < index ? "bg-accent" : i === index ? "bg-sandstone" : "bg-border"}`}
              />
              <span className={`hidden text-xs leading-snug md:block ${i === index ? "font-semibold text-foreground" : "text-muted"}`}>{s.title}</span>
              <span className="sr-only md:hidden">
                {s.title}
                {i === index ? " (current)" : ""}
              </span>
            </li>
          ))}
        </ol>
        <div className="space-y-2">
          <p className="eyebrow">
            Step {index + 1} of {steps.length}
          </p>
          <h2 className="font-display text-4xl font-medium leading-tight">{step.title}</h2>
          <p id={`${idPrefix}-intro`} className="max-w-2xl text-muted">
            {step.intro}
          </p>
        </div>
      </div>

      {Object.keys(errors).length > 0 || (state && !state.ok) ? (
        <Notice tone="danger" role="alert" title={state && !state.ok ? state.message : "Please fix the highlighted answers."}>
          <p>Each problem is explained under its field.</p>
        </Notice>
      ) : null}

      {step.isDescription ? (
        voice.state === "mock" || voice.state === "live" ? (
          <VoiceCapture
            projectId={projectId}
            mode={voice.state}
            languages={voice.languages}
            maxSeconds={voice.maxSeconds}
            uploadTimeoutMs={voice.uploadTimeoutMs}
            translation={translation}
            onUse={applyTranscript}
          />
        ) : (
          <VoiceNotice voice={voice} />
        )
      ) : null}
      {step.isDescription && mockInDescription ? (
        <Notice tone="warning" role="status" title="Mock transcript in your description">
          <p>{MOCK_IN_DESCRIPTION_NOTICE}</p>
        </Notice>
      ) : null}
      {step.showsUploadNotice ? (
        references ? <ReferenceUploads projectId={projectId} items={references.items} sentToImageService={references.sentToImageService} /> : <UploadNotice />
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        {step.fields.map((field) => (
          <div
            key={field.name}
            className={field.kind === "textarea" || field.kind === "checkboxes" || field.kind === "checkbox" ? "sm:col-span-2" : undefined}
          >
            <Field field={field} value={initial[field.name]} error={errors[field.name]} idPrefix={idPrefix} />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <button type="submit" className={buttonPrimary} disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : isLast ? "Save and review your brief" : "Save and continue"}
        </button>
        {previous ? (
          <Link href={`/projects/${projectId}/edit?step=${previous}`} className={buttonSecondary}>
            Back
          </Link>
        ) : (
          <Link href={`/projects/${projectId}`} className={buttonSecondary}>
            Back to project
          </Link>
        )}
        <p className="text-sm text-muted">Your answers are saved to your account when you continue.</p>
      </div>
    </form>
  );
}

function VoiceNotice({ voice }: { voice: VoiceView }) {
  return voice.state === "unavailable" ? (
    <Notice tone="info" title="Voice input unavailable">
      <p>Speaking your description is unavailable right now. Typing works for the whole journey.</p>
    </Notice>
  ) : (
    <Notice tone="info" title="Voice input not configured">
      <p>Speaking your description is not available yet. Typing works for the whole journey.</p>
    </Notice>
  );
}

function UploadNotice() {
  return (
    <Notice tone="info" title="Photo uploads are unavailable right now">
      <p>Your photos could not be loaded just now. You can continue without them and describe your space in words instead, or reload the page to try again.</p>
    </Notice>
  );
}
