"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SPEC } from "@/lib/landing/preview";
import { MassingCanvas } from "./MassingCanvas";

const STAGES = [
  {
    name: "Say it",
    title: "Say it your way",
    text: "Describe the space you want in your own words: a plot and its rooms, an interior to refresh, or a garden. Architectural AI Design turns your answers into a brief, a quote and, after payment is checked, concept designs.",
  },
  {
    name: "Brief",
    title: "Read it back",
    text: "Your words become a clear English brief. Every assumption is marked and anything missing is asked for, so nothing is guessed in silence.",
  },
  {
    name: "Quote",
    title: "See every line",
    text: "An itemized quote, line by line, with tax shown and calculated on the server from configured rates. Edit your brief as often as you need before you approve it.",
  },
  {
    name: "Payment",
    title: "A person checks it",
    text: "Pay by UPI or bank transfer and send the reference. Someone on our team checks the transfer, and nothing is drawn until they have.",
  },
  {
    name: "Release",
    title: "Released to you",
    text: "Concepts are drawn, reviewed, then released to your account beside the brief they came from. They are ideas to decide with, not construction drawings.",
  },
] as const;

const HERO_SPEC = DEFAULT_SPEC["new-build"];

export function Hero() {
  const sectionRef = useRef<HTMLElement>(null);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const run = r.height - window.innerHeight;
      const p = run > 0 ? Math.min(1, Math.max(0, -r.top / run)) : 0;
      setStage(Math.min(STAGES.length - 1, Math.floor(p * STAGES.length * 0.999)));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const goTo = useCallback((i: number) => {
    const el = sectionRef.current;
    if (!el) return;
    const run = el.offsetHeight - window.innerHeight;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: top + ((i + 0.5) / STAGES.length) * run, behavior: smooth ? "smooth" : "auto" });
  }, []);

  return (
    <section ref={sectionRef} className="pl-hero" aria-labelledby="pl-name">
      <div className="pl-hero__sticky">
        <MassingCanvas
          className="pl-hero__model"
          spec={HERO_SPEC}
          stage={stage}
          label="A white architectural model of a two-storey house on a 30 by 40 foot plot, building up as the journey moves from description to release."
        />

        <div className="pl-hero__stages" aria-live="polite">
          {STAGES.map((s, i) => (
            <div key={s.name} className="pl-hero__stage" data-active={i === stage} aria-hidden={i !== stage}>
              <h2 className="pl-hero__title">{s.title}</h2>
              <p className="pl-hero__text">{s.text}</p>
              {i === 0 && (
                <Link className="pl-btn" href="/new/empty-plot" tabIndex={i === stage ? 0 : -1}>
                  Start a design brief
                </Link>
              )}
              {i === STAGES.length - 1 && (
                <a className="pl-btn" href="#plan" tabIndex={i === stage ? 0 : -1}>
                  Try it on your plot
                </a>
              )}
            </div>
          ))}
        </div>

        <nav className="pl-hero__rail" aria-label="How a project moves">
          <ol>
            {STAGES.map((s, i) => (
              <li key={s.name}>
                <button type="button" aria-current={i === stage ? "step" : undefined} onClick={() => goTo(i)}>
                  {s.name}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <h1 id="pl-name" className="pl-hero__name">
          <span>Architectural</span>
          <span>AI Design</span>
        </h1>
      </div>
    </section>
  );
}
