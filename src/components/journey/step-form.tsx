"use client";

import Link from "next/link";
import { useId, useRef, useState, useTransition } from "react";
import { saveStepAction, type ActionState } from "@/app/(app)/projects/actions";
import type { ProjectType } from "@/lib/db/schema";
import { findStep, JOURNEY_STEPS, type FieldSpec } from "@/lib/journeys/steps";
import { readStepForm, validateStep, type StepData } from "@/lib/journeys/validation";
import type { VoiceView } from "@/lib/journeys/voice";
import { containsMockTranscript } from "@/lib/providers/mock-speech";
import { MOCK_DESCRIPTION_REFUSED, MOCK_IN_DESCRIPTION_NOTICE } from "@/lib/voice/copy";
import { Notice } from "./notice";
import { buttonPrimary, buttonSecondary, input } from "./styles";
import { VoiceCapture, type TranscriptChoice } from "./voice-capture";

type Props = {
  projectId: string;
  projectType: ProjectType;
  stepId: string;
  /** Previously saved answers for this step. */
  initial: StepData;
  voice: VoiceView;
};

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
          <label className="flex min-h-11 items-center gap-3 text-base">
            <input
              type="checkbox"
              name={field.name}
              id={id}
              defaultChecked={value === true}
              className="size-5 accent-[var(--accent)]"
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
          <div className="mt-1 grid gap-x-6 sm:grid-cols-2">
            {field.options.map((o) => (
              <label key={o.value} className="flex min-h-11 items-center gap-3 text-base">
                <input
                  type="checkbox"
                  name={field.name}
                  value={o.value}
                  defaultChecked={selected.includes(o.value)}
                  className="size-5 accent-[var(--accent)]"
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

export function StepForm({ projectId, projectType, stepId, initial, voice }: Props) {
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
      <div className="space-y-1">
        <p className="text-sm text-muted">
          Step {index + 1} of {steps.length}
        </p>
        <h2 className="text-xl font-semibold">{step.title}</h2>
        <p id={`${idPrefix}-intro`} className="text-muted">
          {step.intro}
        </p>
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
      {step.showsUploadNotice ? <UploadNotice /> : null}

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

      <div className="flex flex-wrap items-center gap-3">
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
    <Notice tone="info" title="Uploads not configured yet">
      <p>
        Photo and floor-plan uploads are switched off until the accepted file types, size limit and private storage
        rules are confirmed. You can continue without them and describe your space in words instead.
      </p>
    </Notice>
  );
}
