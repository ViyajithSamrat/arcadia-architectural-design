# Phase 3 --- Customer Journeys and Core UI

## Objective

Build the customer-facing experience for the three project types,
requirements capture, brief review, and itemized quote. Use the approved
UI/UX and app-flow specifications.

## Scope

-   New build on an empty plot.
-   Interior refresh.
-   Landscaping.
-   Text input for project requirements.
-   Voice input only if its integration is available and approved;
    otherwise show an explicit disabled or mock state.
-   Validated structured English brief.
-   Quote presentation based on the approved pricing rules.
-   Clear navigation, progress, loading, empty, success, and error
    states.

## Instructions

Read `CLAUDE.md`, PRD, app flow, UI/UX, runtime prompt templates,
backend schema, and approved execution plan. Reuse the project's
established component system and style conventions.

### Requirements

1.  Provide clear project-type selection.
2.  Capture only the fields required by the specifications; use
    conditional fields for different project types where appropriate.
3.  Validate inputs on both client and server where relevant.
4.  Create a structured brief through a server-side service boundary. If
    no real model is configured, use a clearly labelled deterministic
    mock for development; never imply the live model was called.
5.  Quote calculations must follow documented pricing/business rules. If
    pricing rules are missing or contradictory, stop that part and
    request clarification instead of inventing prices.
6.  Ensure customer-owned projects are tied to the authenticated user
    when authentication is required.
7.  Persist data through the approved data layer; do not treat browser
    state as durable or authoritative.
8.  Do not expose provider keys in client-side code.
9.  Make the interface responsive and accessible.
10. Label generated design output as conceptual and illustrative.

### Visual quality and templates
Read `SKILL_INTEGRATION_PLAN.md`. If Taste Skill's `design-taste-frontend` is installed, inspect its `SKILL.md` and use it to develop a distinctive, coherent visual direction for the customer experience. Treat its v2 behavior as experimental and review output carefully. Accessibility, responsive behavior, performance, and approved product requirements remain mandatory.

No frontend template has been approved yet. If the owner has supplied candidates, compare framework compatibility, license, dependencies, responsive behavior, accessibility, component quality, and fit to the three journeys before adopting one. Otherwise build on the approved component system and do not silently introduce a template.

### Acceptance criteria

-   All three customer journeys can be started and navigated.
-   Input validation and error messages are useful.
-   Brief output follows a predictable validated structure.
-   Quote displays the approved line items and totals.
-   Data persistence follows the approved model.
-   Unconfigured integrations are clearly distinguished from live
    integrations.
-   Tests cover validation, project-type branching, brief parsing, and
    quote rules.

Do not implement payment verification, actual image generation, or admin
asset release in this phase. Stop and report.
