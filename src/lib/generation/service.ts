import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/auth/guards";
import type { ProjectType } from "@/lib/db/schema";
import { getProviderTimeoutMs } from "@/lib/providers/config";
import { loadReferenceInputs } from "./references";
import { withUsage } from "@/lib/providers/budget";
import { ImageProviderUnavailableError, validateImageOutputs, withTimeout, type ImageGenerationProvider, type ImageGenerationResult } from "@/lib/providers/images";
import { ProviderError, type ProviderHooks } from "@/lib/providers/interfaces";
import { buildObjectPath, newObjectName, PROJECT_FILES_BUCKET } from "@/lib/storage/paths";
import { getImageProvider } from "./provider";
import { buildImageRequest, getMaxGenerationImages } from "./prompt";

/**
 * Admin-started generation (Phase 6A: the provider is a labelled MOCK).
 *
 * Authorization is layered; nothing here trusts the browser:
 *  1. requireAdmin runs on the caller's OWN session and asks the database (public.is_admin()).
 *  2. Trusted writes then use the service client, because only trusted server code may write
 *     generated files and jobs. The database independently enforces what matters: a job can
 *     exist only while the project is GENERATING with a VERIFIED payment for the accepted
 *     quote; one active job per project; READY_FOR_REVIEW needs a succeeded job and assets;
 *     assets are never created released; only admin_release_project releases.
 *  3. The admin's identity is recorded in an audit event, because the service role carries no
 *     auth.uid() for the automatic audit triggers.
 *
 * There is no database transaction across storage and tables, so the order is: claim the
 * project (conditional update, so concurrent requests cannot both proceed), create the job,
 * run the provider ONCE (no retries, no fallback), validate the output, store files, record
 * unreleased assets, then mark the job and project. Any failure after the claim marks the job
 * FAILED, removes what was written and moves the project to GENERATION_FAILED, from where an
 * administrator can try again with a new key.
 *
 * Known limits: a process that dies mid-run leaves a RUNNING job (the one-active-job rule then
 * blocks the project until an administrator clears it by hand), and failed cleanup leaves
 * unreleased files that block a retry. Both fail safe. See docs/PROVIDERS.md.
 *
 * A request whose job was cleared as stale may still be running. It cannot finish (its job is
 * no longer RUNNING) and it never moves the project, because a newer run may own it by then;
 * it only removes its own files. Its file rows go through insert_generated_asset(), which locks
 * the job row and refuses unless the job is RUNNING, so a request cleared as stale cannot attach
 * a file to its FAILED job; it removes the object it uploaded. Limit: that closes the application's
 * write path only; the design_assets trigger still allows a direct service-role insert on a FAILED
 * job, and releaseProject refuses such files.
 */

type Client = SupabaseClient;

export type GenerationCode =
  | "bad_request"
  | "not_found"
  | "not_eligible"
  | "in_progress"
  | "brief_invalid"
  | "limit"
  | "provider_unavailable"
  | "reservation_refused"
  | "failed"
  | "finalize_failed";

export type GenerationResult =
  | { ok: true; jobId: string; assetIds: string[]; replayed: boolean; mock: boolean }
  | { ok: false; code: GenerationCode; message: string };

const fail = (code: GenerationCode, message: string): GenerationResult => ({ ok: false, code, message });

const GENERIC = "Generation could not be completed. The project can be retried by an administrator.";
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const START_STATUSES = ["PAYMENT_VERIFIED", "GENERATION_FAILED"];
/**
 * A project in GENERATING with no job is resumed only after it has sat that way this long.
 * Sooner, another request is probably between claiming the project and creating its job, and
 * resuming then could run the provider twice.
 */
const RESUME_AFTER_MS = 60_000;

type ProjectRow = {
  id: string;
  customer_id: string;
  status: string;
  project_type: ProjectType;
  english_brief_json: unknown;
  english_brief_text: string | null;
  updated_at: string | null;
};
type JobRow = { id: string; status: string; idempotency_key: string | null };

/** One line per step with identifiers and codes only: never a prompt, brief text or key. */
function log(event: string, fields: Record<string, string | number | boolean | null>) {
  console.info(JSON.stringify({ event: `generation.${event}`, at: new Date().toISOString(), ...fields }));
}

async function moveProject(service: Client, projectId: string, from: string, to: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const { data, error } = await service.from("projects").update({ status: to }).eq("id", projectId).eq("status", from).select("id");
  if (error) return { ok: false, code: (error as { code?: string }).code ?? "db" };
  if (!data || data.length !== 1) return { ok: false, code: "lost" };
  return { ok: true };
}

/** The one definition of mock output, used by release and by the screens. */
export function isMockJob(job: { provider?: string | null; usage_json?: unknown }): boolean {
  const usage = job.usage_json as { mock?: unknown } | null | undefined;
  return job.provider === "mock" || usage?.mock === true;
}

async function assetIdsOf(service: Client, jobId: string): Promise<string[]> {
  const { data } = await service.from("design_assets").select("id").eq("generation_job_id", jobId);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

export type StartDeps = {
  provider?: ImageGenerationProvider;
  env?: Record<string, string | undefined>;
  newRequestId?: () => string;
  /** Milliseconds since the epoch; for tests. */
  now?: () => number;
  /** Used only when the live image provider is chosen from the environment; for tests. */
  fetch?: typeof fetch;
};

/**
 * Starts (or retries) generation for a project on an administrator's request. `supabase` is the
 * CALLER's session client (checked as administrator); `service` is the trusted client. Throws
 * AuthError when the caller is not signed in or not an administrator.
 */
export async function startGeneration(
  supabase: Client,
  service: Client,
  input: { projectId: string; idempotencyKey: string },
  deps: StartDeps = {},
): Promise<GenerationResult> {
  const admin = await requireAdmin(supabase);
  return runGeneration(service, { ...input, actorId: admin.id, source: "admin" }, deps);
}

export type RunInput = {
  projectId: string;
  idempotencyKey: string;
  /** The administrator on whose decision this runs: recorded in the audit event. */
  actorId: string | null;
  /** "auto" is the run that follows a payment verification; it must never be called with browser input. */
  source: "admin" | "auto";
};

/**
 * The generation run itself, shared by the administrator's retry and the automatic run after a
 * payment verification. It trusts nothing about the caller: it re-reads the project and relies on
 * the conditional claim below and the database guards (verified payment, one active job), so a
 * repeated or concurrent call can never run the provider twice. Callers authorize before calling.
 */
export async function runGeneration(service: Client, input: RunInput, deps: StartDeps = {}): Promise<GenerationResult> {
  const env = deps.env ?? process.env;

  if (typeof input.projectId !== "string" || !ID.test(input.projectId) || typeof input.idempotencyKey !== "string" || !KEY.test(input.idempotencyKey)) {
    return fail("bad_request", "That request was not valid.");
  }

  const { data: projectData, error: projectError } = await service
    .from("projects")
    .select("id, customer_id, status, project_type, english_brief_json, english_brief_text, updated_at")
    .eq("id", input.projectId)
    .maybeSingle();
  if (projectError) return fail("failed", GENERIC);
  if (!projectData) return fail("not_found", "We could not find that project.");
  const project = projectData as ProjectRow;

  // A repeated request with the same key never runs the provider again.
  const { data: sameKey } = await service
    .from("generation_jobs")
    .select("id, status, idempotency_key")
    .eq("project_id", project.id)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (sameKey) {
    const job = sameKey as JobRow;
    if (job.status === "SUCCEEDED") return finalizeSucceeded(service, project, job.id, true);
    if (job.status === "FAILED") return fail("failed", "That attempt failed. Use a new key to try again.");
    return fail("in_progress", "Generation is already running for this project.");
  }

  const { data: jobsData } = await service.from("generation_jobs").select("id, status, idempotency_key").eq("project_id", project.id);
  const jobs = (jobsData ?? []) as JobRow[];
  if (jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING")) return fail("in_progress", "Generation is already running for this project.");

  let resume = false;
  if (project.status === "GENERATING") {
    // Left in GENERATING by an interrupted run: finish a success, or create the missing job.
    const succeeded = jobs.find((j) => j.status === "SUCCEEDED");
    if (succeeded) return finalizeSucceeded(service, project, succeeded.id, true);
    const since = Date.parse(project.updated_at ?? "");
    const now = (deps.now ?? Date.now)();
    if (!Number.isFinite(since) || now - since < RESUME_AFTER_MS) return fail("in_progress", "Generation was only just started for this project. Wait a minute and try again.");
    resume = true;
  } else if (!START_STATUSES.includes(project.status)) {
    return fail("not_eligible", "Generation can start only after the payment has been verified.");
  }

  // Any generated file already present blocks a start: release would publish all of them.
  const { data: existing } = await service.from("design_assets").select("id").eq("project_id", project.id).not("generation_job_id", "is", null);
  if ((existing ?? []).length > 0) {
    return fail("not_eligible", "This project already has generated files. An administrator must clear them first.");
  }

  let provider: ImageGenerationProvider;
  try {
    provider = deps.provider ?? getImageProvider(env, deps.fetch ? { fetch: deps.fetch } : {});
  } catch (error) {
    if (error instanceof ImageProviderUnavailableError) return fail("provider_unavailable", error.message);
    return fail("failed", GENERIC);
  }

  const requestId = (deps.newRequestId ?? randomUUID)();
  const built = buildImageRequest({
    projectType: project.project_type,
    briefJson: project.english_brief_json,
    approvedBriefText: project.english_brief_text,
    maxImages: getMaxGenerationImages(env),
    requestId,
    // Per image: the whole request is allowed this long for each view (see the call below).
    timeoutMs: provider.timeoutMsPerImage ?? getProviderTimeoutMs(env),
  });
  if (!built.ok) {
    return built.error === "brief_invalid"
      ? fail("brief_invalid", "The stored brief is not valid, so images cannot be created.")
      : fail("limit", "No images are allowed for this project.");
  }

  // Claim the project. The database re-checks the verified payment; the conditional update
  // means exactly one of several concurrent requests proceeds.
  if (!resume) {
    const claimed = await moveProject(service, project.id, project.status, "GENERATING");
    if (!claimed.ok) {
      if (claimed.code === "42501") return fail("not_eligible", "Generation can start only after the payment has been verified.");
      if (claimed.code === "lost") return fail("in_progress", "Generation is already running for this project.");
      return fail("failed", GENERIC);
    }
  }

  const { data: jobData, error: jobError } = await service
    .from("generation_jobs")
    .insert({
      project_id: project.id,
      provider: provider.id,
      image_model: provider.model,
      prompt_version: built.request.promptVersion,
      // Metadata only. The customer's words are never stored on the job.
      prompt_json: { promptVersion: built.request.promptVersion, views: built.views.map((v) => v.key), count: built.views.length, mock: provider.mock },
      idempotency_key: input.idempotencyKey,
    })
    .select("id")
    .single();
  if (jobError || !jobData) {
    // No job exists to fail, so the project stays GENERATING; starting again resumes it.
    return (jobError as { code?: string } | null)?.code === "23505"
      ? fail("in_progress", "Generation is already running for this project.")
      : fail("failed", GENERIC);
  }
  const jobId = (jobData as { id: string }).id;
  const run = { projectId: project.id, jobId, started: Date.now(), uploaded: [] as string[], inserted: false, provider };
  log("job_created", { job_id: jobId, project_id: project.id, provider: provider.id, mock: provider.mock });

  // Who started it: the audit triggers see no signed-in user for the service role.
  const audit = await service.from("audit_events").insert({
    actor_id: input.actorId,
    action: input.source === "auto" ? "generation.auto_started" : "generation.admin_started",
    project_id: project.id,
    metadata_json: { job_id: jobId, provider: provider.id, mock: provider.mock },
  });
  if (audit.error) return abort(service, run, "QUEUED", "AUDIT_FAILED", "The start could not be recorded.");

  const running = await service.from("generation_jobs").update({ status: "RUNNING", attempt_count: 1 }).eq("id", jobId).eq("status", "QUEUED").select("id");
  if (running.error || !running.data || running.data.length !== 1) return abort(service, run, "QUEUED", "JOB_START_FAILED", GENERIC);

  // The provider runs once. A reserved-usage provider (none yet) is metered first; a refusal means no call.
  let result: ImageGenerationResult;
  try {
    const request = built.request;
    // Reference photos go to a provider only when it says it supports them, and only for projects
    // that have them (an empty plot has none to send). They are checked again before use.
    if (provider.supportsReferences && project.project_type !== "EMPTY_PLOT") {
      const references = await loadReferenceInputs(service, project.id);
      if (references.length > 0) request.references = references;
    }
    const call = (hooks?: ProviderHooks) => withTimeout(provider.generate(request, hooks), request.timeoutMs * request.views.length);
    const plan = provider.planUsage?.(request) ?? provider.usage;
    if (plan) {
      const guarded = await withUsage(service, { customerId: project.customer_id, projectId: project.id }, plan, (hooks) => call(hooks));
      if (!guarded.ok) return abort(service, run, "RUNNING", "RESERVATION_REFUSED", "Usage limits do not allow this request right now.", "reservation_refused");
      result = guarded.value;
    } else {
      result = await call();
    }
  } catch (error) {
    const code = error instanceof ProviderError ? `PROVIDER_${error.code.toUpperCase()}` : "PROVIDER_ERROR";
    return abort(service, run, "RUNNING", code, "The image provider did not return a usable result.");
  }

  const checked = validateImageOutputs(result.outputs, built.views);
  if (!checked.ok) return abort(service, run, "RUNNING", `OUTPUT_${checked.reason.toUpperCase()}`, "The image provider did not return a usable result.");

  // Store privately under <project>/generated/, then record the (unreleased) assets.
  const byView = new Map(built.views.map((v) => [v.key, v]));
  for (const image of checked.images) {
    const path = buildObjectPath(project.id, "generated", newObjectName(image.ext));
    const { error } = await service.storage.from(PROJECT_FILES_BUCKET).upload(path, image.bytes, { contentType: image.mimeType, upsert: false });
    if (error) return abort(service, run, "RUNNING", "STORAGE_FAILED", GENERIC);
    run.uploaded.push(path);
    // The checked write path: the database function locks the job row and refuses unless the job is
    // still RUNNING, so a request cleared as stale cannot attach a file to its FAILED job.
    const { error: assetError } = await service.rpc("insert_generated_asset", {
      p_project_id: project.id,
      p_job_id: jobId,
      p_asset_type: byView.get(image.viewKey)!.assetType,
      p_storage_path: path,
      p_mime_type: image.mimeType,
      p_width: image.width,
      p_height: image.height,
    });
    run.inserted = true;
    if (assetError) return abort(service, run, "RUNNING", "ASSET_RECORD_FAILED", GENERIC);
  }

  const done = await service
    .from("generation_jobs")
    .update({
      status: "SUCCEEDED",
      duration_ms: Date.now() - run.started,
      usage_json: {
        mock: result.mock,
        images: checked.images.length,
        bytes: checked.images.reduce((n, i) => n + i.bytes.length, 0),
        // What the provider itself reported; null when it reported nothing. Never an estimate.
        costUsd: result.costUsd ?? null,
        requestIds: result.requestIds ?? [],
        model: result.model,
      },
    })
    .eq("id", jobId)
    .eq("status", "RUNNING")
    .select("id");
  if (done.error || !done.data || done.data.length !== 1) return abort(service, run, "RUNNING", "JOB_COMPLETE_FAILED", GENERIC);

  return finalizeSucceeded(service, project, jobId, false);
}

/**
 * Moves a project whose job succeeded to READY_FOR_REVIEW. Safe to repeat: it reads the
 * project's CURRENT status (the caller's copy may be stale) and writes only when it is still
 * GENERATING.
 */
async function finalizeSucceeded(service: Client, project: ProjectRow, jobId: string, replayed: boolean): Promise<GenerationResult> {
  const assetIds = await assetIdsOf(service, jobId);
  const { data: jobRow } = await service.from("generation_jobs").select("provider, usage_json").eq("id", jobId).maybeSingle();
  const mock = jobRow ? isMockJob(jobRow as { provider?: string; usage_json?: unknown }) : false;
  const { data: current } = await service.from("projects").select("status").eq("id", project.id).maybeSingle();
  const status = (current as { status?: string } | null)?.status;
  const notFinal = fail("finalize_failed", "The images were created but the project could not be marked ready for review. Try the same request again.");
  if (status === "GENERATING") {
    const moved = await moveProject(service, project.id, "GENERATING", "READY_FOR_REVIEW");
    if (!moved.ok) return notFinal;
  } else if (status !== "READY_FOR_REVIEW" && status !== "RELEASED") {
    return notFinal;
  }
  log("ready_for_review", { job_id: jobId, project_id: project.id, assets: assetIds.length, replayed });
  return { ok: true, jobId, assetIds, replayed, mock };
}

/**
 * Removes the files a job wrote, in an order that never loses track of one: the stored objects
 * first, and the rows that point at them only once the objects are really gone. If an object
 * cannot be removed (an error, or a timeout), its row stays: the file is then still listed as a
 * leftover that blocks release and that an administrator can clear later (removeLeftoverFiles).
 * Objects that were uploaded but never got a row are retried the same way by that recovery.
 * Returns whether everything this job wrote is gone.
 */
async function removeJobFiles(service: Client, jobId: string, knownPaths: string[]): Promise<boolean> {
  const { data, error: readError } = await service.from("design_assets").select("id, storage_path").eq("generation_job_id", jobId);
  if (readError) return false;
  const rows = (data ?? []) as { id: string; storage_path: string }[];
  const paths = [...new Set([...knownPaths, ...rows.map((r) => r.storage_path)])];
  if (paths.length > 0) {
    const removed = await service.storage.from(PROJECT_FILES_BUCKET).remove(paths).catch(() => ({ error: new Error("storage unavailable") }));
    if (removed.error) return false;
  }
  if (rows.length > 0) {
    const deleted = await service.from("design_assets").delete().eq("generation_job_id", jobId);
    if (deleted.error) return false;
  }
  return true;
}

type Run = { projectId: string; jobId: string; started: number; uploaded: string[]; inserted: boolean; provider: ImageGenerationProvider };

/**
 * Failure path. Removes what this run wrote, marks the job FAILED and the project
 * GENERATION_FAILED. Nothing becomes visible to a customer: assets are never released here.
 * The error summary is generic; provider detail stays out of the database and the messages.
 *
 * The project is moved only when this run's own conditional job update matched its job. If it
 * matched nothing, the job was already ended elsewhere (cleared as stale), a newer run may own
 * the project, and this run must not touch it.
 */
async function abort(
  service: Client,
  run: Run,
  from: "QUEUED" | "RUNNING",
  errorCode: string,
  summary: string,
  code: GenerationCode = "failed",
): Promise<GenerationResult> {
  const cleanedUp = await removeJobFiles(service, run.jobId, run.uploaded);
  const failed = await service
    .from("generation_jobs")
    .update({ status: "FAILED", error_code: errorCode, error_summary: cleanedUp ? summary : `${summary} Cleanup incomplete.`, duration_ms: Date.now() - run.started })
    .eq("id", run.jobId)
    .eq("status", from)
    .select("id");
  const ownsJob = !failed.error && failed.data?.length === 1;
  if (ownsJob) await moveProject(service, run.projectId, "GENERATING", "GENERATION_FAILED");
  log("failed", { job_id: run.jobId, project_id: run.projectId, error_code: errorCode, cleaned_up: cleanedUp, owned_job: ownsJob });
  return fail(code, code === "reservation_refused" ? summary : GENERIC);
}

// ---------------------------------------------------------------------------
// Release (existing database function, admin's own session)
// ---------------------------------------------------------------------------

export type ReleaseOptions = {
  /** The administrator confirmed that mock placeholders will become visible to the customer. */
  acknowledgeMock?: boolean;
};

type ReleaseJob = { id: string; status: string; provider: string; usage_json: unknown };

/**
 * Releases a reviewed project's generated assets to its customer. This is the database's
 * own admin_release_project, called with the administrator's OWN session so the function can
 * check the role. Never the service role, never an automatic consequence of generation.
 *
 * Before calling it, this re-reads the project (as the administrator) and refuses unless every
 * generated file comes from a SUCCEEDED job and nothing is still running. The database
 * function releases EVERY asset that has a job, so a file left behind by a failed or
 * interrupted attempt would otherwise be published with the good ones. Placeholders from the
 * mock generator also need an explicit acknowledgement.
 */
export async function releaseProject(supabase: Client, projectId: string, options: ReleaseOptions = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireAdmin(supabase);
  if (typeof projectId !== "string" || !ID.test(projectId)) return { ok: false, message: "That request was not valid." };

  const [{ data: project, error: projectError }, { data: jobsData, error: jobsError }, { data: assetsData, error: assetsError }] = await Promise.all([
    supabase.from("projects").select("status").eq("id", projectId).maybeSingle(),
    supabase.from("generation_jobs").select("id, status, provider, usage_json").eq("project_id", projectId),
    supabase.from("design_assets").select("id, generation_job_id").eq("project_id", projectId).not("generation_job_id", "is", null),
  ]);
  if (projectError || jobsError || assetsError) return { ok: false, message: "Release could not be completed. Please try again." };
  if (!project || (project as { status: string }).status !== "READY_FOR_REVIEW") return { ok: false, message: "This project is not ready for release." };

  const jobs = (jobsData ?? []) as ReleaseJob[];
  const assets = (assetsData ?? []) as { id: string; generation_job_id: string }[];
  if (jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING")) return { ok: false, message: "A generation job is still running for this project." };
  const succeeded = new Map(jobs.filter((j) => j.status === "SUCCEEDED").map((j) => [j.id, j]));
  if (assets.length === 0 || succeeded.size === 0) return { ok: false, message: "There are no generated files to release." };
  if (assets.some((a) => !succeeded.has(a.generation_job_id))) {
    return { ok: false, message: "Files from a failed or unfinished attempt are still attached to this project. They must be cleared before anything is released." };
  }
  if ([...succeeded.values()].some(isMockJob) && options.acknowledgeMock !== true) {
    return { ok: false, message: "These images are MOCK placeholders, not designs. Confirm that you understand this before releasing them." };
  }

  const { error } = await supabase.rpc("admin_release_project", { p_project_id: projectId });
  if (!error) return { ok: true };
  const code = (error as { code?: string }).code;
  if (code === "P0002") return { ok: false, message: "This project is not ready for release." };
  if (code === "42501") return { ok: false, message: "You do not have access to this action." };
  return { ok: false, message: "Release could not be completed. Please try again." };
}

// ---------------------------------------------------------------------------
// Interrupted jobs
// ---------------------------------------------------------------------------

/**
 * A job counts as abandoned only after this long. This is a recovery heuristic, not proof that
 * the request stopped: only the provider call has a timeout (at most 60 seconds), while storage
 * and database calls have none and are never cancelled, so the original request may still be
 * running. Clearing is safe anyway because that request can no longer finish its job or move
 * the project (see abort). Timeouts for storage calls are a Phase 6B prerequisite.
 */
export const STALE_JOB_AFTER_MS = 10 * 60_000;

type JobTimes = { status: string; created_at: string | null; started_at?: string | null };

/** True only for an active job whose last progress is older than the limit. An unreadable time is never stale. */
export function isStaleJob(job: JobTimes, now: number): boolean {
  if (job.status !== "QUEUED" && job.status !== "RUNNING") return false;
  // RUNNING has made progress since started_at; QUEUED since it was created.
  const since = Date.parse((job.status === "RUNNING" ? (job.started_at ?? job.created_at) : job.created_at) ?? "");
  return Number.isFinite(since) && now - since >= STALE_JOB_AFTER_MS;
}

/**
 * Marks an abandoned job FAILED so the project is no longer blocked. It refuses unless the
 * job is active AND older than STALE_JOB_AFTER_MS, so a request that is merely slow is never
 * cut off. It removes only that job's own (unreleased) files, records who did it, and moves the
 * project to GENERATION_FAILED, from where an administrator starts again with a new key. It
 * never calls a provider and never releases anything.
 */
export async function clearStaleJob(
  supabase: Client,
  service: Client,
  projectId: string,
  deps: { now?: () => number } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = await requireAdmin(supabase);
  if (typeof projectId !== "string" || !ID.test(projectId)) return { ok: false, message: "That request was not valid." };

  const { data: project } = await service.from("projects").select("id, status, updated_at").eq("id", projectId).maybeSingle();
  if (!project) return { ok: false, message: "We could not find that project." };
  if ((project as { status: string }).status !== "GENERATING") return { ok: false, message: "This project has no interrupted generation to clear." };
  // The project as this action saw it. The final move matches this exact stamp (see moveProject).
  const seenUpdatedAt = (project as { updated_at?: string | null }).updated_at ?? undefined;

  const now = (deps.now ?? Date.now)();
  const { data: jobsData } = await service.from("generation_jobs").select("id, status, created_at, started_at, completed_at, error_code").eq("project_id", projectId);
  const jobs = (jobsData ?? []) as (JobTimes & { id: string; completed_at?: string | null; error_code?: string | null })[];
  const active = jobs.filter((j) => j.status === "QUEUED" || j.status === "RUNNING");

  // A clearing that was interrupted after it ended the job (cleanup or the project move failed) leaves
  // the project GENERATING with a FAILED, STALE_ABANDONED job and no active one. It is finished here
  // after the same one-minute settle time that guards resuming a project without a job. The settle time
  // is measured on the PROJECT (like startGeneration): a project that was only just claimed again has no
  // job yet and is not an interrupted one, whatever the age of an older failed job.
  let job: (typeof jobs)[number] | undefined;
  let resumed = false;
  const projectSince = seenUpdatedAt ? Date.parse(seenUpdatedAt) : NaN;
  if (active.length === 1) {
    job = active[0];
    if (!isStaleJob(job, now)) {
      return { ok: false, message: "That job started recently and may still be running. Wait ten minutes before clearing it." };
    }
  } else if (active.length === 0) {
    const abandoned = jobs.filter((j) => j.status === "FAILED" && j.error_code === "STALE_ABANDONED").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    const endedAt = abandoned?.completed_at ? Date.parse(abandoned.completed_at) : NaN;
    if (abandoned && Number.isFinite(endedAt) && now - endedAt >= RESUME_AFTER_MS && Number.isFinite(projectSince) && now - projectSince >= RESUME_AFTER_MS) {
      job = abandoned;
      resumed = true;
    }
  }
  if (!job) return { ok: false, message: "There is no single interrupted job to clear." };

  // Record who is clearing it before changing anything: if the audit event cannot be written,
  // nothing is cleared. The job's own status trigger then records whether the change happened.
  const audit = await service.from("audit_events").insert({
    actor_id: admin.id,
    action: "generation.admin_cleared_stale",
    project_id: projectId,
    metadata_json: { job_id: job.id, ...(resumed ? { resumed: true } : {}) },
  });
  if (audit.error) return { ok: false, message: "The clearing could not be recorded, so nothing was changed. Please try again." };

  const summary = "The job was interrupted and cleared by an administrator.";
  if (!resumed) {
    // STEP 1: end the job BEFORE touching its files. insert_generated_asset() locks the job row FOR
    // SHARE and refuses unless it is RUNNING, so this update waits for an insert that is in flight, and
    // every later insert is refused. Once it returns, no file can be attached to this job any more:
    // the cleanup below sees every row that will ever exist for it. The summary says "pending" until
    // the cleanup has really finished, so an interruption never reads as a clean job.
    const failed = await service
      .from("generation_jobs")
      .update({ status: "FAILED", error_code: "STALE_ABANDONED", error_summary: `${summary} Cleanup pending.` })
      .eq("id", job.id)
      .eq("status", job.status)
      .select("id");
    if (failed.error || !failed.data || failed.data.length !== 1) return { ok: false, message: "The job changed while it was being cleared. Reload and check its state." };
  }

  // STEP 2: only this job's own files, never anything attached to another job.
  const cleanedUp = await removeJobFiles(service, job.id, []);

  // STEP 3: record the outcome. If this write fails the summary stays "Cleanup pending" (the safe reading).
  await service.from("generation_jobs").update({ error_summary: cleanedUp ? summary : `${summary} Cleanup incomplete.` }).eq("id", job.id).eq("status", "FAILED");

  // STEP 4: the project leaves GENERATING even when files are left behind: they stay listed as
  // leftovers (they block release and an administrator can clear them), exactly as before.
  // The move is ONE database call, end_interrupted_generation(), which locks the project row FOR UPDATE and,
  // under that lock, checks that the project is still what this action read (status AND updated_at, so a
  // project that was moved and claimed again is left alone) and that no job is active, before moving it.
  // A job insert takes the same row lock (generation_jobs_guard reads the project FOR KEY SHARE), so a new
  // job is either committed before the check (the project is left alone) or refused after the move; the
  // clearing can no longer fail a fresh run's project, whichever of the two arrives first.
  const moved = await service.rpc("end_interrupted_generation", { p_project_id: projectId, p_expect_updated_at: seenUpdatedAt ?? null });
  const outcome = moved.error ? "ERROR" : String(moved.data);
  log("stale_cleared", { job_id: job.id, project_id: projectId, cleaned_up: cleanedUp, resumed, outcome });
  if (outcome === "MOVED") return { ok: true };
  if (outcome === "ACTIVE_JOB") return { ok: false, message: "A new generation run started for this project, so it was left as it is. Reload and check its state." };
  if (outcome === "PROJECT_CHANGED" || outcome === "NOT_FOUND") return { ok: false, message: "The project changed while it was being cleared, so it was left as it is. Reload and check its state." };
  return { ok: false, message: "The job was cleared but the project could not be updated. Reload and check its state." };
}

// ---------------------------------------------------------------------------
// Recovery: files left behind by a failed or interrupted attempt
// ---------------------------------------------------------------------------

export type LeftoverResult = { ok: true; removedRows: number; removedOrphans: number } | { ok: false; message: string };

const LEFTOVER_ALLOWED_STATUSES = ["PAYMENT_VERIFIED", "GENERATION_FAILED", "READY_FOR_REVIEW"];

/**
 * Removes generated files that no succeeded job owns, so a project blocked by an earlier failed
 * attempt can be generated or released again. Administrator only; the audit event is written
 * first and nothing changes if it cannot be. It removes:
 *   1. rows (and their objects) attached to a job that did NOT succeed; and
 *   2. objects under <project>/generated/ that no row refers to (an upload whose row was never
 *      written, or whose cleanup failed).
 * It never touches a succeeded job's files, never runs while a job is queued or running (an
 * object in flight would look like an orphan), and never on a released project.
 */
export async function removeLeftoverFiles(supabase: Client, service: Client, projectId: string): Promise<LeftoverResult> {
  const admin = await requireAdmin(supabase);
  if (typeof projectId !== "string" || !ID.test(projectId)) return { ok: false, message: "That request was not valid." };
  const { data: project } = await service.from("projects").select("id, status").eq("id", projectId).maybeSingle();
  if (!project) return { ok: false, message: "We could not find that project." };
  if (!LEFTOVER_ALLOWED_STATUSES.includes((project as { status: string }).status)) return { ok: false, message: "Files can be cleared only before release and while no generation is running." };

  const { data: jobsData, error: jobsError } = await service.from("generation_jobs").select("id, status").eq("project_id", projectId);
  if (jobsError || !Array.isArray(jobsData)) return { ok: false, message: "The project's jobs could not be read. Nothing was changed." };
  const jobs = jobsData as { id: string; status: string }[];
  if (jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING")) return { ok: false, message: "A generation job is still running for this project." };
  const keep = new Set(jobs.filter((j) => j.status === "SUCCEEDED").map((j) => j.id));

  const { data: assetsData, error: assetsError } = await service.from("design_assets").select("id, storage_path, generation_job_id").eq("project_id", projectId).not("generation_job_id", "is", null);
  if (assetsError || !Array.isArray(assetsData)) return { ok: false, message: "The project's files could not be read. Nothing was changed." };
  const assets = assetsData as { id: string; storage_path: string; generation_job_id: string }[];
  const leftoverRows = assets.filter((a) => !keep.has(a.generation_job_id));

  const folder = `${projectId}/generated`;
  const listed = await service.storage.from(PROJECT_FILES_BUCKET).list(folder, { limit: 1000 }).catch(() => ({ data: null, error: new Error("storage unavailable") }));
  if (listed.error || !listed.data) return { ok: false, message: "The stored files could not be listed. Nothing was changed." };
  const referenced = new Set(assets.map((a) => a.storage_path));
  const orphans = listed.data.filter((o) => o.name && !referenced.has(`${folder}/${o.name}`)).map((o) => `${folder}/${o.name}`);

  if (leftoverRows.length === 0 && orphans.length === 0) return { ok: true, removedRows: 0, removedOrphans: 0 };

  const audit = await service.from("audit_events").insert({
    actor_id: admin.id,
    action: "generation.admin_cleared_leftovers",
    project_id: projectId,
    metadata_json: { rows: leftoverRows.length, orphans: orphans.length },
  });
  if (audit.error) return { ok: false, message: "The clearing could not be recorded, so nothing was changed. Please try again." };

  const paths = [...leftoverRows.map((r) => r.storage_path), ...orphans];
  const removed = await service.storage.from(PROJECT_FILES_BUCKET).remove(paths).catch(() => ({ error: new Error("storage unavailable") }));
  if (removed.error) return { ok: false, message: "The stored files could not be removed. Nothing else was changed; try again." };
  if (leftoverRows.length > 0) {
    const deleted = await service.from("design_assets").delete().in("id", leftoverRows.map((r) => r.id)).select("id");
    if (deleted.error) return { ok: false, message: "The files were removed but their records could not be. Try again." };
  }
  log("leftovers_cleared", { project_id: projectId, rows: leftoverRows.length, orphans: orphans.length });
  return { ok: true, removedRows: leftoverRows.length, removedOrphans: orphans.length };
}
