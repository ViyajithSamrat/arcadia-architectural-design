"use client";

import { useEffect, useRef, useState } from "react";
import type { PlotSpec } from "@/lib/landing/preview";
import type { MassingModel } from "./massing";

interface Props {
  spec: PlotSpec;
  stage: number;
  label: string;
  className?: string;
  /** Sideways shift of the picture on wide screens, as a fraction of its width. */
  shiftX?: number;
}

/** Mounts the Three.js model, renders only while on screen, and falls back to text without WebGL. */
export function MassingCanvas({ spec, stage, label, className, shiftX = 0 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<MassingModel | null>(null);
  const specRef = useRef(spec);
  const stageRef = useRef(stage);
  const shiftRef = useRef(shiftX);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    specRef.current = spec;
    modelRef.current?.setSpec(spec);
  }, [spec]);

  useEffect(() => {
    stageRef.current = stage;
    modelRef.current?.setStage(stage);
  }, [stage]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    let disposed = false;
    let cleanup = () => {};

    import("./massing")
      .then(({ MassingModel }) => {
        if (disposed) return;
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let model: MassingModel;
        try {
          model = new MassingModel(canvas, { still });
        } catch {
          setFailed(true);
          return;
        }
        modelRef.current = model;
        model.setSpec(specRef.current);
        model.setStage(stageRef.current);

        const ro = new ResizeObserver(([e]) => {
          model.resize(e.contentRect.width, e.contentRect.height);
          model.setShift(e.contentRect.width > 760 ? shiftRef.current : 0);
        });
        ro.observe(wrap);
        const io = new IntersectionObserver(([e]) => (e.isIntersecting ? model.start() : model.stop()), {
          rootMargin: "100px",
        });
        io.observe(wrap);

        const onMove = (ev: PointerEvent) => {
          if (ev.pointerType !== "mouse") return;
          const r = wrap.getBoundingClientRect();
          model.setPointer(((ev.clientX - r.left) / r.width) * 2 - 1, ((ev.clientY - r.top) / r.height) * 2 - 1);
        };
        const onLeave = () => model.setPointer(0, 0);
        wrap.addEventListener("pointermove", onMove);
        wrap.addEventListener("pointerleave", onLeave);
        const onLost = (ev: Event) => {
          ev.preventDefault();
          setFailed(true);
        };
        canvas.addEventListener("webglcontextlost", onLost);

        cleanup = () => {
          ro.disconnect();
          io.disconnect();
          wrap.removeEventListener("pointermove", onMove);
          wrap.removeEventListener("pointerleave", onLeave);
          canvas.removeEventListener("webglcontextlost", onLost);
          model.dispose();
          modelRef.current = null;
        };
      })
      .catch(() => setFailed(true));

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return (
    <div ref={wrapRef} className={className} data-massing>
      <canvas ref={canvasRef} role="img" aria-label={label} hidden={failed} />
      {failed && (
        <p className="pl-massing-fallback">
          The 3D model needs WebGL, which this browser has turned off. Everything else on the page works without it.
        </p>
      )}
    </div>
  );
}
