import { Notice } from "@/components/journey/notice";
import { buttonPrimary, buttonSecondary } from "@/components/journey/styles";
import type { FloorPlanView } from "@/lib/generation/floor-plan";

/**
 * The empty-plot layout sketch. Each floor is an SVG drawn on the server from the saved answers
 * and shown as an <img> data URL: as an image the browser runs no script in it and fetches
 * nothing it references. Room names are also listed as text, so nothing depends on a label
 * fitting inside its block.
 *
 * With `downloadProjectId` (the owner's results page) it also offers the same layout as an editable
 * CAD file and as SVG, from /api/projects/[id]/plan, which authorizes every download itself.
 */
export function FloorPlanSketch({ plan, audience, downloadProjectId }: { plan: FloorPlanView; audience: "admin" | "customer"; downloadProjectId?: string }) {
  return (
    <section aria-labelledby="floor-plan-title" className="space-y-3">
      <h2 id="floor-plan-title" className="text-xl font-semibold">
        Illustrative layout sketch
      </h2>
      {plan.state === "unavailable" ? (
        <Notice tone="warning" title="The layout sketch could not be drawn">
          <p>The saved project answers could not be turned into a sketch. The concept images are not affected.</p>
        </Notice>
      ) : (
        <>
          <Notice tone="info" title={plan.disclaimer}>
            <p>
              Drawn by this app from the answers in the project form, not by an AI model. It shows the plot proportions and dimensions that were entered and one block for each requested room or space. Block sizes and positions follow a fixed drawing rule: they are not room sizes or a design.
            </p>
            {audience === "admin" ? <p>The customer sees this sketch only after the project is released, together with the images.</p> : null}
          </Notice>
          <ul className="grid gap-4 lg:grid-cols-2" aria-label="Layout sketch by floor">
            {plan.floors.map((floor) => (
              <li key={floor.name}>
                <figure className="space-y-2">
                  {/* A data URL drawn on the server: next/image would add nothing and does not optimise SVG. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={floor.dataUrl}
                    alt={`${floor.name}: illustrative layout sketch of the plot and the requested rooms`}
                    width={floor.width}
                    height={floor.height}
                    loading="lazy"
                    decoding="async"
                    className="h-auto w-full rounded-lg border border-border bg-white"
                  />
                  <figcaption className="text-sm font-medium">{floor.name}</figcaption>
                </figure>
              </li>
            ))}
          </ul>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <h3 className="font-medium">Numbered blocks</h3>
              <ol className="space-y-0.5 text-sm">
                {plan.rooms.map((room) => (
                  <li key={room.number}>
                    {room.number}. {room.label} <span className="text-muted">({room.floor})</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="space-y-1">
              <h3 className="font-medium">How the sketch was drawn</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {plan.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          </div>
          {downloadProjectId ? (
            <div className="space-y-4 rounded-[4px] border border-border bg-surface p-5 sm:p-6">
              <h3 className="font-medium">Download the 2D drawing</h3>
              <p className="max-w-prose text-sm leading-relaxed text-muted">
                An editable CAD file (DXF) that opens in AutoCAD, LibreCAD, DraftSight and other CAD programs. It holds your plot outline at the size you entered, dimensioned, and one outline for each requested room or space, each on its own layer. The room outlines are schematic: they carry no sizes, and there are no walls, doors or windows. This is a layout sketch, not a construction drawing, and it has not been checked by an architect or against any building rules.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <a href={`/api/projects/${downloadProjectId}/plan?format=dxf`} download className={buttonPrimary}>
                  Download 2D CAD drawing (DXF)
                </a>
                {plan.floors.map((floor, i) => (
                  <a key={floor.name} href={`/api/projects/${downloadProjectId}/plan?format=svg&floor=${i + 1}`} download className={buttonSecondary}>
                    {plan.floors.length > 1 ? `SVG: ${floor.name}` : "Download SVG"}
                  </a>
                ))}
              </div>
            </div>
          ) : null}
          <p className="text-sm text-muted">Sketch version {plan.version}.</p>
        </>
      )}
    </section>
  );
}
