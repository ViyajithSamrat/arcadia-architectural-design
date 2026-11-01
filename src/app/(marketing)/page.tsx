import Image from "next/image";
import Link from "next/link";
import { Configurator } from "@/components/landing/Configurator";
import { PHOTOS, type Photo } from "@/components/landing/photos";
import { Reveal } from "@/components/landing/Reveal";
import { AuthNav } from "@/components/layout/auth-nav";
import { Wordmark } from "@/components/layout/brand";
import { MobileMenu, NavLinks, type NavItem } from "@/components/layout/nav-links";
import "@/components/landing/landing.css";
import "@/components/landing/home.css";

/** The three kinds of project, each opening its own journey. */
const PROJECTS: { href: string; kind: string; title: string; line: string; photo: Photo; layout: string }[] = [
  {
    href: "/new/empty-plot",
    kind: "New build",
    title: "A house on an empty plot",
    line: "Rooms, floors, setbacks and orientation become a brief, an illustrative 2D layout and exterior and interior concepts.",
    photo: PHOTOS.keralaHouse,
    layout: "md:col-span-7 md:row-span-2",
  },
  {
    href: "/new/interior",
    kind: "Interior",
    title: "Rooms, refreshed",
    line: "Room by room, keeping what has to stay.",
    photo: PHOTOS.jogloRoom,
    layout: "md:col-span-5",
  },
  {
    href: "/new/landscape",
    kind: "Landscape",
    title: "Gardens and outdoor rooms",
    line: "Shade, planting and a place to sit.",
    photo: PHOTOS.lalbaghTree,
    layout: "md:col-span-5",
  },
];

/** What a project produces, shown beside reference photographs of the kinds of place it starts from. */
const WORK: { title: string; text: string; photo: Photo }[] = [
  {
    title: "From an empty plot",
    text: "An illustrative 2D layout drawn from your plot size, floors and rooms, with exterior and interior concept images. A sketch to decide with, not a construction drawing.",
    photo: PHOTOS.vacantPlot,
  },
  {
    title: "Interiors with a point of view",
    text: "Concept images for the rooms you name, in the style you describe, respecting what must stay: the column, the window, the family heirloom.",
    photo: PHOTOS.livingRoom,
  },
  {
    title: "Landscapes that hold shade",
    text: "Planting, paths and places to sit, composed for your climate and your space. Plant choices still need a local expert before you dig.",
    photo: PHOTOS.lalbaghGarden,
  },
];

const PROCESS: { name: string; text: string }[] = [
  { name: "Describe", text: "Answer a few questions in your own words. Where voice input is switched on, you can speak your description in Tamil or English and correct the transcript." },
  { name: "Read the brief", text: "Your words become a clear English brief. Assumptions are marked and anything missing is asked for, so nothing is guessed in silence." },
  { name: "See every line", text: "An itemized quote, calculated on the server from the configured rates, with tax and total shown before you accept anything." },
  { name: "A person checks payment", text: "Pay by UPI or bank transfer and send the reference. Someone on the team checks the transfer before anything is drawn." },
  { name: "Concepts, released", text: "The concepts are generated, reviewed by a person and released to your account beside the brief they came from." },
];

const CAPABILITIES: { title: string; text: string }[] = [
  { title: "Voice or text", text: "Type, or speak your description where voice input is on. A transcript is yours to check before it becomes your brief." },
  { title: "A plain English brief", text: "Structured, readable and editable. Approve it only when it says what you mean." },
  { title: "Itemized quotation", text: "Every line priced on the server, with tax shown. An accepted quote never changes afterwards." },
  { title: "Illustrative layouts", text: "For new builds, a 2D layout sketch from your numbers: rooms, floors and plot, clearly labelled as illustrative." },
  { title: "AI concept imagery", text: "Exterior, interior and landscape concepts from an AI image model, generated only after payment is verified." },
  { title: "Private until released", text: "Payment evidence and generated images stay in private storage. A person reviews every image before you see it." },
];

const FAQ = [
  {
    q: "Can I build from these designs?",
    a: "No. They are concept designs to help you decide what you want. Have a qualified architect or engineer check dimensions, structure, safety and local rules before anything is built.",
  },
  {
    q: "Can I speak instead of typing?",
    a: "Where voice input is switched on, yes: record your description, check the transcript and, for Tamil, ask for an English translation you can correct. Typing always works.",
  },
  {
    q: "How do I pay?",
    a: "By UPI or bank transfer to the details shown after you accept a quote, then you send the transfer reference. We never ask for your PIN, OTP or banking password.",
  },
  {
    q: "When do I see my designs?",
    a: "After a person verifies your payment, the concepts are generated, reviewed and released to your account. Your project page shows which step you are on.",
  },
  {
    q: "Can I add photos of my space?",
    a: "Yes. Reference photos you add to a project are stored privately: only you and our reviewer can see them.",
  },
  {
    q: "What if the brief is wrong?",
    a: "Edit your answers or the English brief before you approve it. Anything assumed is marked as an assumption, and anything missing is listed, so you can correct it.",
  },
];

const HOME_NAV: readonly NavItem[] = [
  { href: "#work", label: "Work" },
  { href: "#process", label: "Process" },
  { href: "#studio", label: "Studio" },
  { href: "/projects", label: "My projects" },
];

const PHOTO_LIST = Object.values(PHOTOS);

const heroLink =
  "relative inline-flex min-h-11 items-center text-sm font-medium text-white/80 transition-colors duration-300 hover:text-white after:absolute after:inset-x-0 after:bottom-2 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-300 hover:after:scale-x-100";
const solid =
  "inline-flex min-h-12 items-center justify-center gap-3 rounded-[3px] bg-white px-7 text-[0.9375rem] font-semibold text-forest shadow-lift transition-[background-color,transform] duration-300 hover:bg-limestone active:translate-y-px";
const ghost =
  "inline-flex min-h-12 items-center justify-center gap-3 rounded-[3px] border border-white/45 px-7 text-[0.9375rem] font-semibold text-white transition-[background-color,border-color,transform] duration-300 hover:border-white hover:bg-white/10 active:translate-y-px";

export default function Home() {
  return (
    <div className="gn-home">
      <Reveal />
      <a
        href="#start"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[3px] focus:bg-white focus:px-4 focus:py-2 focus:text-forest"
      >
        Skip to starting a project
      </a>

      <header className="absolute inset-x-0 top-0 z-30 text-white">
        <div className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-8">
          <Wordmark tone="light" />
          <nav aria-label="Main" className="hidden md:block">
            <NavLinks items={HOME_NAV} className="flex items-center gap-8" linkClassName={heroLink} />
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <AuthNav
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-[3px] border border-white/40 px-3 text-sm font-semibold text-white transition-colors duration-300 hover:border-white hover:bg-white/10 sm:px-4"
              accountClassName="hidden max-w-[12rem] truncate text-sm text-white/75 xl:inline"
              tagClassName="rounded-[3px] bg-white px-2 py-1 text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-forest"
            />
            <MobileMenu>
              <nav aria-label="Main (small screens)" className="text-foreground">
                <NavLinks
                  items={HOME_NAV}
                  className="space-y-1"
                  linkClassName="flex min-h-11 w-full items-center text-base font-medium text-foreground"
                />
              </nav>
            </MobileMenu>
          </div>
        </div>
      </header>

      <main id="top">
        {/* Hero */}
        <section aria-labelledby="hero-title" className="gn-grain relative isolate flex min-h-[100dvh] items-end overflow-hidden bg-forest text-white">
          <Image
            src={PHOTOS.keralaHouse.src}
            alt={PHOTOS.keralaHouse.alt}
            fill
            sizes="100vw"
            loading="eager"
            fetchPriority="high"
            className="gn-hero__img -z-20"
          />
          <div aria-hidden="true" className="gn-hero__shade absolute inset-0 -z-10" />
          <div className="mx-auto w-full max-w-7xl px-5 pb-14 pt-32 sm:px-8 sm:pb-20">
            <div className="gn-hero__type max-w-5xl space-y-7">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/75">GNANI · Architectural AI studio</p>
              <h1 id="hero-title" className="gn-hero__title font-display font-medium">
                Architecture, <em className="font-normal italic text-[#d9d2c3]">reimagined.</em>
              </h1>
              <p className="max-w-xl text-lg leading-relaxed text-white/85 sm:text-xl">
                Describe the home, room or garden you have in mind. GNANI turns your words into a clear brief, an itemized quote and AI concept designs, each checked by a person before it reaches you.
              </p>
              <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:flex-wrap">
                <a href="#start" className={solid}>
                  Start your project <span aria-hidden="true" className="gn-arrow">→</span>
                </a>
                <a href="#work" className={ghost}>
                  Explore our work
                </a>
              </div>
            </div>
            <div className="mt-16 flex flex-wrap items-end justify-between gap-6 border-t border-white/20 pt-6 text-sm text-white/70">
              <ul className="flex flex-wrap gap-x-8 gap-y-2" aria-label="Project types">
                <li>New builds</li>
                <li>Interiors</li>
                <li>Landscapes</li>
              </ul>
              <a href="#start" className="inline-flex min-h-11 items-center gap-3 hover:text-white">
                Scroll <span aria-hidden="true" className="gn-cue inline-block">↓</span>
              </a>
            </div>
          </div>
        </section>

        {/* Statement */}
        <section aria-label="What GNANI does" className="mx-auto max-w-7xl px-5 py-24 sm:px-8 sm:py-36">
          <div className="grid gap-12 lg:grid-cols-12">
            <p className="eyebrow lg:col-span-3" data-reveal>
              The studio
            </p>
            <p className="gn-lead lg:col-span-9" data-reveal data-i="1">
              A design conversation that starts in your own words and ends with concepts you can hold up against your plot, your rooms and your budget. Ideas to decide with, made clear enough to discuss with an architect.
            </p>
          </div>
        </section>

        {/* Start: the three kinds of project */}
        <section id="start" aria-labelledby="start-title" className="mx-auto max-w-7xl scroll-mt-6 px-5 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-6 pb-10">
            <h2 id="start-title" className="gn-h2 max-w-3xl" data-reveal>
              Start with your space
            </h2>
            <p className="max-w-sm text-muted" data-reveal data-i="1">
              Choose the kind of project. Describing it costs nothing; you pay only after reading the brief and accepting the quote.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-12 md:grid-rows-2">
            {PROJECTS.map((p, i) => (
              <Link
                key={p.href}
                href={p.href}
                className={`group relative block min-h-[24rem] overflow-hidden rounded-[4px] bg-forest text-white md:min-h-[19rem] ${p.layout}`}
                data-reveal
                data-i={i}
              >
                <span className="gn-zoom absolute inset-0">
                  <Image src={p.photo.src} alt={p.photo.alt} fill sizes="(max-width: 768px) 100vw, 58vw" className="object-cover" />
                </span>
                <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-[rgb(15_28_24/0.88)] via-[rgb(15_28_24/0.35)] to-transparent" />
                <span className="relative flex h-full flex-col justify-end gap-2 p-6 sm:p-8">
                  <span className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">{p.kind}</span>
                  <span className="font-display text-3xl font-medium leading-tight sm:text-4xl">{p.title}</span>
                  <span className="max-w-md text-sm leading-relaxed text-white/80">{p.line}</span>
                  <span className="mt-2 inline-flex items-center gap-2 text-sm font-semibold">
                    Start this project <span aria-hidden="true" className="gn-arrow">→</span>
                  </span>
                </span>
              </Link>
            ))}
          </div>
          <p className="mt-4 text-sm text-muted" data-reveal>
            Reference photographs of the kinds of place people bring to us, from open photo collections. They are not GNANI projects; credits are at the foot of the page.
          </p>
        </section>

        {/* Work: what a project produces */}
        <section id="work" aria-labelledby="work-title" className="mx-auto max-w-7xl scroll-mt-6 px-5 py-24 sm:px-8 sm:py-36">
          <div className="grid gap-6 pb-16 lg:grid-cols-12">
            <p className="eyebrow lg:col-span-3" data-reveal>
              Featured concepts
            </p>
            <h2 id="work-title" className="gn-h2 lg:col-span-9" data-reveal data-i="1">
              What a project brings back to you
            </h2>
          </div>
          <div className="space-y-20 sm:space-y-28">
            {WORK.map((w, i) => (
              <article key={w.title} className="grid items-center gap-8 lg:grid-cols-12 lg:gap-12">
                {/* The sandstone ground shows while the lazy-loaded photograph arrives, so the frame never reads as empty. */}
                <figure className={`gn-zoom relative aspect-[4/3] overflow-hidden rounded-[4px] bg-sandstone/45 lg:col-span-7 ${i % 2 === 1 ? "lg:order-2 lg:col-start-6" : ""}`} data-reveal>
                  <Image src={w.photo.src} alt={w.photo.alt} fill sizes="(max-width: 1024px) 100vw, 56vw" className="object-cover" />
                </figure>
                <div className={`space-y-5 lg:col-span-5 ${i % 2 === 1 ? "lg:order-1 lg:col-start-1" : ""}`} data-reveal data-i="1">
                  <p className="font-display text-6xl font-normal leading-none text-sandstone tabular">0{i + 1}</p>
                  <h3 className="font-display text-4xl font-medium leading-tight">{w.title}</h3>
                  <p className="max-w-md text-lg leading-relaxed text-muted">{w.text}</p>
                  <p className="text-xs text-muted">
                    Reference photograph: {w.photo.title}, {w.photo.creator} ({w.photo.license})
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Process */}
        <section id="process" aria-labelledby="process-title" className="gn-grain relative scroll-mt-0 overflow-hidden bg-forest py-24 text-white sm:py-36">
          <div className="relative mx-auto max-w-7xl px-5 sm:px-8">
            <div className="grid gap-6 pb-16 lg:grid-cols-12">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60 lg:col-span-3" data-reveal>
                How it works
              </p>
              <h2 id="process-title" className="gn-h2 lg:col-span-9" data-reveal data-i="1">
                Checked by a person, then drawn
              </h2>
            </div>
            <ol className="grid border-t border-white/15 lg:grid-cols-5">
              {PROCESS.map((s, i) => (
                <li key={s.name} className="space-y-4 border-b border-white/15 py-8 lg:border-b-0 lg:border-r lg:px-6 lg:first:pl-0 lg:last:border-r-0" data-reveal data-i={String(i % 3)}>
                  <span className="font-display text-5xl leading-none text-sandstone tabular">{i + 1}</span>
                  <h3 className="text-lg font-semibold">{s.name}</h3>
                  <p className="max-w-md text-[0.9375rem] leading-relaxed text-white/75 lg:text-sm">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Capabilities */}
        <section id="capabilities" aria-labelledby="cap-title" className="mx-auto max-w-7xl scroll-mt-6 px-5 py-24 sm:px-8 sm:py-36">
          <div className="grid gap-12 lg:grid-cols-12">
            <div className="space-y-6 lg:sticky lg:top-10 lg:col-span-5 lg:self-start">
              <p className="eyebrow" data-reveal>
                Design capabilities
              </p>
              <h2 id="cap-title" className="gn-h2" data-reveal data-i="1">
                Everything a first conversation needs
              </h2>
              <p className="max-w-md text-lg leading-relaxed text-muted" data-reveal data-i="2">
                From the first sentence to released concepts, each step is visible, reversible until you approve it, and honest about what it is.
              </p>
            </div>
            <dl className="grid gap-x-10 sm:grid-cols-2 lg:col-span-7">
              {CAPABILITIES.map((c, i) => (
                <div key={c.title} className="space-y-3 border-t border-border-strong py-8" data-reveal data-i={String(i % 2)}>
                  <dt className="font-display text-2xl font-medium">{c.title}</dt>
                  <dd className="leading-relaxed text-muted">{c.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Configurator: an interactive massing sketch, kept from the previous homepage */}
        <section id="plan" aria-labelledby="plan-title" className="pl scroll-mt-6 border-y border-border bg-surface py-24 sm:py-32">
          <div className="mx-auto max-w-7xl space-y-12 px-5 sm:px-8">
            <div className="grid gap-6 lg:grid-cols-12">
              <p className="eyebrow lg:col-span-3">Try a massing study</p>
              <div className="space-y-5 lg:col-span-9">
                <h2 id="plan-title" className="gn-h2" data-reveal>
                  Sketch an example
                </h2>
                <p className="max-w-2xl text-lg leading-relaxed text-muted" data-reveal data-i="1">
                  Type a sentence or move the sliders to see the idea take shape. This is only a preview: nothing here is saved or priced, and your real brief is built step by step once you start a project.
                </p>
              </div>
            </div>
            <Configurator />
          </div>
        </section>

        {/* About */}
        <section id="studio" aria-labelledby="studio-title" className="mx-auto max-w-7xl scroll-mt-6 px-5 py-24 sm:px-8 sm:py-36">
          <div className="grid items-center gap-12 lg:grid-cols-12">
            <figure className="gn-zoom relative aspect-[4/5] overflow-hidden rounded-[4px] bg-sandstone/45 lg:col-span-5" data-reveal>
              <Image src={PHOTOS.jogloRoom.src} alt={PHOTOS.jogloRoom.alt} fill sizes="(max-width: 1024px) 100vw, 40vw" className="object-cover" />
            </figure>
            <div className="space-y-8 lg:col-span-6 lg:col-start-7">
              <p className="eyebrow" data-reveal>
                About the platform
              </p>
              <h2 id="studio-title" className="gn-h2" data-reveal data-i="1">
                AI for the sketch. People for the judgement.
              </h2>
              <div className="space-y-5 text-lg leading-relaxed text-muted" data-reveal data-i="2">
                <p>
                  GNANI uses language models to turn what you say into a structured brief, and an image model to draw concepts from it. Everything that matters is decided by people: your answers, your approval, the payment check and the release of every image.
                </p>
                <p>
                  The results are concept designs: a shared picture of what you want, to take to a qualified architect or engineer. They are not construction drawings and have not been checked against structure, safety or local rules.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Questions */}
        <section aria-labelledby="faq-title" className="border-t border-border-strong">
          <div className="mx-auto grid max-w-7xl gap-12 px-5 py-24 sm:px-8 sm:py-32 lg:grid-cols-12">
            <h2 id="faq-title" className="gn-h2 lg:col-span-4" data-reveal>
              Asked often
            </h2>
            <dl className="lg:col-span-8">
              {FAQ.map((f) => (
                <div key={f.q} className="grid gap-3 border-t border-border-strong py-7 sm:grid-cols-5 sm:gap-8" data-reveal>
                  <dt className="font-display text-2xl font-medium leading-snug sm:col-span-2">{f.q}</dt>
                  <dd className="leading-relaxed text-muted sm:col-span-3">{f.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Contact: begin */}
        <section aria-labelledby="begin-title" className="gn-grain relative isolate overflow-hidden bg-forest text-white">
          <Image src={PHOTOS.lalbaghGarden.src} alt="" fill sizes="100vw" className="-z-20 object-cover opacity-30" />
          <div className="mx-auto max-w-7xl px-5 py-28 sm:px-8 sm:py-40">
            <h2 id="begin-title" className="gn-h2 max-w-4xl" data-reveal>
              Tell us about your space.
            </h2>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/80" data-reveal data-i="1">
              Start a project and your conversation with the studio begins with your own description. Your project page shows every step and what happens next.
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap" data-reveal data-i="2">
              <Link href="/new/empty-plot" className={solid}>
                New build <span aria-hidden="true" className="gn-arrow">→</span>
              </Link>
              <Link href="/new/interior" className={ghost}>
                Interior refresh
              </Link>
              <Link href="/new/landscape" className={ghost}>
                Landscaping
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-[#0f1c18] text-white/70">
        <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
          <div className="grid gap-12 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-4">
              <p className="font-display text-4xl font-semibold tracking-[0.18em] text-white">GNANI</p>
              <p className="max-w-xs text-sm leading-relaxed">Architectural AI studio. Concept designs from your words. Every payment is checked by a person.</p>
            </div>
            <nav aria-label="Footer" className="lg:col-span-2">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-white/50">Projects</h2>
              <ul className="space-y-1 text-sm">
                <li><Link className="inline-flex min-h-9 items-center hover:text-white" href="/new/empty-plot">New build</Link></li>
                <li><Link className="inline-flex min-h-9 items-center hover:text-white" href="/new/interior">Interior design</Link></li>
                <li><Link className="inline-flex min-h-9 items-center hover:text-white" href="/new/landscape">Landscaping</Link></li>
                <li><Link className="inline-flex min-h-9 items-center hover:text-white" href="/projects">My projects</Link></li>
                <li><Link className="inline-flex min-h-9 items-center hover:text-white" href="/status">System status</Link></li>
              </ul>
            </nav>
            <div className="space-y-3 text-xs leading-relaxed lg:col-span-3">
              <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">Photographs</h2>
              <ul className="space-y-1.5">
                {PHOTO_LIST.map((p) => (
                  <li key={p.src}>
                    <a className="underline-offset-2 hover:text-white hover:underline" href={p.page} rel="noopener noreferrer" target="_blank">
                      {p.title}
                    </a>{" "}
                    by {p.creator},{" "}
                    <a className="underline-offset-2 hover:text-white hover:underline" href={p.licenseUrl} rel="noopener noreferrer license" target="_blank">
                      {p.license}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-3 text-xs leading-relaxed lg:col-span-3">
              <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">Good to know</h2>
              <p>
                These are conceptual design ideas, not construction drawings. Have a qualified professional validate dimensions, structure, safety and local regulations before building.
              </p>
              <p>The 3D model on this page is drawn in code from your numbers. It is a sketch, not a plan.</p>
            </div>
          </div>
          <div className="mt-14 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6 text-xs">
            <span>GNANI Architectural AI. Concept designs only: not construction drawings.</span>
            <a href="#top" className="inline-flex min-h-11 items-center hover:text-white">
              Back to top ↑
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
