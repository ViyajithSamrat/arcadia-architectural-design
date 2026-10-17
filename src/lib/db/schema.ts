/**
 * Application-side mirror of the database vocabulary (supabase/migrations).
 *
 * The database is the source of truth; these constants exist so server code and
 * the UI use the same names. tests/unit/db-schema-constants.test.ts compares them
 * with the SQL migrations, so they cannot drift apart unnoticed.
 *
 * Replace the hand-written row types with generated ones (supabase gen types)
 * once the Supabase CLI is available.
 */

export const PROJECT_TYPES = ["EMPTY_PLOT", "INTERIOR", "LANDSCAPE"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_STATUSES = [
  "DRAFT",
  "TRANSCRIPT_READY",
  "BRIEF_REVIEW",
  "BRIEF_APPROVED",
  "QUOTED",
  "AWAITING_PAYMENT",
  "PAYMENT_PROOF_SUBMITTED",
  "PAYMENT_REJECTED",
  "PAYMENT_VERIFIED",
  "GENERATING",
  "GENERATION_FAILED",
  "READY_FOR_REVIEW",
  "RELEASED",
  "CANCELLED",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Allowed status transitions (03_APP_FLOW.md section 3.2); mirrors project_status_transitions. */
export const PROJECT_STATUS_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  DRAFT: ["TRANSCRIPT_READY", "BRIEF_REVIEW", "CANCELLED"],
  TRANSCRIPT_READY: ["BRIEF_REVIEW", "CANCELLED"],
  BRIEF_REVIEW: ["BRIEF_APPROVED", "CANCELLED"],
  BRIEF_APPROVED: ["QUOTED", "CANCELLED"],
  QUOTED: ["AWAITING_PAYMENT", "CANCELLED"],
  AWAITING_PAYMENT: ["PAYMENT_PROOF_SUBMITTED", "CANCELLED"],
  PAYMENT_PROOF_SUBMITTED: ["PAYMENT_VERIFIED", "PAYMENT_REJECTED"],
  PAYMENT_REJECTED: ["AWAITING_PAYMENT", "PAYMENT_PROOF_SUBMITTED", "CANCELLED"],
  // Cancelling after verification is intentionally absent: refund policy is deferred.
  PAYMENT_VERIFIED: ["GENERATING"],
  GENERATING: ["READY_FOR_REVIEW", "GENERATION_FAILED"],
  GENERATION_FAILED: ["GENERATING", "CANCELLED"],
  READY_FOR_REVIEW: ["RELEASED"],
  RELEASED: [],
  CANCELLED: [],
};

/** Convenience for the UI only. The database enforces the rule regardless. */
export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses in which a customer may still edit draft content. */
export const EDITABLE_PROJECT_STATUSES: readonly ProjectStatus[] = ["DRAFT", "TRANSCRIPT_READY", "BRIEF_REVIEW"];

export const PAYMENT_METHODS = ["UPI", "NETBANKING"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["PENDING_REVIEW", "VERIFIED", "REJECTED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const GENERATION_JOB_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number];

export const UPLOAD_ASSET_TYPES = ["REFERENCE", "PAYMENT_PROOF"] as const;
export const GENERATED_ASSET_TYPES = ["FLOOR_PLAN_SVG", "EXTERIOR_CONCEPT", "INTERIOR_CONCEPT", "LANDSCAPE_CONCEPT"] as const;
export const ASSET_TYPES = [...UPLOAD_ASSET_TYPES, ...GENERATED_ASSET_TYPES] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/**
 * The payment columns a customer's session may read. Selecting any other column
 * (verified_by, audit_note) or using select("*") is denied by the database, so
 * customer-facing code must always list columns explicitly with this constant.
 * Administrator screens read full rows through trusted server code.
 */
export const PAYMENT_CUSTOMER_COLUMNS =
  "id, project_id, quote_id, amount_claimed, currency, method, utr_reference, transfer_date, proof_storage_path, status, rejection_reason, confirmed_amount, verified_at, created_at, updated_at";

export type ProjectRow = {
  id: string;
  customer_id: string;
  project_type: ProjectType;
  status: ProjectStatus;
  source_language: string | null;
  transcript_original: string | null;
  transcript_corrected: string | null;
  requirements_json: Record<string, unknown>;
  english_brief_json: Record<string, unknown> | null;
  english_brief_text: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};
