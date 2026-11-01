import type { ProjectStatus } from "@/lib/db/schema";

/**
 * The customer's view of the way from payment to released concepts, for the results page
 * while nothing is released. Display only: it reads the project status and decides nothing.
 */
export const RELEASE_MILESTONES = [
  { id: "payment", label: "Payment", detail: "Pay and send your transfer details." },
  { id: "verification", label: "Verification", detail: "A person checks the transfer. Submitting is not verification." },
  { id: "generation", label: "Generation", detail: "Starts by itself once your payment is verified. Your concepts are drawn from your approved brief." },
  { id: "review", label: "Checks", detail: "The finished set is checked before it appears. Anything that cannot be checked automatically waits for a person." },
  { id: "release", label: "Ready", detail: "Your concepts and 2D drawing appear on this page." },
] as const;

export type MilestoneState = "done" | "current" | "problem" | "todo";

/** Where each status stands. Statuses before the quote is accepted, and CANCELLED, have no current milestone. */
const POSITION: Partial<Record<ProjectStatus, { current: number; problem?: true }>> = {
  AWAITING_PAYMENT: { current: 0 },
  PAYMENT_REJECTED: { current: 0, problem: true },
  PAYMENT_PROOF_SUBMITTED: { current: 1 },
  PAYMENT_VERIFIED: { current: 2 },
  GENERATING: { current: 2 },
  GENERATION_FAILED: { current: 2, problem: true },
  READY_FOR_REVIEW: { current: 3 },
  RELEASED: { current: RELEASE_MILESTONES.length },
};

export function milestoneStates(status: ProjectStatus): MilestoneState[] {
  const at = POSITION[status];
  return RELEASE_MILESTONES.map((_, i) => {
    if (!at) return "todo";
    if (i < at.current) return "done";
    if (i === at.current) return at.problem ? "problem" : "current";
    return "todo";
  });
}
