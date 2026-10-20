"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthError } from "@/lib/auth/errors";
import { requireAdmin } from "@/lib/auth/guards";
import { clearStaleJob, releaseProject, startGeneration } from "@/lib/generation/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * Server Actions for the generation screens. They are public endpoints: each checks the
 * administrator role on the server (from the database, never from anything the browser sent)
 * and then calls the same protected service layer that the tests cover. Every argument is
 * untrusted. Success is never reported from here: a successful action redirects to the
 * project page, which reads the real state and shows the confirmation only if it is true.
 */

export type GenerationActionState = { ok: false; message: string } | undefined;

const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const BAD_REQUEST: GenerationActionState = { ok: false, message: "That request was not valid." };

type Outcome = { ok: true } | { ok: false; message: string };

async function asAdmin(work: (supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) => Promise<Outcome>): Promise<Outcome> {
  try {
    const supabase = await createSupabaseServerClient();
    await requireAdmin(supabase);
    return await work(supabase);
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: error.message };
    throw error;
  }
}

function done(projectId: string, flag: "started" | "released" | "cleared"): never {
  revalidatePath("/admin/generation", "layout");
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(`/admin/generation/${projectId}?${flag}=1`);
}

/** Starts (or retries, or finishes) generation. The key makes a repeated submit harmless. */
export async function startGenerationAction(projectId: string, idempotencyKey: string): Promise<GenerationActionState> {
  if (!isId(projectId) || typeof idempotencyKey !== "string") return BAD_REQUEST;
  const result = await asAdmin(async (supabase) => {
    const outcome = await startGeneration(supabase, createSupabaseServiceClient(), { projectId, idempotencyKey });
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  });
  if (!result.ok) return { ok: false, message: result.message };
  done(projectId, "started");
}

/** Releases after explicit confirmation. The server re-checks the confirmation; the checkbox alone is not trusted. */
export async function releaseProjectAction(projectId: string, confirmedReview: boolean, acknowledgeMock: boolean): Promise<GenerationActionState> {
  if (!isId(projectId)) return BAD_REQUEST;
  if (confirmedReview !== true) return { ok: false, message: "Confirm that you reviewed the images before releasing them." };
  const result = await asAdmin((supabase) => releaseProject(supabase, projectId, { acknowledgeMock: acknowledgeMock === true }));
  if (!result.ok) return { ok: false, message: result.message };
  done(projectId, "released");
}

/** Marks an abandoned job failed. The service refuses unless the job has made no progress for ten minutes. */
export async function clearStaleJobAction(projectId: string, confirmed: boolean): Promise<GenerationActionState> {
  if (!isId(projectId)) return BAD_REQUEST;
  if (confirmed !== true) return { ok: false, message: "Confirm that you want to clear the interrupted job." };
  const result = await asAdmin((supabase) => clearStaleJob(supabase, createSupabaseServiceClient(), projectId));
  if (!result.ok) return { ok: false, message: result.message };
  done(projectId, "cleared");
}
