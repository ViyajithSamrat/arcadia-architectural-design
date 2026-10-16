# Architectural AI Design --- Claude Code Build Prompts

These prompts divide implementation into seven gated phases. Read
`00_BUILD_ORCHESTRATION.md` first. Then paste only the prompt for the
phase you are currently approved to execute.

## Recommended order

1.  `01_REPOSITORY_BASELINE.md`
2.  `02_DATABASE_AUTH_STORAGE.md`
3.  `03_CUSTOMER_JOURNEYS_UI.md`
4.  `04_PAYMENT_EVIDENCE_ADMIN.md`
5.  `05_AI_TEXT_VOICE.md`
6.  `06_IMAGE_GENERATION_RELEASE.md`
7.  `07_END_TO_END_QA_DEMO_HANDOFF.md`

The sequence may be adjusted only if the approved execution plan
explains why. In particular, image generation must never precede tested
payment verification and asset-access controls.

## How to use

1.  Keep these files in the project repository, for example under
    `prompts/build/`.
2.  Ensure Claude Code can read `CLAUDE.md`, the source specs, the
    approved execution plan, and the environment guide.
3.  Start with Phase 1. Paste the relevant prompt in Claude Code.
4.  Review the final report and acceptance criteria.
5.  Test the phase. Approve the next phase explicitly.
6.  Never paste real API secrets into prompts or Markdown files.

## Important

These prompts are execution guidance, not a replacement for project
specifications. Claude Code must follow the actual approved requirements
and repository state. If a source document conflicts with these prompts,
stop and document the conflict instead of silently overriding the
source.


## Optional skill integration

Read `SKILL_INTEGRATION_PLAN.md` before starting the build. This package has been updated to support:
- gstack as personal/global only (not copied into the repository);
- selective ECC use only;
- Taste Skill for Phase 3 design work if installed and reviewed;
- no frontend template adoption until candidate templates are provided and approved.

`CLAUDE_PROJECT_ADDENDUM.md` is a candidate updated instruction file based on the previously generated project `CLAUDE.md`. Review it before manually merging or replacing your repository's `CLAUDE.md`; this package does not modify your actual project repository.
