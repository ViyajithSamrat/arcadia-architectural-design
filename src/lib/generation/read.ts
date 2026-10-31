import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GENERATED_ASSET_TYPES, type AssetType, type ProjectStatus, type ProjectType } from "@/lib/db/schema";
import { getOwnedProject } from "@/lib/journeys/service";
import { PROJECT_FILES_BUCKET } from "@/lib/storage/paths";
import { describeFloorPlan, type FloorPlanView } from "./floor-plan";
import { isMockJob, isStaleJob } from "./service";

/**
 * What the generation screens read. Everything here is a read: no write, no provider call.
 *
 * Administrator reads use the administrator's OWN session, so row level security and the
 * storage policies decide what is visible (they allow administrators to read jobs, assets
 * and unreleased files). Customer reads use the customer's own session and add a server-side
 * check that the project is RELEASED before anything about a file is returned.
 *
 * Storage paths never leave this module: callers receive short-lived signed links only, and
 * only for files that are allowed to be shown.
 */

type Client = SupabaseClient;

export const PREVIEW_URL_SECONDS = 60;
export const RESULT_URL_SECONDS = 300;

const GENERATED_TYPES: readonly string[] = GENERATED_ASSET_TYPES;

export const ASSET_LABELS: Readonly<Record<string, string>> = {
  EXTERIOR_CONCEPT: "Exterior concept",
  INTERIOR_CONCEPT: "Interior concept",
  LANDSCAPE_CONCEPT: "Landscape concept",
  FLOOR_PLAN_SVG: "Floor plan sketch",
};

// ---------------------------------------------------------------------------
// The state of a project's generation, decided by the server from database rows
// ---------------------------------------------------------------------------

export type JobView = {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  provider: string;
  promptVersion: string;
  attemptCount: number;
  errorCode: string | null;
  errorSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  mock: boolean;
};

export type GenerationPhase =
  | "not_ready" // before payment is verified, or cancelled
  | "can_start" // PAYMENT_VERIFIED or GENERATION_FAILED, nothing left behind
  | "blocked_leftovers" // would start, but earlier files are still attached
  | "starting" // GENERATING, no job yet, only just claimed
  | "can_resume" // GENERATING, no job, claimed long ago
  | "running" // an active job, recently active
  | "stale_job" // an active job that has made no progress for ten minutes
  | "can_finalize" // the job succeeded but the project was not advanced
  | "ready_for_review"
  | "released";

export type PhaseInput = {
  status: ProjectStatus;
  updatedAt: string | null;
  jobs: { id: string; status: string; created_at: string | null; started_at?: string | null }[];
  assets: { generation_job_id: string | null }[];
  now: number;
};

export type PhaseResult = {
  phase: GenerationPhase;
  /** Why a release cannot go ahead, in words an administrator can act on. Empty when none. */
  releaseBlockers: string[];
};

const RESUME_AFTER_MS = 60_000;

/**
 * The single place that decides which action the screen offers. It is advice for the
 * screen only: every action re-checks all of this on the server.
 */
export function describeGeneration(input: PhaseInput): PhaseResult {
  const { status, jobs, assets, now } = input;
  const active = jobs.find((j) => j.status === "QUEUED" || j.status === "RUNNING");
  const succeeded = new Map(jobs.filter((j) => j.status === "SUCCEEDED").map((j) => [j.id, j]));
  const leftover = assets.filter((a) => a.generation_job_id !== null && !succeeded.has(a.generation_job_id));

  const releaseBlockers: string[] = [];
  if (status === "READY_FOR_REVIEW") {
    if (active) releaseBlockers.push("A generation job is still running.");
    if (succeeded.size === 0 || assets.length === 0) releaseBlockers.push("There are no generated files to release.");
    if (leftover.length > 0) releaseBlockers.push("Files from a failed or unfinished attempt are still attached to this project.");
  }

  switch (status) {
    case "RELEASED":
      return { phase: "released", releaseBlockers: [] };
    case "READY_FOR_REVIEW":
      return { phase: "ready_for_review", releaseBlockers };
    case "PAYMENT_VERIFIED":
    case "GENERATION_FAILED":
      return { phase: assets.length > 0 ? "blocked_leftovers" : "can_start", releaseBlockers: [] };
    case "GENERATING": {
      if (active) return { phase: isStaleJob(active, now) ? "stale_job" : "running", releaseBlockers: [] };
      if (succeeded.size > 0) return { phase: "can_finalize", releaseBlockers: [] };
      const since = Date.parse(input.updatedAt ?? "");
      return { phase: Number.isFinite(since) && now - since >= RESUME_AFTER_MS ? "can_resume" : "starting", releaseBlockers: [] };
    }
    default:
      return { phase: "not_ready", releaseBlockers: [] };
  }
}

export const PHASE_TEXT: Readonly<Record<GenerationPhase, { label: string; detail: string }>> = {
  not_ready: { label: "Not ready", detail: "Generation can start only after an administrator has verified the payment." },
  can_start: { label: "Ready to generate", detail: "The payment is verified. Nothing has been generated yet." },
  blocked_leftovers: { label: "Needs clearing", detail: "Earlier generated files are still attached, so a new run is blocked until they are cleared." },
  starting: { label: "Starting", detail: "Generation was just claimed. Wait a minute and reload." },
  can_resume: { label: "Interrupted before it began", detail: "Generation was claimed but no job was created. It can be started again." },
  running: { label: "Generating", detail: "A job is running. Reload to see its result." },
  stale_job: { label: "Interrupted", detail: "A job made no progress for over ten minutes and is considered abandoned." },
  can_finalize: { label: "Finished, not yet moved to review", detail: "The images were created but the project was not advanced. Finishing is safe to repeat." },
  ready_for_review: { label: "Awaiting release", detail: "Review the images, then release them. Nothing is visible to the customer yet." },
  released: { label: "Released", detail: "The customer can see these images." },
};

// ---------------------------------------------------------------------------
// Administrator reads
// ---------------------------------------------------------------------------

type ProjectRow = { id: string; customer_id: string; project_type: ProjectType; status: ProjectStatus; created_at: string; updated_at: string; requirements_json?: unknown };
type JobRow = {
  id: string;
  project_id: string;
  status: JobView["status"];
  provider: string;
  prompt_version: string;
  attempt_count: number;
  error_code: string | null;
  error_summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  usage_json: { mock?: boolean } | null;
};
type AssetRow = {
  id: string;
  project_id: string;
  generation_job_id: string | null;
  asset_type: AssetType;
  width: number | null;
  height: number | null;
  is_released: boolean;
  storage_path: string;
};

const QUEUE_STATUSES = ["PAYMENT_VERIFIED", "GENERATING", "GENERATION_FAILED", "READY_FOR_REVIEW", "RELEASED"] as const;
const QUEUE_LIMIT = 50;

const toJobView = (j: JobRow): JobView => ({
  id: j.id,
  status: j.status,
  provider: j.provider,
  promptVersion: j.prompt_version,
  attemptCount: j.attempt_count,
  errorCode: j.error_code,
  errorSummary: j.error_summary,
  createdAt: j.created_at,
  startedAt: j.started_at,
  completedAt: j.completed_at,
  durationMs: j.duration_ms,
  mock: isMockJob(j),
});

export type QueueRow = {
  projectId: string;
  projectType: ProjectType;
  status: ProjectStatus;
  customerId: string;
  updatedAt: string;
  phase: GenerationPhase;
  jobCount: number;
  assetCount: number;
};

/**
 * Projects that are paid or further along, newest activity first. Three reads in total
 * however many projects there are (no per-row queries): the projects, then their jobs and
 * generated assets together.
 */
export async function listGenerationQueue(supabase: Client, now: number = Date.now()): Promise<QueueRow[]> {
  const { data: projectData, error } = await supabase
    .from("projects")
    .select("id, customer_id, project_type, status, created_at, updated_at")
    .in("status", [...QUEUE_STATUSES])
    .order("updated_at", { ascending: false })
    .limit(QUEUE_LIMIT);
  if (error || !projectData) return [];
  const projects = projectData as ProjectRow[];
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);

  const [{ data: jobData }, { data: assetData }] = await Promise.all([
    supabase.from("generation_jobs").select("id, project_id, status, created_at, started_at").in("project_id", ids),
    supabase.from("design_assets").select("id, project_id, generation_job_id").in("project_id", ids).not("generation_job_id", "is", null),
  ]);
  const jobs = (jobData ?? []) as Pick<JobRow, "id" | "project_id" | "status" | "created_at" | "started_at">[];
  const assets = (assetData ?? []) as Pick<AssetRow, "id" | "project_id" | "generation_job_id">[];

  return projects.map((p) => {
    const mine = jobs.filter((j) => j.project_id === p.id);
    const files = assets.filter((a) => a.project_id === p.id);
    const { phase } = describeGeneration({ status: p.status, updatedAt: p.updated_at, jobs: mine, assets: files, now });
    return { projectId: p.id, projectType: p.project_type, status: p.status, customerId: p.customer_id, updatedAt: p.updated_at, phase, jobCount: mine.length, assetCount: files.length };
  });
}

export type PreviewAsset = { id: string; label: string; width: number | null; height: number | null; url: string | null; released: boolean };

export type GenerationDetail = {
  projectId: string;
  projectType: ProjectType;
  status: ProjectStatus;
  customerId: string;
  updatedAt: string;
  phase: GenerationPhase;
  releaseBlockers: string[];
  jobs: JobView[];
  /** Files from the succeeded job, with short-lived preview links. Never files of a failed attempt. */
  previews: PreviewAsset[];
  /** How many generated files belong to a job that did not succeed. */
  leftoverCount: number;
  /** True when a succeeded job was produced by the mock generator. */
  mock: boolean;
  /**
   * The empty-plot layout sketch, drawn on demand from the saved answers (nothing is stored).
   * Only when previews are allowed (READY_FOR_REVIEW or RELEASED); null otherwise and for other types.
   */
  floorPlan: FloorPlanView | null;
};

/**
 * One project's generation state for the administrator. Preview links are created only when
 * the project is READY_FOR_REVIEW or RELEASED and only for files of a SUCCEEDED job, using the
 * administrator's own session (the storage policy lets administrators preview unreleased files).
 */
export async function getGenerationDetail(supabase: Client, projectId: string, now: number = Date.now()): Promise<GenerationDetail | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return null;
  const { data: projectData, error } = await supabase
    .from("projects")
    .select("id, customer_id, project_type, status, created_at, updated_at, requirements_json")
    .eq("id", projectId)
    .maybeSingle();
  if (error || !projectData) return null;
  const project = projectData as ProjectRow;

  const [{ data: jobData }, { data: assetData }] = await Promise.all([
    supabase.from("generation_jobs").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    supabase
      .from("design_assets")
      .select("id, project_id, generation_job_id, asset_type, width, height, is_released, storage_path")
      .eq("project_id", projectId)
      .not("generation_job_id", "is", null)
      .order("created_at", { ascending: true }),
  ]);
  const jobRows = (jobData ?? []) as JobRow[];
  const assets = ((assetData ?? []) as AssetRow[]).filter((a) => GENERATED_TYPES.includes(a.asset_type));

  const { phase, releaseBlockers } = describeGeneration({ status: project.status, updatedAt: project.updated_at, jobs: jobRows, assets, now });
  const succeeded = new Set(jobRows.filter((j) => j.status === "SUCCEEDED").map((j) => j.id));
  const good = assets.filter((a) => a.generation_job_id !== null && succeeded.has(a.generation_job_id));
  const mayPreview = project.status === "READY_FOR_REVIEW" || project.status === "RELEASED";

  const previews: PreviewAsset[] = await Promise.all(
    good.map(async (a) => {
      let url: string | null = null;
      if (mayPreview) {
        const signed = await supabase.storage.from(PROJECT_FILES_BUCKET).createSignedUrl(a.storage_path, PREVIEW_URL_SECONDS);
        url = signed.error || !signed.data ? null : signed.data.signedUrl;
      }
      return { id: a.id, label: ASSET_LABELS[a.asset_type] ?? "Concept", width: a.width, height: a.height, url, released: a.is_released };
    }),
  );

  return {
    projectId: project.id,
    projectType: project.project_type,
    status: project.status,
    customerId: project.customer_id,
    updatedAt: project.updated_at,
    phase,
    releaseBlockers,
    jobs: jobRows.map(toJobView),
    previews,
    leftoverCount: assets.length - good.length,
    mock: jobRows.some((j) => j.status === "SUCCEEDED" && isMockJob(j)),
    floorPlan: mayPreview ? describeFloorPlan(project.project_type, project.requirements_json) : null,
  };
}

// ---------------------------------------------------------------------------
// Customer reads
// ---------------------------------------------------------------------------

/** `url` shows the image; `downloadUrl` is the same file as a saved download (null when that link could not be made). */
export type ReleasedAsset = { id: string; label: string; width: number | null; height: number | null; url: string; downloadUrl: string | null };

/** A plain file name for a saved copy, such as "exterior-concept-1.png": letters, digits and hyphens only. */
function downloadName(label: string, position: number, storagePath: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "concept";
  const extension = /\.(png|jpe?g|webp)$/i.exec(storagePath)?.[1]?.toLowerCase() ?? "png";
  return `${slug}-${position + 1}.${extension}`;
}

export type CustomerResults =
  | { state: "not_found" }
  /** Anything but RELEASED: only the status, never a file, a path or a link. */
  | { state: "pending"; status: ProjectStatus }
  | { state: "released"; assets: ReleasedAsset[]; unavailable: number; floorPlan: FloorPlanView | null };

/**
 * The customer's results. The owner is checked first; then, unless the project is RELEASED,
 * nothing about any file is read or returned. Only assets the database marks released are
 * listed (the row level security policy hides the rest), and each file is reached through a
 * short-lived link created with the customer's own session, which Storage allows only for
 * released files of the customer's own project. The empty-plot layout sketch follows the same
 * rule: it is drawn from the owner's saved answers only once the project is RELEASED.
 */
/** Which released images are mock. "unknown" when it could not be established; the screen then uses wording that covers both. */
export type ReleasedProvenance = { state: "known"; mockAssetIds: string[] } | { state: "unknown" };

/**
 * Read only, for the customer's results page. Customers cannot read generation jobs (admin-only
 * policy), so the mock marker is looked up with the trusted client, but only for the jobs of images
 * the customer's OWN session can already see: ownership, RELEASED and the asset list all come from
 * `supabase` under row level security. It returns a yes/no per visible image and nothing else, and
 * uses the same isMockJob rule as release. It changes nothing and grants no access.
 */
export async function getReleasedImageProvenance(supabase: Client, service: Client | null, userId: string, projectId: string): Promise<ReleasedProvenance> {
  if (!service) return { state: "unknown" };
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project || project.status !== "RELEASED") return { state: "unknown" };
  const { data: assetData, error: assetError } = await supabase
    .from("design_assets")
    .select("id, generation_job_id")
    .eq("project_id", project.id)
    .eq("is_released", true)
    .not("generation_job_id", "is", null);
  if (assetError || !assetData) return { state: "unknown" };
  const assets = assetData as { id: string; generation_job_id: string }[];
  if (assets.length === 0) return { state: "known", mockAssetIds: [] };
  const jobIds = [...new Set(assets.map((a) => a.generation_job_id))];
  const { data: jobData, error: jobError } = await service.from("generation_jobs").select("id, provider, usage_json").eq("project_id", project.id).in("id", jobIds);
  if (jobError || !jobData) return { state: "unknown" };
  const jobs = new Map((jobData as { id: string; provider: string | null; usage_json: unknown }[]).map((j) => [j.id, j]));
  // Every visible image must have its job, or nothing is claimed either way.
  if (jobIds.some((id) => !jobs.has(id))) return { state: "unknown" };
  return { state: "known", mockAssetIds: assets.filter((a) => isMockJob(jobs.get(a.generation_job_id)!)).map((a) => a.id) };
}

export async function getCustomerResults(supabase: Client, userId: string, projectId: string): Promise<CustomerResults> {
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return { state: "not_found" };
  if (project.status !== "RELEASED") return { state: "pending", status: project.status };
  const floorPlan = describeFloorPlan(project.project_type, project.requirements_json);

  const { data, error } = await supabase
    .from("design_assets")
    .select("id, asset_type, width, height, is_released, generation_job_id, storage_path")
    .eq("project_id", project.id)
    .eq("is_released", true)
    .not("generation_job_id", "is", null)
    .order("created_at", { ascending: true });
  if (error || !data) return { state: "released", assets: [], unavailable: 0, floorPlan };

  const rows = (data as Pick<AssetRow, "id" | "asset_type" | "width" | "height" | "is_released" | "generation_job_id" | "storage_path">[]).filter(
    (a) => a.is_released === true && GENERATED_TYPES.includes(a.asset_type),
  );
  const linked = await Promise.all(
    rows.map(async (a, position) => {
      const label = ASSET_LABELS[a.asset_type] ?? "Concept";
      const bucket = supabase.storage.from(PROJECT_FILES_BUCKET);
      // Two links to the same released file, both made with the customer's own session (so Storage applies
      // the same ownership and release rules): one to show it, one that tells the browser to save it.
      const [view, save] = await Promise.all([
        bucket.createSignedUrl(a.storage_path, RESULT_URL_SECONDS),
        bucket.createSignedUrl(a.storage_path, RESULT_URL_SECONDS, { download: downloadName(label, position, a.storage_path) }),
      ]);
      if (view.error || !view.data) return null;
      return { id: a.id, label, width: a.width, height: a.height, url: view.data.signedUrl, downloadUrl: save.error || !save.data ? null : save.data.signedUrl } satisfies ReleasedAsset;
    }),
  );
  const assets = linked.filter((a): a is ReleasedAsset => a !== null);
  return { state: "released", assets, unavailable: rows.length - assets.length, floorPlan };
}
