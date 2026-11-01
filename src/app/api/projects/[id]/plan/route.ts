import { AuthError } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/guards";
import { buildFloorPlanDxf } from "@/lib/generation/dxf";
import { layoutFromRequirements, renderFloorPlanSvg } from "@/lib/generation/floor-plan";
import { getOwnedProject } from "@/lib/journeys/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * GET /api/projects/[id]/plan?format=dxf|svg[&floor=1]: the empty-plot layout as an editable 2D CAD
 * file (DXF) or a vector image (SVG), for the project's owner once the project is RELEASED: the same
 * rule that shows the on-screen sketch.
 *
 * The file is built on request from the owner's saved answers (src/lib/generation/dxf.ts) and is never
 * stored, so there is no object to share and no link that outlives the session: every download is
 * authorized here. Authorization is the owner's own session, then the owner check, then the released
 * state; a project that is not the caller's looks exactly like a missing one. Nothing the browser
 * sends except the project id, the format and the floor number is used, and those are validated.
 *
 * The drawing is a schematic layout sketch, not a construction drawing: the file says so inside itself.
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

const problem = (code: string, message: string, status: number) => Response.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!ID.test(id)) return problem("NOT_FOUND", "We could not find that project.", 404);

  const query = new URL(request.url).searchParams;
  const format = query.get("format") ?? "dxf";
  if (format !== "dxf" && format !== "svg") return problem("BAD_REQUEST", "Choose the dxf or svg format.", 400);
  const floorParam = query.get("floor");
  if (floorParam !== null && !/^[1-9]$/.test(floorParam)) return problem("BAD_REQUEST", "That floor is not valid.", 400);

  let supabase;
  let userId: string;
  try {
    supabase = await createSupabaseServerClient();
    userId = (await requireUser(supabase)).id;
  } catch (error) {
    if (error instanceof AuthError) return problem(error.code, error.message, error.status);
    throw error;
  }

  const project = await getOwnedProject(supabase, userId, id);
  if (!project) return problem("NOT_FOUND", "We could not find that project.", 404);
  if (project.status !== "RELEASED") return problem("NOT_RELEASED", "The drawing is available once your concepts are ready.", 409);

  const layout = layoutFromRequirements(project.project_type, project.requirements_json);
  if (!layout) return problem("NOT_AVAILABLE", "A 2D layout drawing is not available for this project.", 404);

  const stem = `gnani-layout-${id.slice(0, 6).toLowerCase()}`;

  if (format === "svg") {
    const index = floorParam === null ? 0 : Number(floorParam) - 1;
    if (index >= layout.floors.length) return problem("BAD_REQUEST", "That floor is not valid.", 400);
    return new Response(renderFloorPlanSvg(layout, index), {
      status: 200,
      headers: { ...NO_STORE, "Content-Type": "image/svg+xml; charset=utf-8", "Content-Disposition": `attachment; filename="${stem}-floor-${index + 1}.svg"` },
    });
  }

  const dxf = buildFloorPlanDxf(layout);
  if (!dxf.ok) return problem("NOT_AVAILABLE", "A 2D layout drawing could not be prepared for this project.", 422);
  return new Response(dxf.content, {
    status: 200,
    headers: { ...NO_STORE, "Content-Type": "application/dxf", "Content-Disposition": `attachment; filename="${stem}.dxf"` },
  });
}
