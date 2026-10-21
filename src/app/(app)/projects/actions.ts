"use server";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthError } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/guards";
import { projectTypeFromSlug } from "@/lib/journeys/project-types";
import {
  acceptQuote,
  createBrief,
  createDraftProject,
  createQuote,
  readTranscriptInput,
  reviewBrief,
  saveStep,
  type ServiceResult,
} from "@/lib/journeys/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * Server Actions for the customer journey. They are public endpoints: each one
 * authenticates the caller and the service layer re-checks ownership and workflow
 * state. Every argument is treated as untrusted.
 */

export type ActionState =
  | { ok: false; message: string; fieldErrors?: Record<string, string>; missing?: string[] }
  | undefined;

type Context = { user: User; supabase: SupabaseClient };

/** Authenticates the caller, runs the work, and turns sign-in problems into a message. */
async function run<T extends object>(work: (ctx: Context) => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    const supabase = await createSupabaseServerClient();
    const user = await requireUser(supabase);
    return await work({ user, supabase });
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    throw error;
  }
}

function failure(result: Extract<ServiceResult<object>, { ok: false }>): ActionState {
  return { ok: false, message: result.message, fieldErrors: result.fieldErrors, missing: result.missing };
}

const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
const BAD_REQUEST: ActionState = { ok: false, message: "That request was not valid." };
const refresh = (projectId: string) => revalidatePath(`/projects/${projectId}`, "layout");

export async function startProjectAction(slug: string): Promise<ActionState> {
  const type = typeof slug === "string" ? projectTypeFromSlug(slug) : null;
  if (!type) return BAD_REQUEST;
  const result = await run(({ supabase, user }) => createDraftProject(supabase, user.id, type));
  if (!result.ok) return failure(result);
  redirect(`/projects/${result.projectId}/edit`);
}

export async function saveStepAction(projectId: string, stepId: string, data: Record<string, unknown>, voice?: unknown): Promise<ActionState> {
  if (!isId(projectId) || typeof stepId !== "string" || typeof data !== "object" || data === null || Array.isArray(data)) {
    return BAD_REQUEST;
  }
  // A transcript the customer chose to use; the service validates it before anything is written.
  const transcript = voice === undefined ? undefined : readTranscriptInput(voice);
  if (transcript === null) return BAD_REQUEST;
  // The trusted client is created only if the description step needs it.
  const options = { service: createSupabaseServiceClient };
  const result = await run(({ supabase, user }) => saveStep(supabase, user.id, projectId, stepId, data, transcript, options));
  if (!result.ok) return failure(result);
  refresh(projectId);
  redirect(
    result.nextStepId
      ? `/projects/${projectId}/edit?step=${encodeURIComponent(result.nextStepId)}`
      : `/projects/${projectId}/brief`,
  );
}

export async function createBriefAction(projectId: string): Promise<ActionState> {
  if (!isId(projectId)) return BAD_REQUEST;
  const result = await run(({ supabase, user }) => createBrief(supabase, createSupabaseServiceClient(), user.id, projectId));
  if (!result.ok) return failure(result);
  refresh(projectId);
  redirect(`/projects/${projectId}/brief`);
}

export async function reviewBriefAction(projectId: string, intent: string, text: string, confirmed: boolean): Promise<ActionState> {
  if (!isId(projectId) || (intent !== "save" && intent !== "approve") || typeof text !== "string") return BAD_REQUEST;
  const result = await run(({ supabase, user }) =>
    reviewBrief(supabase, createSupabaseServiceClient(), user.id, projectId, intent, text, confirmed === true),
  );
  if (!result.ok) return failure(result);
  refresh(projectId);
  redirect(intent === "approve" ? `/projects/${projectId}/quote` : `/projects/${projectId}/brief?saved=1`);
}

export async function createQuoteAction(projectId: string): Promise<ActionState> {
  if (!isId(projectId)) return BAD_REQUEST;
  const result = await run(({ supabase, user }) => createQuote(supabase, createSupabaseServiceClient(), user.id, projectId));
  if (!result.ok) return failure(result);
  refresh(projectId);
  redirect(`/projects/${projectId}/quote`);
}

export async function acceptQuoteAction(projectId: string, quoteId: string): Promise<ActionState> {
  if (!isId(projectId) || !isId(quoteId)) return BAD_REQUEST;
  const result = await run(({ supabase, user }) =>
    acceptQuote(supabase, createSupabaseServiceClient(), user.id, projectId, quoteId),
  );
  if (!result.ok) return failure(result);
  refresh(projectId);
  redirect(`/projects/${projectId}/quote`);
}
