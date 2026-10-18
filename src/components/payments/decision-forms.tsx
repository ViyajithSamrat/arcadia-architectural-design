"use client";

import { useState, useTransition } from "react";
import { rejectPaymentAction, verifyPaymentAction, type DecisionState } from "@/app/(app)/admin/payments/actions";
import { Notice } from "@/components/journey/notice";
import { button, buttonPrimary, input } from "@/components/journey/styles";

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? (
    <p id={id} className="mt-1 text-sm font-medium text-danger-fg">
      <span aria-hidden="true">✕ </span>
      {text}
    </p>
  ) : null;
}

function Result({ state }: { state: DecisionState }) {
  return state && !state.ok ? <Notice tone="danger" role="alert" title={state.message}><p>Nothing was recorded.</p></Notice> : null;
}

/** Verify: the administrator types the amount actually received and confirms they checked the account. */
export function VerifyForm({ paymentId, totalLabel }: { paymentId: string; totalLabel: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<DecisionState>(undefined);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setState(undefined);
        start(async () =>
          setState(await verifyPaymentAction(paymentId, String(f.get("confirmedAmount") ?? ""), String(f.get("note") ?? ""), f.get("acknowledged") === "on")),
        );
      }}
    >
      <h3 className="text-lg font-semibold">Verify this payment</h3>
      <p className="text-sm text-muted">
        Only verify after you have seen the credit in the receiving account. The amount must equal the quoted total ({totalLabel}); if it does not, reject
        the payment instead.
      </p>
      <div>
        <label htmlFor="confirmedAmount" className="block text-sm font-medium">
          Amount received
        </label>
        <input id="confirmedAmount" name="confirmedAmount" inputMode="decimal" required autoComplete="off" aria-invalid={errors.confirmedAmount ? true : undefined} aria-describedby={errors.confirmedAmount ? "confirmedAmount-error" : undefined} className={`${input} mt-1`} />
        <FieldError id="confirmedAmount-error" text={errors.confirmedAmount} />
      </div>
      <div>
        <label htmlFor="verify-note" className="block text-sm font-medium">
          Internal note (optional, not shown to the customer)
        </label>
        <textarea id="verify-note" name="note" rows={2} maxLength={500} className={`${input} mt-1`} />
      </div>
      <label className="flex items-start gap-3">
        <input type="checkbox" name="acknowledged" required className="mt-1 size-5 accent-[var(--accent)]" />
        <span>I checked the receiving account and the full amount has arrived.</span>
      </label>
      <Result state={state} />
      <button type="submit" className={buttonPrimary} disabled={pending} aria-busy={pending}>
        {pending ? "Verifying…" : "Verify payment"}
      </button>
    </form>
  );
}

/** Reject: a reason is required and is shown to the customer. */
export function RejectForm({ paymentId }: { paymentId: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<DecisionState>(undefined);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setState(undefined);
        start(async () => setState(await rejectPaymentAction(paymentId, String(f.get("reason") ?? ""), String(f.get("note") ?? ""))));
      }}
    >
      <h3 className="text-lg font-semibold">Reject this payment</h3>
      <div>
        <label htmlFor="reason" className="block text-sm font-medium">
          Reason (shown to the customer)
        </label>
        <textarea id="reason" name="reason" rows={3} required maxLength={500} aria-invalid={errors.reason ? true : undefined} aria-describedby={errors.reason ? "reason-error" : undefined} className={`${input} mt-1`} />
        <FieldError id="reason-error" text={errors.reason} />
      </div>
      <div>
        <label htmlFor="reject-note" className="block text-sm font-medium">
          Internal note (optional, not shown to the customer)
        </label>
        <textarea id="reject-note" name="note" rows={2} maxLength={500} className={`${input} mt-1`} />
      </div>
      <Result state={state} />
      <button type="submit" className={`${button} border border-danger-fg text-danger-fg hover:bg-danger-bg`} disabled={pending} aria-busy={pending}>
        {pending ? "Rejecting…" : "Reject payment"}
      </button>
    </form>
  );
}
