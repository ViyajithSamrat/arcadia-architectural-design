"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Notice } from "@/components/journey/notice";
import { buttonPrimary, fileInput, input } from "@/components/journey/styles";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_LABEL } from "@/lib/uploads/limits";

const MAX_BYTES = UPLOAD_MAX_BYTES;

type Errors = Record<string, string>;

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm font-medium text-danger-fg">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const describe = (id: string, hint: boolean, error?: string) => [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;

/**
 * The customer's payment details. Everything entered here is a claim for a person to
 * check; the server decides what is accepted and the browser never sends a status.
 * The size and type checks below only save a round trip: the server repeats them.
 */
export function PaymentForm({ projectId, defaultAmount, currency }: { projectId: string; defaultAmount: string; currency: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    data.set("projectId", projectId);

    const file = data.get("evidence");
    if (file instanceof File && file.size > MAX_BYTES) {
      setErrors({ evidence: `The image is larger than ${UPLOAD_MAX_LABEL}. Choose a smaller one.` });
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const response = await fetch("/api/payments", { method: "POST", body: data });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; message?: string; fieldErrors?: Errors; error?: { message?: string } } | null;
      if (response.ok && body?.ok) {
        router.refresh();
        return;
      }
      setErrors(body?.fieldErrors ?? {});
      setMessage(body?.message ?? body?.error?.message ?? "We could not submit your payment details. Please try again.");
    } catch {
      setMessage("We could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-5" aria-describedby="payment-form-note">
      <p id="payment-form-note" className="text-sm text-muted">
        Enter what you transferred. This is checked by a person; it is not verification. Never share a password, OTP or PIN.
      </p>

      <Field id="pay-utr" label="Transfer reference (UTR)" hint="From your bank or UPI app after the transfer." error={errors.utrReference}>
        <input id="pay-utr" name="utrReference" type="text" required maxLength={40} autoComplete="off" spellCheck={false} aria-invalid={errors.utrReference ? true : undefined} aria-describedby={describe("pay-utr", true, errors.utrReference)} className={`${input} mt-1`} />
      </Field>

      <Field id="pay-date" label="Transfer date" error={errors.transferDate}>
        <input id="pay-date" name="transferDate" type="date" required aria-invalid={errors.transferDate ? true : undefined} aria-describedby={describe("pay-date", false, errors.transferDate)} className={`${input} mt-1`} />
      </Field>

      <Field id="pay-amount" label={`Amount transferred (${currency})`} hint="Pre-filled with your quote total. Change it if you sent a different amount." error={errors.amount}>
        <input id="pay-amount" name="amount" type="text" inputMode="decimal" required defaultValue={defaultAmount} aria-invalid={errors.amount ? true : undefined} aria-describedby={describe("pay-amount", true, errors.amount)} className={`${input} mt-1`} />
      </Field>

      <Field id="pay-method" label="How did you pay?" error={errors.method}>
        <select id="pay-method" name="method" required defaultValue="" aria-invalid={errors.method ? true : undefined} aria-describedby={describe("pay-method", false, errors.method)} className={`${input} mt-1`}>
          <option value="" disabled>
            Choose…
          </option>
          <option value="UPI">UPI</option>
          <option value="NETBANKING">Net banking</option>
        </select>
      </Field>

      <Field id="pay-evidence" label="Receipt image (optional)" hint={`JPEG, PNG or WebP, up to ${UPLOAD_MAX_LABEL}. It stays private and is seen only by you and the reviewer.`} error={errors.evidence}>
        <input id="pay-evidence" name="evidence" type="file" accept="image/jpeg,image/png,image/webp" aria-invalid={errors.evidence ? true : undefined} aria-describedby={describe("pay-evidence", true, errors.evidence)} className={`mt-2 ${fileInput}`} />
      </Field>

      {message ? (
        <Notice tone="danger" role="alert" title={message}>
          {Object.keys(errors).length > 0 ? <p>Please check the fields marked above.</p> : null}
        </Notice>
      ) : null}

      <button type="submit" className={buttonPrimary} disabled={pending} aria-busy={pending}>
        {pending ? "Submitting…" : "Submit payment details for review"}
      </button>
    </form>
  );
}
