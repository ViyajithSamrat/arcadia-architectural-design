"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { mockGatewayPayAction } from "@/app/(app)/projects/actions";
import { Notice } from "@/components/journey/notice";
import { buttonPrimary, buttonSecondary } from "@/components/journey/styles";

/**
 * The simulated payment gateway's checkout. It looks like a hosted checkout but is a
 * demonstration only: no money moves, nothing is collected (no card, UPI or bank details),
 * and the outcome buttons say what they simulate. Only "success" reaches the server, where it
 * records a payment claim that an administrator must still verify.
 */

type Outcome = { kind: "success"; reference: string } | { kind: "failed" } | { kind: "cancelled" } | { kind: "error"; message: string } | null;

export function MockCheckout({ projectId, amountLabel }: { projectId: string; amountLabel: string }) {
  const id = useId();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [pending, start] = useTransition();

  function open() {
    setOutcome(null);
    dialog.current?.showModal();
  }

  function close(next: Outcome) {
    dialog.current?.close();
    setOutcome(next);
  }

  function succeed() {
    start(async () => {
      const result = await mockGatewayPayAction(projectId);
      if (result && result.ok) {
        close({ kind: "success", reference: result.reference });
        router.refresh();
      } else {
        close({ kind: "error", message: result?.message ?? "The simulated payment could not be recorded." });
      }
    });
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          Pay with the demo gateway
        </h2>
        <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm font-semibold text-warning-fg">Simulation</span>
      </div>
      <p className="text-muted">
        A simulated online checkout for demonstrations. No real money moves and no payment details are asked for. A successful simulated payment is
        still checked by an administrator before any design work starts.
      </p>
      <button type="button" className={buttonPrimary} onClick={open} disabled={pending}>
        Pay {amountLabel} (simulated)
      </button>

      {outcome?.kind === "success" ? (
        <Notice tone="warning" role="status" title="Simulated payment recorded, waiting for verification">
          <p>
            Reference <span className="font-mono">{outcome.reference}</span>. This was a simulation: no money moved. An administrator still has to verify it.
          </p>
        </Notice>
      ) : outcome?.kind === "failed" ? (
        <Notice tone="danger" role="alert" title="Simulated payment failed">
          <p>The demo gateway simulated a failed payment. No money moved and nothing was recorded. You can try again.</p>
        </Notice>
      ) : outcome?.kind === "cancelled" ? (
        <Notice tone="info" role="status" title="Checkout cancelled">
          <p>Nothing was paid or recorded.</p>
        </Notice>
      ) : outcome?.kind === "error" ? (
        <Notice tone="danger" role="alert" title="The simulated payment was not recorded">
          <p>{outcome.message}</p>
        </Notice>
      ) : null}

      <dialog
        ref={dialog}
        aria-labelledby={`${id}-dialog-title`}
        onCancel={(e) => {
          if (pending) e.preventDefault();
          else setOutcome({ kind: "cancelled" });
        }}
        className="w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-[inherit] backdrop:bg-black/50"
      >
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 id={`${id}-dialog-title`} className="text-lg font-semibold">
              Demo checkout
            </h3>
            <span className="rounded-md bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning-fg">TEST MODE · NO REAL MONEY</span>
          </div>
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-muted">Paying</dt>
            <dd>Architectural AI Design (demo)</dd>
            <dt className="text-muted">Amount</dt>
            <dd className="font-semibold">{amountLabel}</dd>
          </dl>
          <p className="text-sm text-muted">Choose the outcome to simulate. Nothing is charged in any case.</p>
          <div className="flex flex-col gap-2">
            <button type="button" className={buttonPrimary} onClick={succeed} disabled={pending} aria-busy={pending}>
              {pending ? "Recording…" : "Simulate successful payment"}
            </button>
            <button type="button" className={buttonSecondary} onClick={() => close({ kind: "failed" })} disabled={pending}>
              Simulate failed payment
            </button>
            <button type="button" className={buttonSecondary} onClick={() => close({ kind: "cancelled" })} disabled={pending}>
              Cancel
            </button>
          </div>
        </div>
      </dialog>
    </section>
  );
}
