import { z } from "zod";
import type { ProjectType } from "@/lib/db/schema";
import { JOURNEY_STEPS, type FieldIssue, type FieldSpec, type StepSpec } from "./steps";

/**
 * Turns the declarative step definitions into Zod checks and reads raw form input.
 * The same functions run in the browser (instant feedback) and on the server (the
 * only check that counts).
 */

export type StepData = Record<string, unknown>;

export type StepResult =
  | { ok: true; data: StepData }
  | { ok: false; errors: Record<string, string> };

function fieldSchema(field: FieldSpec): z.ZodType {
  switch (field.kind) {
    case "number": {
      let n = z.number({ error: "Enter a number." });
      if (field.integer) n = n.int("Enter a whole number.");
      n = n.min(field.min, `Enter ${field.min} or more.`).max(field.max, `Enter ${field.max} or less.`);
      return field.required ? n : n.optional();
    }
    case "text": {
      const s = z
        .string({ error: "Enter some text." })
        .trim()
        .min(field.min ?? 1, `Enter at least ${field.min ?? 1} characters.`)
        .max(field.max, `Keep this under ${field.max} characters.`);
      return field.required ? s : s.optional();
    }
    case "textarea": {
      const s = z.string({ error: "Enter some text." }).trim().max(field.max, `Keep this under ${field.max} characters.`);
      return field.required ? s.min(1, "This is required.") : s.optional();
    }
    case "select": {
      const values = field.options.map((o) => o.value) as [string, ...string[]];
      const e = z.enum(values, { error: "Choose one of the options." });
      return field.required ? e : e.optional();
    }
    case "checkbox":
      return z.boolean();
    case "checkboxes": {
      const values = field.options.map((o) => o.value) as [string, ...string[]];
      const a = z.array(z.enum(values, { error: "Choose from the options." }));
      return field.required ? a.min(1, "Choose at least one.") : a;
    }
  }
}

const schemaCache = new WeakMap<StepSpec, z.ZodObject>();

/** Unknown keys are rejected (strict), so a forged field never reaches the database. */
export function stepSchema(step: StepSpec): z.ZodObject {
  const cached = schemaCache.get(step);
  if (cached) return cached;
  const shape: Record<string, z.ZodType> = {};
  for (const f of step.fields) shape[f.name] = fieldSchema(f);
  const schema = z.strictObject(shape);
  schemaCache.set(step, schema);
  return schema;
}

/** Anything that behaves like FormData; keeps the reader testable without a browser. */
export type FormSource = { get(name: string): unknown; getAll(name: string): unknown[] };

/**
 * Reads one step's answers from a form. Empty text and number inputs become
 * "undefined" (not answered), checkboxes become booleans.
 */
export function readStepForm(step: StepSpec, form: FormSource): StepData {
  const out: StepData = {};
  for (const f of step.fields) {
    switch (f.kind) {
      case "checkbox":
        out[f.name] = form.get(f.name) !== null && form.get(f.name) !== undefined;
        break;
      case "checkboxes":
        out[f.name] = form.getAll(f.name).filter((v): v is string => typeof v === "string");
        break;
      case "number": {
        const raw = form.get(f.name);
        if (typeof raw !== "string" || raw.trim() === "") break;
        out[f.name] = Number(raw.trim());
        break;
      }
      default: {
        const raw = form.get(f.name);
        if (typeof raw !== "string") break;
        const trimmed = raw.trim();
        if (trimmed !== "") out[f.name] = trimmed;
      }
    }
  }
  return out;
}

function issuesToErrors(step: StepSpec, issues: readonly z.core.$ZodIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (issue.code === "unrecognized_keys") {
      errors._form = "That form contained a field we do not recognise.";
      continue;
    }
    const name = typeof key === "string" ? key : "_form";
    if (errors[name]) continue;
    const field = step.fields.find((f) => f.name === name);
    // A missing required value reports "received undefined"; say what to do instead.
    errors[name] = field && "required" in field && field.required && issue.code === "invalid_type"
      ? "This is required."
      : issue.message;
  }
  return errors;
}

export function validateStep(step: StepSpec, raw: StepData): StepResult {
  const parsed = stepSchema(step).safeParse(raw);
  const errors: Record<string, string> = parsed.success ? {} : issuesToErrors(step, parsed.error.issues);
  if (parsed.success && step.check) {
    for (const issue of step.check(parsed.data as StepData) as FieldIssue[]) {
      errors[issue.field] ??= issue.message;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, data: parsed.data as StepData };
}

export type RequirementsCheck =
  | { complete: true; requirements: Record<string, StepData> }
  | { complete: false; missingRequiredFields: string[] };

/**
 * Checks everything saved for a project against its journey. The result is built
 * from the stored answers only, so a stale or skipped step is reported, not guessed.
 */
export function validateRequirements(type: ProjectType, stored: unknown): RequirementsCheck {
  const source = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const requirements: Record<string, StepData> = {};
  const missing: string[] = [];
  for (const step of JOURNEY_STEPS[type]) {
    const raw = source[step.id];
    const rawObject = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as StepData) : {};
    const result = validateStep(step, { ...defaultsFor(step), ...rawObject });
    if (result.ok) {
      requirements[step.id] = result.data;
      continue;
    }
    for (const [name, message] of Object.entries(result.errors)) {
      const label = step.fields.find((f) => f.name === name)?.label ?? "Answers";
      missing.push(`${step.title}: ${label} (${message.replace(/\.$/, "").toLowerCase()})`);
    }
  }
  return missing.length > 0 ? { complete: false, missingRequiredFields: missing } : { complete: true, requirements };
}

/** Unticked checkboxes and empty lists are real answers, so absent ones are filled in. */
function defaultsFor(step: StepSpec): StepData {
  const d: StepData = {};
  for (const f of step.fields) {
    if (f.kind === "checkbox") d[f.name] = false;
    if (f.kind === "checkboxes" && !f.required) d[f.name] = [];
  }
  return d;
}
