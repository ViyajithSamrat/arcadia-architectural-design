"use client";

import { useState, useTransition } from "react";
import { publishPricingRuleAction, type PricingActionState } from "@/app/(app)/admin/pricing/actions";
import { Notice } from "@/components/journey/notice";
import { buttonPrimary, input } from "@/components/journey/styles";
import type { ProjectType } from "@/lib/db/schema";

/**
 * Publishes a new version of one pricing rule. It only asks the server: the server checks the
 * administrator role and every value, and the page then shows what is really in force.
 */

export type RuleDefaults = { rate: string; unit: string; minimumCharge: string; includedQuantity: string; currency: string };

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? (
    <p id={id} className="mt-1 text-sm font-medium text-danger-fg">
      <span aria-hidden="true">✕ </span>
      {text}
    </p>
  ) : null;
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      {children}
      <FieldError id={`${id}-error`} text={error} />
    </div>
  );
}

export function RuleForm({ projectType, ruleKey, isTax, defaults }: { projectType: ProjectType; ruleKey: string; isTax: boolean; defaults: RuleDefaults }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<PricingActionState>(undefined);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const id = (name: string) => `${projectType}-${ruleKey}-${name}`;
  const described = (name: string) => (errors[name] ? `${id(name)}-error` : undefined);
  const numberInput = (name: keyof RuleDefaults) => (
    <input
      id={id(name)}
      name={name}
      inputMode="decimal"
      required
      autoComplete="off"
      defaultValue={defaults[name]}
      aria-invalid={errors[name] ? true : undefined}
      aria-describedby={described(name)}
      className={`${input} mt-1`}
    />
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const value = (name: string) => String(f.get(name) ?? "").trim();
        const amount = (name: string) => (value(name) === "" ? Number.NaN : Number(value(name)));
        setState(undefined);
        start(async () => {
          const result = await publishPricingRuleAction(
              {
                projectType,
                ruleKey,
                rate: amount("rate"),
                unit: isTax ? "percent" : value("unit"),
                minimumCharge: isTax ? 0 : amount("minimumCharge"),
                includedQuantity: isTax ? 0 : amount("includedQuantity"),
                currency: value("currency").toUpperCase(),
              },
              f.get("confirm") === "on",
            );
          setState(result);
          // The confirmation applies to one publish only: never leave it ticked for the next one.
          if (result === undefined) form.reset();
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={id("rate")} label={isTax ? "Tax rate (percent)" : "Rate per unit"} hint={isTax ? "From 0 to 100, at most two decimals." : "At most two decimals."} error={errors.rate}>
          {numberInput("rate")}
        </Field>
        {isTax ? null : (
          <Field id={id("unit")} label="Unit" hint="For example floor, view, room or sq ft." error={errors.unit}>
            <input id={id("unit")} name="unit" required maxLength={24} autoComplete="off" defaultValue={defaults.unit} aria-invalid={errors.unit ? true : undefined} aria-describedby={described("unit")} className={`${input} mt-1`} />
          </Field>
        )}
        {isTax ? null : (
          <Field id={id("minimumCharge")} label="Minimum charge" hint="The line never costs less than this." error={errors.minimumCharge}>
            {numberInput("minimumCharge")}
          </Field>
        )}
        {isTax ? null : (
          <Field id={id("includedQuantity")} label="Included quantity" hint="Units included before the rate applies." error={errors.includedQuantity}>
            {numberInput("includedQuantity")}
          </Field>
        )}
        <Field id={id("currency")} label="Currency code" hint="Three capital letters. Every rate of a project type uses the same currency." error={errors.currency}>
          <input id={id("currency")} name="currency" required maxLength={3} autoComplete="off" defaultValue={defaults.currency} aria-invalid={errors.currency ? true : undefined} aria-describedby={described("currency")} className={`${input} mt-1 uppercase`} />
        </Field>
      </div>
      <div>
        <label className="flex items-start gap-3">
          <input type="checkbox" name="confirm" required className="mt-1 size-5 accent-[var(--accent)]" aria-describedby={described("confirm")} />
          <span>I understand that new quotes will use this value from now on. Quotes already accepted do not change.</span>
        </label>
        <FieldError id={`${id("confirm")}-error`} text={errors.confirm} />
      </div>
      {state && !state.ok ? (
        <Notice tone="danger" role="alert" title={state.message}>
          <p>Nothing was saved.</p>
        </Notice>
      ) : null}
      <button type="submit" className={buttonPrimary} disabled={pending} aria-busy={pending}>
        {pending ? "Publishing…" : "Publish new version"}
      </button>
    </form>
  );
}
