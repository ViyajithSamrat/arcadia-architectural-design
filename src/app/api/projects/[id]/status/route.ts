import { after } from "next/server";
import { AuthError } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/guards";
import { reconcileGeneration } from "@/lib/generation/auto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/projects/[id]/status: where the signed-in owner's own project stands, for the page that
 * watches generation. The answer is the status word only: no job, provider, file, path or error
 * detail ever leaves here, and a project that is not the caller's looks exactly like a missing one.
 *
 * It is also the safety net behind automatic generation. The run that follows an administrator's
 * payment verification is scheduled in that request; if it never ran (the process ended first), a
 * project still waiting is picked up here. That is safe to trigger from a customer's browser
 * because it only acts on state the database already holds (a verified payment, no job yet) and
 * every run is idempotent (see src/lib/generation/auto.ts). The caller supplies nothing that is used.
 */

/** The picked-up run happens after the response, so it needs the platform's long limit. */
export const maxDuration = 300;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: object, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const problem = (code: string, message: string, status: number) => json({ ok: false, error: { code, message } }, status);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!ID.test(id)) return problem("NOT_FOUND", "We could not find that project.", 404);

  let supabase;
  let userId: string;
  try {
    supabase = await createSupabaseServerClient();
    userId = (await requireUser(supabase)).id;
  } catch (error) {
    if (error instanceof AuthError) return problem(error.code, error.message, error.status);
    throw error;
  }

  // The owner's own session: row level security and the explicit owner filter both apply.
  const { data, error } = await supabase.from("projects").select("status").eq("id", id).eq("customer_id", userId).maybeSingle();
  if (error) return problem("UNAVAILABLE", "The status could not be read right now.", 503);
  if (!data) return problem("NOT_FOUND", "We could not find that project.", 404);
  const status = (data as { status: string }).status;

  if (status === "PAYMENT_VERIFIED" || status === "READY_FOR_REVIEW") {
    after(async () => {
      try {
        await reconcileGeneration(createSupabaseServiceClient(), id);
      } catch {
        console.error(JSON.stringify({ event: "generation.reconcile_failed", at: new Date().toISOString(), project_id: id }));
      }
    });
  }
  return json({ ok: true, status }, 200);
}
