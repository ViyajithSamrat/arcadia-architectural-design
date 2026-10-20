import type { ProjectStatus } from "@/lib/db/schema";

/**
 * Customer-facing wording for each workflow state (04_UI_UX.md section 4.6), and the
 * page that holds the next action. Text always accompanies any colour, and nothing
 * here implies a payment is verified or an asset is ready before the server says so.
 */
export type StatusInfo = {
  label: string;
  /** What the customer should do (or expect) next. */
  next: string;
  /** Where the next action lives, relative to /projects/<id>; null when there is none. */
  actionPath: "" | "/edit" | "/brief" | "/quote" | "/payment" | "/results" | null;
  actionLabel: string | null;
};

export const STATUS_INFO: Readonly<Record<ProjectStatus, StatusInfo>> = {
  DRAFT: {
    label: "Draft",
    next: "Answer the questions, then create your brief.",
    actionPath: "/edit",
    actionLabel: "Continue your answers",
  },
  TRANSCRIPT_READY: {
    label: "Draft",
    next: "Answer the questions, then create your brief.",
    actionPath: "/edit",
    actionLabel: "Continue your answers",
  },
  BRIEF_REVIEW: {
    label: "Brief ready to review",
    next: "Read the brief, edit it if needed, and approve it.",
    actionPath: "/brief",
    actionLabel: "Review your brief",
  },
  BRIEF_APPROVED: {
    label: "Brief approved",
    next: "Prepare your itemized quote.",
    actionPath: "/quote",
    actionLabel: "Go to your quote",
  },
  QUOTED: {
    label: "Quote ready",
    next: "Review the quote and accept it if you are happy with it.",
    actionPath: "/quote",
    actionLabel: "Review your quote",
  },
  AWAITING_PAYMENT: {
    label: "Quote accepted, awaiting payment",
    next: "Follow the payment instructions, then submit your transfer details for review. Nothing is verified until a person checks it.",
    actionPath: "/payment",
    actionLabel: "Go to payment",
  },
  PAYMENT_PROOF_SUBMITTED: {
    label: "Payment evidence submitted",
    next: "A person will check your transfer. Submission is not verification.",
    actionPath: "/payment",
    actionLabel: "View payment status",
  },
  PAYMENT_REJECTED: {
    label: "Payment evidence rejected",
    next: "The payment could not be confirmed. See the reason and submit again.",
    actionPath: "/payment",
    actionLabel: "See the reason and submit again",
  },
  PAYMENT_VERIFIED: {
    label: "Payment verified",
    next: "Design generation can begin. It has not started yet.",
    actionPath: null,
    actionLabel: null,
  },
  GENERATING: {
    label: "Designs being generated",
    next: "Your concepts are being prepared and will stay private until released.",
    actionPath: null,
    actionLabel: null,
  },
  GENERATION_FAILED: {
    label: "Generation needs attention",
    next: "Something went wrong preparing your concepts. The team will retry.",
    actionPath: null,
    actionLabel: null,
  },
  READY_FOR_REVIEW: {
    label: "Designs awaiting release",
    next: "Your concepts are ready and are being reviewed before release.",
    actionPath: null,
    actionLabel: null,
  },
  RELEASED: {
    label: "Designs released",
    next: "Your concepts have been released to your account.",
    actionPath: "/results",
    actionLabel: "View your concepts",
  },
  CANCELLED: {
    label: "Cancelled",
    next: "This project was cancelled.",
    actionPath: null,
    actionLabel: null,
  },
};

/** The stages shown in the progress bar, in order, with the first status that completes each. */
export const PROGRESS_STAGES = [
  { id: "answers", label: "Answers", doneFrom: "BRIEF_REVIEW" },
  { id: "brief", label: "Brief", doneFrom: "BRIEF_APPROVED" },
  { id: "quote", label: "Quote", doneFrom: "AWAITING_PAYMENT" },
  { id: "payment", label: "Payment", doneFrom: "PAYMENT_VERIFIED" },
] as const;

const ORDER: readonly ProjectStatus[] = [
  "DRAFT",
  "TRANSCRIPT_READY",
  "BRIEF_REVIEW",
  "BRIEF_APPROVED",
  "QUOTED",
  "AWAITING_PAYMENT",
  "PAYMENT_REJECTED",
  "PAYMENT_PROOF_SUBMITTED",
  "PAYMENT_VERIFIED",
  "GENERATING",
  "GENERATION_FAILED",
  "READY_FOR_REVIEW",
  "RELEASED",
];

/** A stage is complete once the project has reached its `doneFrom` status. */
export function stageState(status: ProjectStatus, stage: (typeof PROGRESS_STAGES)[number], index: number): "done" | "current" | "todo" {
  if (status === "CANCELLED") return "todo";
  const at = ORDER.indexOf(status);
  const doneAt = ORDER.indexOf(stage.doneFrom);
  if (at >= doneAt) return "done";
  const prevDone = index === 0 ? 0 : ORDER.indexOf(PROGRESS_STAGES[index - 1].doneFrom);
  return at >= prevDone ? "current" : "todo";
}
