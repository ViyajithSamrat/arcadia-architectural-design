import Image from "next/image";
import Link from "next/link";
import { Configurator } from "@/components/landing/Configurator";
import { Hero } from "@/components/landing/Hero";
import { PHOTOS, type Photo } from "@/components/landing/photos";
import { Reveal } from "@/components/landing/Reveal";
import "@/components/landing/landing.css";

const PANELS: { href: string; title: string; line: string; photo: Photo; grow: number }[] = [
  {
    href: "/new/empty-plot",
    title: "New build on an empty plot",
    line: "An illustrative 2D layout and exterior and interior concepts.",
    photo: PHOTOS.keralaHouse,
    grow: 5,
  },
  {
    href: "/new/interior",
    title: "Interior refresh",
    line: "Room by room, keeping what has to stay.",
    photo: PHOTOS.jogloRoom,
    grow: 3,
  },
  {
    href: "/new/landscape",
    title: "Landscaping",
    line: "Shade, planting and a place to sit.",
    photo: PHOTOS.lalbaghTree,
    grow: 3,
  },
];

const STEPS: { lead: string; text: string; photo: Photo; crop: string }[] = [
  {
    lead: "Before you pay,",
    text: "you read the brief and every line of the quote. Edit what is wrong and answer what is missing; nothing moves forward until you approve the brief and accept the quote.",
    photo: PHOTOS.vacantPlot,
    crop: "portrait",
  },
  {
    lead: "When you pay,",
    text: "you transfer by UPI or bank to the details shown with your accepted quote and send the reference. Sending it does not mark you as paid: a person on the team checks the transfer first.",
    photo: PHOTOS.livingRoom,
    crop: "square",
  },
  {
    lead: "Once it is checked,",
    text: "the concepts are drawn and kept private. You see them when they are released to your account, beside the brief they came from, with the status of every step shown while you wait.",
    photo: PHOTOS.lalbaghGarden,
    crop: "wide",
  },
];

const FAQ = [
  {
    q: "Can I build from these designs?",
    a: "No. They are concept designs to help you decide what you want. Have a qualified architect or engineer check dimensions, structure, safety and local rules before anything is built.",
  },
  {
    q: "Can I speak instead of typing?",
    a: "Not yet. Voice input is not configured in this version, so every step works by typing. When voice is switched on, you can still type, and the brief always comes back to you in plain English to check.",
  },
  {
    q: "How do I pay?",
    a: "By UPI or bank transfer to the details shown after you accept a quote, then you send the transfer reference. We never ask for your PIN, OTP or banking password. Payment instructions arrive in the next stage of this build.",
  },
  {
    q: "When do I see my designs?",
    a: "After a person verifies your payment, the concepts are drawn, reviewed and released to your account. The project page shows which step you are on.",
  },
  {
    q: "Can I upload photos or floor plans?",
    a: "Not yet. Uploads are switched off until the accepted file types, size limit and private storage rules are confirmed. You can describe your space in words instead.",
  },
  {
    q: "What if the brief is wrong?",
    a: "Edit your answers or the English brief before you approve it. Anything assumed is marked as an assumption, and anything missing is listed, so you can correct it.",
  },
];

const PHOTO_LIST = Object.values(PHOTOS);

export default function Home() {
  return (
    <div className="pl">
      <Reveal />
      <a className="pl-skip" href="#plan">
        Skip to the project sketch
      </a>

      <header className="pl-header">
        <a className="pl-header__mark" href="#top" aria-label="Architectural AI Design, back to top">
          Architectural AI Design
        </a>
        <nav aria-label="Projects">
          <Link href="/new/empty-plot">New build</Link>
          <Link href="/new/interior">Interior</Link>
          <Link href="/new/landscape">Landscaping</Link>
          <Link href="/projects">My projects</Link>
        </nav>
        <Link className="pl-btn pl-btn--small" href="/new/empty-plot">
          Start a brief
        </Link>
      </header>

      <main id="top">
        <Hero />

        <section className="pl-band" aria-labelledby="pl-band-h">
          <h2 id="pl-band-h" className="pl-h2" data-reveal>
            Three kinds of project
          </h2>
          <div className="pl-band__row">
            {PANELS.map((p, i) => (
              <Link
                key={p.href}
                className="pl-band__panel"
                href={p.href}
                style={{ "--grow": p.grow } as React.CSSProperties}
                data-reveal
                data-i={i}
              >
                <Image
                  src={p.photo.src}
                  alt={p.photo.alt}
                  fill
                  sizes="(max-width: 760px) 100vw, 50vw"
                  className="pl-band__img"
                />
                <span className="pl-band__label">
                  <span className="pl-band__title">{p.title}</span>
                  <span className="pl-band__line">{p.line}</span>
                  <span className="pl-band__go">Start this project</span>
                </span>
              </Link>
            ))}
          </div>
          <p className="pl-caption" data-reveal>
            Places like the ones people bring to us, from open photo collections. They are not our projects; credits are
            at the foot of the page.
          </p>
        </section>

        <section id="plan" className="pl-plan" aria-labelledby="pl-plan-h">
          <div className="pl-plan__head">
            <h2 id="pl-plan-h" className="pl-h2" data-reveal>
              Sketch an example
            </h2>
            <p className="pl-lead" data-reveal>
              Type a sentence or move the sliders to see the idea take shape. This is only a preview: nothing here is
              saved or priced, and your real brief is built step by step once you start a project.
            </p>
          </div>
          <Configurator />
        </section>

        <section className="pl-steps" aria-labelledby="pl-steps-h">
          <h2 id="pl-steps-h" className="pl-h2 pl-steps__h" data-reveal>
            Checked, then drawn
          </h2>
          {STEPS.map((s, i) => (
            <div key={s.lead} className={`pl-step pl-step--${s.crop}`}>
              <figure className="pl-step__fig" data-reveal>
                <Image
                  src={s.photo.src}
                  alt={s.photo.alt}
                  width={s.photo.width}
                  height={s.photo.height}
                  sizes="(max-width: 760px) 100vw, 45vw"
                />
              </figure>
              <p className="pl-step__text" data-reveal data-i={i}>
                <strong>{s.lead}</strong> {s.text}
              </p>
            </div>
          ))}
        </section>

        <section className="pl-price" aria-labelledby="pl-price-h">
          <h2 id="pl-price-h" className="pl-price__h" data-reveal>
            Every line
            <br />
            of the quote shown
          </h2>
          <div className="pl-price__foot" data-reveal>
            <p>
              Your quote is itemized and calculated on the server from the configured rates, with tax and total shown.
              Until the rates are confirmed by the business, any quote is labelled as demonstration pricing and is not an
              approved price.
            </p>
            <Link className="pl-btn pl-btn--paper" href="/new/empty-plot">
              Start a design brief
            </Link>
          </div>
        </section>

        <section className="pl-faq" aria-labelledby="pl-faq-h">
          <h2 id="pl-faq-h" className="pl-faq__title">
            Asked often
          </h2>
          <dl>
            {FAQ.map((f) => (
              <div key={f.q} className="pl-faq__row" data-reveal>
                <dt className="pl-faq__q">{f.q}</dt>
                <dd className="pl-faq__a">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="pl-close" aria-labelledby="pl-close-h">
          <h2 id="pl-close-h" className="pl-close__h" data-reveal>
            Tell us about
            <br />
            your space.
          </h2>
          <div className="pl-close__foot" data-reveal>
            <p>Describing it costs nothing. You pay only after you have read the brief and accepted the quote.</p>
            <Link className="pl-btn" href="/new/empty-plot">
              Start a design brief
            </Link>
          </div>
        </section>
      </main>

      <footer className="pl-footer">
        <div className="pl-footer__cols">
          <ul className="pl-footer__places">
            <li>
              <Link href="/new/empty-plot">New build</Link>
            </li>
            <li>
              <Link href="/new/interior">Interior design</Link>
            </li>
            <li>
              <Link href="/new/landscape">Landscaping</Link>
            </li>
            <li>
              <Link href="/projects">My projects</Link>
            </li>
          </ul>
          <div className="pl-footer__small">
            <h2>Photographs</h2>
            <ul>
              {PHOTO_LIST.map((p) => (
                <li key={p.src}>
                  <a href={p.page} rel="noopener noreferrer" target="_blank">
                    {p.title}
                  </a>{" "}
                  by {p.creator},{" "}
                  <a href={p.licenseUrl} rel="noopener noreferrer license" target="_blank">
                    {p.license}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="pl-footer__small">
            <h2>Good to know</h2>
            <p>
              These are conceptual design ideas, not construction drawings. Have a qualified professional validate
              dimensions, structure, safety and local regulations before building.
            </p>
            <p>The 3D model on this page is drawn in code from your numbers. It is a sketch, not a plan.</p>
          </div>
        </div>
        <div className="pl-footer__legal">
          <span>Architectural AI Design prototype. Concept designs only.</span>
          <a href="#top">Back to top</a>
        </div>
        <p className="pl-footer__name" aria-hidden="true">
          <span>Architectural</span>
          <span>AI Design</span>
        </p>
      </footer>
    </div>
  );
}
