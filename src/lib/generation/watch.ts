import type { ProjectStatus } from "@/lib/db/schema";

/**
 * How often a customer's open page asks for the project's status while something is still
 * happening that does not need the customer: a person checking a payment, the queue starting,
 * images being drawn, a finished set being checked. Display only; the status is read, never set.
 */
const FAST_MS = 6_000;
/** Waiting on a person (payment review, a held release): the moment the customer is watching for, but it may take a while. */
const WAITING_MS = 10_000;
const HELD_MS = 15_000;

const INTERVALS: Partial<Record<ProjectStatus, number>> = {
  PAYMENT_PROOF_SUBMITTED: WAITING_MS,
  PAYMENT_VERIFIED: FAST_MS,
  GENERATING: FAST_MS,
  READY_FOR_REVIEW: HELD_MS,
};

/** Milliseconds between checks, or null when the status will not change by itself (nothing to watch). */
export function watchIntervalMs(status: ProjectStatus): number | null {
  return INTERVALS[status] ?? null;
}
