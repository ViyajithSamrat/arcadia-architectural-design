# 13. Final Architecture Decision

For the four-day delivery, optimize for a secure, polished, end-to-end
concept-design workflow rather than claiming that generative images are
architecturally exact.

-   Use structured data and deterministic SVG rendering for labelled 2D
    room layouts.
-   Use OpenRouter image generation for static visual concepts.
-   Use Gnani through server-side adapters for voice interfaces.
-   Use a human-verified offline-payment workflow.
-   Enforce generation and release at the server boundary.
-   Keep uploaded and generated assets private until authorized.
-   Use a small, complete vertical slice with explicit fallbacks and
    honest demo labels.
-   Treat production security, professional validation, legal/tax
    review, load testing, and operational hardening as a separate
    follow-on phase.

**The defining product invariant is simple: no generation before
verified payment, and no customer release before authorized admin
approval.**
