import { AuthError, authErrorResponse } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/guards";
import { EVIDENCE_REQUEST_MAX_BYTES } from "@/lib/payments/evidence";
import { UPLOAD_MAX_LABEL } from "@/lib/uploads/limits";
import { submitPayment } from "@/lib/payments/service";
import { isAllowedOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/payments: a customer submits payment evidence (multipart form).
 *
 * This is a Route Handler rather than a Server Action on purpose: Server Actions accept
 * only 1 MB unless `serverActions.bodySizeLimit` is raised, and that setting applies to
 * every action in the app. Here the limit is checked for this route alone, before the
 * body is read. The administrator's verify and reject are small, so they stay Server Actions.
 *
 * Nothing the browser sends decides a status, an owner or an amount to trust: the fields
 * are claims, and the service layer re-checks ownership and workflow state.
 */

const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

const json = (body: object, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const problem = (code: string, message: string, status: number) => json({ ok: false, error: { code, message } }, status);

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) return problem("BAD_ORIGIN", "Request not allowed.", 403);

  // Refuse before reading anything: the declared size must be present and within the limit.
  const declared = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isFinite(declared) || declared < 0) {
    return problem("LENGTH_REQUIRED", "The request size was not declared.", 411);
  }
  if (declared > EVIDENCE_REQUEST_MAX_BYTES) return problem("TOO_LARGE", `The upload is too large. The image must be ${UPLOAD_MAX_LABEL} or smaller.`, 413);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return problem("UNSUPPORTED", "Send the details as a form.", 415);
  }

  let supabase;
  let userId: string;
  try {
    supabase = await createSupabaseServerClient();
    userId = (await requireUser(supabase)).id;
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    throw error;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return problem("BAD_REQUEST", "That request was not valid.", 400);
  }

  const projectId = form.get("projectId");
  if (!isId(projectId)) return problem("BAD_REQUEST", "That request was not valid.", 400);
  const evidence = form.get("evidence");

  let service;
  try {
    service = createSupabaseServiceClient();
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    throw error;
  }

  const result = await submitPayment(supabase, service, userId, projectId, {
    utrReference: form.get("utrReference"),
    transferDate: form.get("transferDate"),
    amount: form.get("amount"),
    method: form.get("method"),
    file: evidence instanceof File ? evidence : null,
  });

  if (!result.ok) return json({ ok: false, message: result.message, fieldErrors: result.fieldErrors ?? {} }, 422);
  return json({ ok: true, paymentId: result.paymentId }, 201);
}
