# Phase 1 --- Repository Baseline and Application Foundation

Paste this prompt into Claude Code after reviewing the build
orchestration file.

## Objective

Establish a stable, minimal application foundation that matches the
approved project architecture and the repository's current state. Do not
build the complete product in this phase.

## Instructions

Follow `CLAUDE.md` and `00_BUILD_ORCHESTRATION.md`. Read the TRD, UI/UX
specification, architecture decision, implementation plan, and approved
execution plan.

### 1. Inspect before editing

-   Identify the framework, package manager, scripts, source layout,
    installed dependencies, lint/typecheck/test tools, and existing
    routes/components.
-   Inspect Git status and preserve unrelated work.
-   If an application already exists, extend it rather than recreating
    it.
-   If the repository is empty or incomplete, choose only the minimum
    foundation explicitly supported by the approved technical plan.

### 2. Foundation work

Implement only the approved foundation needed for subsequent phases: -
Application shell and routing structure. - TypeScript and existing
lint/type-check conventions. - Existing approved styling and component
system. - Shared layout, navigation, responsive page frame, and
accessible base components as appropriate. - Centralized server-side
environment validation that checks variable presence without logging
values. - A clear integration-status/configuration pattern for optional
services. - Basic not-found and error handling appropriate to the
framework.

Do not build fake business flows or claim integrations work. Avoid
unnecessary UI polish before the actual flows are implemented.

### 3. Environment rules

Use `ENVIRONMENT_VARIABLES.md` and `.env.example` as a reference, but
verify each variable against the approved implementation. Do not add
redundant variables automatically. Do not reveal or commit `.env.local`.
Do not require optional service credentials to run unrelated foundation
work.

### 4. Acceptance criteria

-   The application starts using the repository's documented command.
-   Available lint/type-check/build checks run and results are reported
    accurately.
-   Base routing and layout work.
-   Missing configuration produces safe, actionable messages without
    exposing secrets.
-   No protected flow is falsely represented as functional.
-   No unrelated files or changes are lost.
-   Documentation reflects the actual repository setup.

### 5. Stop condition

Do not implement database schema, authentication workflows, payment
verification, or AI generation in this phase. Report blockers and wait
for approval.


### Optional tooling
Read `SKILL_INTEGRATION_PLAN.md`. Do not spend time integrating all optional skills during the foundation phase. If ECC is installed, use only relevant existing conventions; do not install or enable new tools automatically. gstack is personal/global only and must not be added to the repository. Do not apply Taste Skill before the actual user journeys and visual requirements are understood.
