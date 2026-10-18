"use client";

import { acceptQuoteAction, createBriefAction, createQuoteAction } from "@/app/(app)/projects/actions";
import { ActionButton } from "./action-button";

export function CreateBriefButton({ projectId, again = false }: { projectId: string; again?: boolean }) {
  return (
    <ActionButton
      action={() => createBriefAction(projectId)}
      pendingLabel="Creating brief…"
      variant={again ? "secondary" : "primary"}
    >
      {again ? "Create the brief again" : "Create my brief"}
    </ActionButton>
  );
}

export function CreateQuoteButton({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  return (
    <ActionButton action={() => createQuoteAction(projectId)} pendingLabel="Preparing quote…" disabled={disabled}>
      Prepare my quote
    </ActionButton>
  );
}

export function AcceptQuoteButton({ projectId, quoteId }: { projectId: string; quoteId: string }) {
  return (
    <ActionButton action={() => acceptQuoteAction(projectId, quoteId)} pendingLabel="Accepting…">
      Accept this quote
    </ActionButton>
  );
}
