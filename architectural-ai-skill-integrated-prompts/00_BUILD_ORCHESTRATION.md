# Build Orchestration --- Read Before Each Phase

Use this as the shared operating contract for all implementation phases.

You are implementing the Architectural AI Design Web Prototype described
by the repository's `CLAUDE.md` and detailed specification documents.

## Mandatory startup routine

1.  Read `CLAUDE.md`.
2.  Read the approved `docs/EXECUTION_PLAN.md` (or the actual approved
    execution plan filename), `docs/REQUIREMENTS_TRACEABILITY.md`,
    `docs/PLANNING_DECISIONS.md`, and the source documents relevant to
    the requested phase.
3.  Inspect the repository and `git status` before editing.
4.  Check the current phase, its prerequisites, unresolved blockers, and
    acceptance criteria.
5.  Summarize the phase objective, expected changes, dependencies, and
    tests before starting.

## Execution rules

-   Implement only the phase explicitly requested by the user.
-   Preserve existing work and follow the existing package manager,
    framework, code style, and directory conventions.
-   Do not reset, discard, or overwrite unrelated changes.
-   Do not install a dependency unless it is needed, justified, and
    compatible with the project. Explain why before installing.
-   Do not run migrations, deploy, incur paid API usage, or make
    destructive changes without explicit approval.
-   Do not invent provider endpoints, model identifiers, API request
    shapes, or successful test results.
-   Keep all secret values out of source code, logs, screenshots, client
    bundles, and Markdown files.
-   Keep real environment values blank until the owner supplies them.
    Use safe mocks only when clearly labelled as mocks.
-   If a blocker prevents a safe implementation, implement independent
    work where possible and report the blocked work rather than
    bypassing safeguards.
-   Update documentation and requirement traceability when behavior or
    implementation decisions change.
-   Do not move to the next phase automatically. Stop after the current
    phase and report results.

## Security invariants

-   A customer-submitted payment screenshot is not proof of settlement.
-   Generation must be authorized by trusted server-side checks after an
    authorized administrator verifies payment.
-   Generated assets and payment evidence remain private by default.
-   Only an authorized administrator can verify/reject payment and
    release assets.
-   Customers can access only their own permitted records and assets.
-   Database and Storage authorization must be enforced server-side and
    through appropriate policies, not merely UI state.
-   Provider/model output is untrusted and must be validated.
-   AI concepts must not be described as construction-ready, certified,
    code-compliant, CAD, or BIM deliverables unless such capabilities
    are explicitly implemented and verified.

## Required final report

At the end of the phase, report: 1. Summary of implemented behavior. 2.
Files created/modified. 3. Requirements IDs addressed. 4. Commands
actually run and their actual results. 5. Tests passed, failed, skipped,
or blocked. 6. Security review and remaining risks. 7. Manual setup or
credentials still required (names only; never request or display secrets
unnecessarily). 8. Acceptance criteria status. 9. Any plan/spec changes
and why. 10. Recommended next phase, without starting it.

Stop and wait for approval.


## Optional skills and third-party workflow tools

Before using Taste Skill, gstack, ECC, or a frontend template, read `SKILL_INTEGRATION_PLAN.md`.

- These tools are optional accelerators, not project dependencies or sources of truth.
- Confirm the relevant skill/command is actually installed before invoking it.
- Use gstack only if available in the user's personal/global Claude Code environment; never vendor it into this repository because the owner selected global-only installation.
- Use ECC selectively. Do not add duplicate install paths, duplicate hooks, or broad permissions.
- Use Taste Skill mainly during Phase 3 design work. Review its installed instructions first; project security, accessibility, and product requirements take precedence.
- No frontend template has been approved yet. Do not invent one or pull in a template before the owner supplies candidates and they are reviewed.
- Do not execute installation scripts, alter global Claude settings, add MCP servers, change permissions, deploy, or spend paid API credits without explicit approval.
- In the final phase report, state which optional tools were actually available and used. Never imply an install or skill invocation happened if it did not.
