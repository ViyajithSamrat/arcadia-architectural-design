"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import {
  buildBrief,
  DEFAULT_SPEC,
  normalise,
  parseDescription,
  TYPE_CONFIG,
  type PlotSpec,
  type ProjectType,
} from "@/lib/landing/preview";
import { MassingCanvas } from "./MassingCanvas";

const TYPES: ProjectType[] = ["new-build", "interior", "landscape"];

/** Where each preview kind leads once the visitor starts a real project. */
const START_HREF: Record<ProjectType, string> = {
  "new-build": "/new/empty-plot",
  interior: "/new/interior",
  landscape: "/new/landscape",
};

/**
 * A sketch the visitor can play with. It runs entirely in the browser, saves nothing,
 * prices nothing and is not the project brief: the real journey validates and stores
 * the requirements on the server. Browser speech recognition is deliberately absent so
 * the page never suggests that the voice integration is live.
 */
export function Configurator() {
  const [spec, setSpec] = useState<PlotSpec>(DEFAULT_SPEC["new-build"]);
  const [text, setText] = useState("");
  const [heard, setHeard] = useState<string>("");
  const ids = useId();
  const cfg = TYPE_CONFIG[spec.type];
  const brief = useMemo(() => buildBrief(spec), [spec]);

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      if (TYPES.includes(h as ProjectType)) setSpec(DEFAULT_SPEC[h as ProjectType]);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const update = (patch: Partial<PlotSpec>) => setSpec((s) => normalise({ ...s, ...patch }));

  const chooseType = (t: ProjectType) => {
    setSpec(DEFAULT_SPEC[t]);
    setHeard("");
  };

  const read = (value = text) => {
    if (!value.trim()) {
      setHeard("Type a sentence first, or use the example.");
      return;
    }
    const { spec: next, understood } = parseDescription(value, spec);
    setSpec(next);
    setHeard(
      understood.length
        ? `Understood: ${understood.join(", ")}.`
        : "We could not pick out sizes or rooms from that. Try something like the example, or set them below.",
    );
  };

  return (
    <div className="pl-config">
      <div className="pl-config__top">
        <MassingCanvas
          className="pl-config__model"
          spec={spec}
          stage={4}
          label={`A white architectural model of an example ${cfg.label.toLowerCase()} project: ${brief.summary}`}
        />

        <form className="pl-config__controls" onSubmit={(e) => e.preventDefault()} aria-label="Sketch an example project">
          <fieldset className="pl-seg">
            <legend>Project</legend>
            <div>
              {TYPES.map((t) => (
                <button key={t} type="button" aria-pressed={spec.type === t} onClick={() => chooseType(t)}>
                  {TYPE_CONFIG[t].label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="pl-field">
            <label htmlFor={`${ids}-say`}>Describe it in your words</label>
            <textarea
              id={`${ids}-say`}
              rows={3}
              maxLength={600}
              value={text}
              placeholder={cfg.example}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="pl-row">
              <button type="button" className="pl-btn pl-btn--small" onClick={() => read()}>
                Read my words
              </button>
              <button
                type="button"
                className="pl-link"
                onClick={() => {
                  setText(cfg.example);
                  read(cfg.example);
                }}
              >
                Use the example
              </button>
            </div>
            <p className="pl-note" aria-live="polite">
              {heard || "This preview reads typing only. In a real project, voice input is offered where it is switched on."}
            </p>
          </div>

          <div className="pl-field">
            <label htmlFor={`${ids}-w`}>
              {cfg.widthLabel} <output htmlFor={`${ids}-w`}>{spec.widthFt} ft</output>
            </label>
            <input
              id={`${ids}-w`}
              type="range"
              {...cfg.width}
              value={spec.widthFt}
              onChange={(e) => update({ widthFt: Number(e.target.value) })}
            />
          </div>
          <div className="pl-field">
            <label htmlFor={`${ids}-d`}>
              {cfg.depthLabel} <output htmlFor={`${ids}-d`}>{spec.depthFt} ft</output>
            </label>
            <input
              id={`${ids}-d`}
              type="range"
              {...cfg.depth}
              value={spec.depthFt}
              onChange={(e) => update({ depthFt: Number(e.target.value) })}
            />
          </div>

          {cfg.showFloors && (
            <fieldset className="pl-seg">
              <legend>Floors</legend>
              <div>
                {[1, 2, 3].map((f) => (
                  <button key={f} type="button" aria-pressed={spec.floors === f} onClick={() => update({ floors: f })}>
                    {f === 1 ? "Ground only" : f === 2 ? "Two floors" : "Three floors"}
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          <div className="pl-field">
            <label htmlFor={`${ids}-r`}>
              {cfg.roomsLabel} <output htmlFor={`${ids}-r`}>{spec.rooms}</output>
            </label>
            <input
              id={`${ids}-r`}
              type="range"
              {...cfg.rooms}
              value={spec.rooms}
              onChange={(e) => update({ rooms: Number(e.target.value) })}
            />
          </div>

          <fieldset className="pl-seg">
            <legend>Style</legend>
            <div>
              {cfg.styles.map((s) => (
                <button key={s.id} type="button" aria-pressed={spec.style === s.id} onClick={() => update({ style: s.id })}>
                  {s.label}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="pl-check">
            <input type="checkbox" checked={spec.garden} onChange={(e) => update({ garden: e.target.checked })} />
            {cfg.gardenLabel}
          </label>
        </form>
      </div>

      <div className="pl-config__bottom">
        <article className="pl-config__brief" aria-labelledby={`${ids}-bh`}>
          <h3 id={`${ids}-bh`}>What you sketched</h3>
          <p className="pl-config__summary">{brief.summary}</p>
          <div className="pl-config__lists">
            <div>
              <h4>Sizes in the sketch</h4>
              <ul>
                {brief.facts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
        </article>

        <article className="pl-config__quote" aria-labelledby={`${ids}-qh`}>
          <h3 id={`${ids}-qh`}>Make it a real brief</h3>
          <p>
            This sketch is only an illustration and is not saved. Starting a project asks the questions a real brief
            needs, keeps your answers private to your account, and shows an itemized quote calculated from the
            configured rates.
          </p>
          <div className="pl-row">
            <Link className="pl-btn" href={START_HREF[spec.type]}>
              Start a {cfg.label.toLowerCase()} project
            </Link>
          </div>
          <p className="pl-note">The 3D sketch is not a plan and nothing here is priced.</p>
        </article>
      </div>
    </div>
  );
}
