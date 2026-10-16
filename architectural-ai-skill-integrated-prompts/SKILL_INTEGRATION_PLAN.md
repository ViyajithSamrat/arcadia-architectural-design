# Skill Integration Plan â€” Architectural AI Design Web Prototype

## Chosen operating model

- **gstack:** Personal/global installation only. Do not vendor it into this repository, add it as a submodule, or require teammates to install it.
- **Everything Claude Code (ECC):** Selective components only. Inspect and install only components that support this project. Never stack multiple ECC installation methods for the same Claude Code environment.
- **Taste Skill:** Use the frontend design skill during design-heavy work. Its current `design-taste-frontend` v2 is described by its repository as experimental; review its instructions before relying on it.
- **Frontend templates:** Not yet supplied/reviewed. Do not select or implement a template until the owner shares candidate links/files and they have been assessed for framework fit, license, accessibility, responsive behavior, dependencies, and fit to the app's user journeys.

## Safe installation / configuration checklist

### Taste Skill
The user may install this personally with:
`npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"`

Before relying on it:
- Inspect the installed `SKILL.md` and any scripts it asks to run.
- Treat the skill as advisory, not as higher-priority project policy.
- Preserve accessible UI, responsive behavior, Next.js/TypeScript conventions, and approved product scope.
- Do not accept stylistic requirements that conflict with accessibility, security, or existing approved product requirements.
- Use it chiefly for the customer-facing visual system, responsive composition, typography, spacing, and restrained motion.

### gstack
The user chose **personal/global only**. Installation is a local user action and has not been performed by this document.
- Follow the current official gstack README/setup instructions and prerequisites; do not blindly assume the provided clone command remains current.
- Review the setup script before running it. Do not execute it automatically.
- Do not add gstack files to this repository or make project teammates depend on it.
- Add the global gstack section to the user's global `~/.claude/CLAUDE.md` only if the user explicitly chooses to make that change. Do not overwrite existing global instructions.
- The global instructions can recommend `/browse` for browser-based browsing where appropriate and list installed commands only after checking the installed version.
- Do not claim that any gstack skill is available until Claude Code confirms it is installed and visible.
- Never use browser/MCP tooling to bypass site access controls or the user's permissions.

### Everything Claude Code (ECC)
Use one installation route per Claude Code environment:
- Preferred official route per current ECC documentation: inspect and run its guided setup, selecting **user/global scope** and a minimal/core or otherwise narrowly selected set of components.
- Alternatively, use the official native Claude Code plugin route. Do not also run a full manual installation over that plugin.
- For a selective manual route, preview the exact file plan first and choose only relevant skills/rules, such as TypeScript/common rules, TDD/testing workflow, security review, and code review if available in the installed version.
- Do not install all hooks, agents, skills, or rules by default.
- Review hook commands, permissions, network use, file writes, and MCP configuration before enabling them.
- Do not duplicate plugin-managed hooks in `settings.json`.
- Use only official repository/documented distribution channels. Never install a third-party mirror.
- Keep ECC global/user-scoped unless the owner explicitly asks for project-scoped configuration.

### Prompt hierarchy and conflict resolution
1. Security invariants and approved product requirements in project `CLAUDE.md` and specs.
2. Explicit user decisions.
3. Phase prompt and approved execution plan.
4. Third-party skills, agents, hooks, templates, and generated recommendations.
5. Model assumptions.

If a skill conflicts with a security invariant, follow the project invariant and report the conflict.

## Suggested use by phase

| Phase | Skill/tool usage |
|---|---|
| 01 Repository baseline | ECC planning/code conventions only if installed; avoid premature visual polish |
| 02 Database/auth/storage | ECC testing/security-review components; gstack engineering review only if installed |
| 03 Customer journeys/UI | Taste Skill for visual direction; assess frontend templates first if supplied; gstack design review if installed |
| 04 Payment evidence/admin | ECC security review and tests; no UI-only trust decisions |
| 05 AI text/voice | ECC testing/code review; verify provider docs |
| 06 Image generation/release | ECC security review and workflow tests; preserve server-side generation gates |
| 07 End-to-end QA | gstack `/qa` and `/review` if installed; ECC testing/security review if installed; report actual commands/results |

## Stop conditions
Stop and ask before:
- executing an unfamiliar installation script or granting new permissions;
- installing a large dependency set;
- applying a database migration to a shared/production environment;
- enabling hooks that run arbitrary shell commands;
- using paid API credits or deploying;
- choosing a frontend template whose license or source is unclear.

## Sources checked on 2026-10-16
- ECC: https://github.com/affaan-m/ECC
- Taste Skill: https://github.com/Leonxlnx/taste-skill
- gstack: https://github.com/garrytan/gstack

Project repositories evolve. Check their current README, release notes, license, and installation instructions at installation time.
