# Claude + Codex workflow

A Claude Code plugin and standalone installer that gives Claude and Codex a shared way to plan, implement, verify and document work in a Git project. One setup command installs missing tools, including **Playwright MCP and Chromium**, and adds project instructions and execution helpers.

## What this setup is for

The purpose is to make an AI coding task concrete and reviewable: agree on what should change, divide it into phases with executable checks, implement each phase, and compare the result against the approved plan. Local files carry the requirements between Claude and Codex, and Claude sends the plan to your open Codex session itself, so there is nothing to copy and paste. When Codex finishes, Claude reviews the result without being asked.

Everything the workflow writes stays local to your clone: plans, verify logs, task summaries and the agents' workflow rules are hidden through `.git/info/exclude`, and setup keeps workflow state out of tracked files. Upgrades remove legacy workflow hooks from project and user hook files, preserving unrelated entries; this cleanup can change a tracked project hooks file.

Claude can implement a task directly, or act as planner while Codex implements. In the orchestrated workflow, project checks run locally and one headless Claude call reviews each passing phase against the plan. This adds a second review pass and a record of findings. It also adds model usage and time; choose direct implementation when that overhead is unnecessary.

The workflow supports new or existing repositories and detects checks for several stacks. Browser tooling has its own platform requirements. You control the final changes: agents do not commit, stage, stash or push your work. You review and commit it yourself.

## How the tools help

| Tool | Role in this setup | Benefit |
|---|---|---|
| Claude Code | Interactive planner, implementer and summary writer; headless alignment reviewer | Turns a request into acceptance criteria and phases, then checks whether the implementation satisfies them. |
| Codex CLI | Implements approved phases, runs gates and fixes findings | Carries a task through every phase from one handoff; optional plan review checks assumptions before implementation. |
| Playwright MCP + Chromium | One headless Claude UI audit at close; your Claude session reads its report | Navigation, clicks, forms, console errors, failed requests, screenshots and several viewport sizes, judged against the plan's UI audit items. |
| graphify | Shared codebase knowledge graph and search/read hooks | Helps find affected modules and dependents before editing, so plans include relevant files and checks. |
| Impeccable (optional) | Design skills and UI feedback hooks | Uses `PRODUCT.md` and `DESIGN.md` to guide UI work and flag design issues during implementation. |
| caveman | Optional terse replies | Reduces prose output; file reads, reasoning, tool results and reviews still consume usage. No fixed percentage saving is guaranteed. |
| Autopilot helper and alignment runner | Local Node scripts under `.codex/` | Track snapshots, run gates, launch reviews, record verdicts and close tasks. The scripts coordinate agents; they are not another model. |

For example, for a checkout-page change, Claude can identify dependencies with graphify and, if you installed the optional Impeccable, specify the design with it. Codex implements the phases. Gates and project checks run executable assertions first, then Claude reviews each diff against the plan. One final Playwright UI audit runs at close.

## Install once, configure each project

### Prerequisites

- Node.js and npm, with `npx` available. The installer requires Node 18+, but **use a current supported Node LTS for browser tooling**; current Playwright Test documentation lists Node 22/24/26.
- Git and a repository for project setup. Scaffold a new app and run `git init` yourself before setup.
- Claude and Codex accounts or supported API authentication. Installing the CLIs does not sign you in or include model usage.
- `uv`, `pipx`, or Python if graphify needs installing. For a global (all users) graphify install, Python's `pip` and administrator/root rights.

Use a supported operating system for browser tooling. See the official [Playwright installation requirements](https://playwright.dev/docs/intro#system-requirements) for the current platform list.

### Through the Claude Code plugin

In Claude Code:

```text
/plugin marketplace add Jonrei1/Claude-Codex-Workflow
/plugin install claude-codex-workflow@claude-codex-workflow
```

Open the target project and run:

```text
/claude-codex-workflow:setup --yes
```

Before running the installer, Claude asks you two questions, because the installer itself cannot prompt from inside Claude:

| Question | Asked when | Your choices |
|---|---|---|
| Install **Impeccable** (design skills and UI hooks)? | Always, unless you passed `--impeccable` or `--skip-impeccable` | Yes adds `--impeccable`; no adds `--skip-impeccable`. Optional, mainly useful for UI work. |
| Install **graphify** for your user only, or globally? | Only when graphify isn't installed and you didn't pass `--graphify-scope` | **User** (recommended): into your home directory with `uv tool`, `pipx` or `pip --user`, no admin rights. **Global**: system-wide `pip`, shared by every user, usually needs admin/root rights. |

`--yes` approves missing global tool installations (Claude Code and Codex CLI through npm), the Chromium download and missing Playwright MCP registrations. It does not answer the two questions above. The terminal installer asks them itself, with Impeccable defaulting to no and graphify defaulting to user. With `--yes`, `--dry-run` or no terminal, it skips Impeccable and uses the user scope for graphify. A headless Claude command cannot prompt and reports incomplete steps for you to address.

### Without the plugin

From the target Git project root:

```sh
npx github:Jonrei1/Claude-Codex-Workflow --yes
```

To inspect intended changes without installing or writing anything:

```sh
npx github:Jonrei1/Claude-Codex-Workflow --dry-run
```

The machine tools are shared across projects. Run full setup once on each development machine, then run setup in every repository that should use the workflow. Once the tools and browser registrations are ready, use `--project-only` in additional projects to skip machine setup.

### What the installer does

| Step | Action | Location |
|---|---|---|
| Prerequisites | Checks Node and Git; reports missing prerequisites rather than installing them | Your machine |
| Agent CLIs | Installs missing `@anthropic-ai/claude-code` and `@openai/codex` through npm | Global npm packages |
| Playwright | Installs missing `@playwright/mcp`, locates its bundled Playwright dependency, and downloads matching Chromium if absent | Global npm package and user browser cache |
| Browser connections | Adds a missing `playwright` MCP registration for Claude in user scope (and Codex with `--playwright-codex`) | `~/.claude.json` (and `~/.codex/config.toml`), shared across projects |
| graphify | If missing, asks for scope. **User** (default): `uv tool`, then `pipx`, then `pip --user`. **Global**: system-wide `pip install`, usually needing admin/root | Your user directory, or system-wide for global |
| Helpers | Copies or updates workflow-owned Node scripts and the Codex rules | `.codex/autopilot.js`, `.codex/hooks/`, `.codex/workflow/CODEX.md` |
| Claude rules and plan hook | Merges the `## Workflow` section and an `ExitPlanMode` hook that reminds Claude to confirm the role and hand the plan off | `CLAUDE.local.md`, `.claude/settings.local.json` |
| Codex hooks | Merges graphify guards into an untracked project hook file and removes legacy workflow verification entries from both project and user hook files, preserving other hooks | `.codex/hooks.json`, or `~/.codex/hooks.json` |
| Templates and skills | Creates the missing plan template and caveman skills; moves untracked plans from an old `plans/` folder | `.codex/plans/`, `.claude/skills/caveman/`, `.agents/skills/caveman/` |
| Project integrations | Only if you opt in, runs `npx -y impeccable install --project --providers=claude,codex` (Impeccable writes shared files of its own). graphify's own project installers edit `CLAUDE.md`/`AGENTS.md`, so they run only with `--shared` | With Impeccable, design skills and hooks |
| Local-only ignores and checks | Hides every workflow path through `.git/info/exclude` (never `.gitignore`), and prints detected verification commands | `.git/info/exclude` and installer output |

Fresh local setup keeps `git status` clean. Tracked files are otherwise left alone; the upgrade cleanup of legacy hooks is an explicit exception. Re-running updates workflow-owned `.codex/` scripts and the `## Workflow` section in `CLAUDE.local.md`; existing customized plan and caveman templates are kept. If an older version of the workflow left sections in tracked `CLAUDE.md`, `AGENTS.md` or `.gitignore`, setup points them out; remove them with your team in a normal commit. Existing Playwright registrations are preserved and matching Chromium is reused. Keeping an existing registration does not prove it connects successfully; check `/mcp`.

### Flags

| Flag | Effect |
|---|---|
| `--yes` | Approve missing machine tools and Playwright setup without installer prompts. Doesn't install Impeccable, and graphify uses the user scope. |
| `--dry-run` | Print intended actions without installing or writing files/configuration. |
| `--tools-only` | Set up machine tools, Chromium and Playwright registrations; skip project files and integrations. |
| `--project-only` | Configure the project using existing tools; skip machine installations, Chromium download and MCP registration. |
| `--skip-playwright` | Skip Playwright package, browser download and registrations. |
| `--playwright-codex` | Also register Playwright MCP for Codex. By default only Claude gets it, since Claude does the UI audits. |
| `--shared` | Write the old team-wide layout instead of local files: sections in `CLAUDE.md` and `AGENTS.md`, `.gitignore` entries, and graphify's project installers. Tracked files change, so commit them as a team. |
| `--graphify-scope=user` or `global` | Choose where a missing graphify is installed without being asked. Default `user`; `global` is system-wide `pip` and usually needs admin/root rights. |
| `--skip-graphify` | Skip graphify's project integrations (only run with `--shared`); the tools stage still checks/installs graphify. |
| `--impeccable` | Install Impeccable. Without it, a terminal installer asks; `--yes`, `--dry-run` and a non-interactive run skip it. |
| `--skip-impeccable` | Don't install Impeccable and don't ask. |
| `--impeccable-providers=codex` | Implies `--impeccable`; installs design skills only for Codex when Claude already uses the Impeccable plugin. |
| `--update-sections` | With `--shared`: replace existing workflow sections in `CLAUDE.md` and `AGENTS.md` with bundled versions. Without it, `CLAUDE.local.md` is always kept current. |
| `--root <dir>` | Configure the Git repository containing that directory. |

### Finish initial setup

1. Open `claude` and follow its sign-in flow; run `codex login` if needed.
2. Restart both clients (Claude Code loads `CLAUDE.local.md` and the plan hook at start). Check `/mcp` in Claude for Playwright, or run `claude mcp get playwright`.
3. Review and trust the workflow hooks in Codex using `/hooks` when needed in `.codex/hooks.json`. Later hook changes require trusting them again.
4. Allow the helper's `verify` and UI `close` commands network access and a long timeout when Codex requests approval: they start headless Claude sessions. (`review` runs before handoff, from Claude, and calls `codex exec` read-only.)
5. Once the project has code, build the initial graph with `/graphify .` in Claude Code. If you chose a user-scope graphify and `graphify` isn't found, add `~/.local/bin` (or the Python user scripts folder) to `PATH`.
6. If you installed Impeccable, run `/impeccable init` for `PRODUCT.md`; for an existing UI, follow with `/impeccable document` for `DESIGN.md`. Use `/impeccable doctor` for an older design setup.
7. Review detected checks and add `.codex/verify.json` if they are missing or unsuitable. For UI work, add its `ui` block so Claude can start and audit the app (see [Configure verification](#configure-verification)).
8. Optional: run `node .codex/autopilot.js usage` after a task to see headless Claude token usage and cost.

## Playwright browser tools

Playwright is included in default **machine setup**. The browser download uses the Playwright version inside the installed MCP package, avoiding a browser mismatch with a separately fetched version.

New registrations use absolute Node, server and Chromium paths, with `--headless` and `--isolated`. Browser sessions have separate state and no visible window, so the agents do not share a persistent profile. Existing registrations retain their settings. See the official [Playwright MCP guide](https://github.com/microsoft/playwright-mcp) for server capabilities and options.

Claude uses Playwright once at close for an orchestrated `ui: yes` task. After project checks pass,
the helper reuses the running app or starts the plan's command, audits every viewport and UI
check, saves screenshots under `.codex/verify/<task>/final-ui/`, and stops an app it started.
The report is `.codex/verify/<task>/final-ui-audit.md`. Interactive Claude reads that report.
BLOCKED (for example a missing browser or an app that cannot start) is reported but does not
fail close. A failed UI check returns NEEDS REWORK to Codex.

You can also ask Claude directly to inspect a URL with Playwright. Pages behind a login need
state you provide. MCP provides browser tools; it does not create project test suites.
For repeatable UI acceptance, prefer a project `@playwright/test` spec gate using aria
snapshots (`toMatchAriaSnapshot`) or `@axe-core/playwright` where suitable. Project specs and
browser versions are independent of the global MCP installation.
Minimal Linux systems may need [Chromium system dependencies](https://playwright.dev/docs/browsers).

## Daily use: what happens during a task

1. Describe the task to Claude. For each app-code plan it asks who implements:
   Codex (Claude orchestrates), Claude directly, or Codex with manual phases.
2. Claude saves the approved plan to `.codex/plans/<task>.md` and runs
   `node .codex/autopilot.js check .codex/plans/<task>.md`, fixing what it lists.
   Plans use acceptance ids, scoped phases, runnable gates and explicit Hands off interfaces.
   With `ui: yes`, one plan-wide `## UI audit` section provides URL, start command and checks.
3. For `review: codex` or `risk: high`, Claude runs `autopilot.js review PLAN` before handoff.
   This uses one read-only, ephemeral `codex exec` call with a findings schema. Claude
   assesses the findings with you, edits the plan as agreed and checks it again.
4. Claude runs `autopilot.js handoff PLAN`. The only execution driver is your open Codex
   session, reached through `codex queue`. The app-server selects the newest user session
   in the repo, or `--thread <id>` pins one. It waits up to 90 seconds if none is open.
   If queue/session lookup fails, exit 5 prints the line to paste. Claude names the chosen
   session and starts `autopilot.js wait PLAN` in the background.
5. Codex calls `begin`, then `phase N`, implements within scope and calls `verify N`.
   Begin snapshots the untouched tree and records every gate/check as the failure baseline.
   Gates and project checks run as one deduplicated set, concurrently with builds last.
   New failures return exit 2 to Codex before any Claude call. Baseline failures are carried
   over without blocking. Three consecutive new failures stop the run as stuck.
6. Green gates/checks reach exactly one report-only alignment call (Sonnet/medium, Opus for
   high risk or configured risk paths), with write tools denied, a structured verdict and a
   40-turn cap. The small phase diff is inlined in a stable prompt; larger diffs are read
   from disk. NEEDS REWORK returns exit 3 to Codex; failure after two reworks stops the run.
   Reports and diffs are kept per phase; the verified snapshot advances only on PASS.
7. `close` is deterministic coordination. For `ui: yes`, checks run before one headless UI
   audit (80-turn cap). Exit 2 or 3 sends fixes back to Codex within the union of phase scopes.
   Then `graphify update .` runs and the state becomes done. Close makes no summary call.
8. When `wait` returns, interactive Claude reads the reports and final UI report, spot-checks
   the diff, writes `.codex/tasks/<date>-<task>.md` from its template and reports to you.
   On stuck/failed it explains the reason and asks before handing off a continuation.
   You review the working tree and commit it yourself.

Manual phases use the same driver and verification: `handoff PLAN --phase N` records the
phase; `phase N` begins the run when needed. PASS on an intermediate handed-off phase sets
paused, and `wait` exits 0 with the next `handoff --phase` command. The final phase calls close.
`wait` also watches the Codex session: a turn ending or session closing mid-run marks it
stuck and passes on the last message. `stop --reason` records an explicit blocker.
Snapshots use a temporary Git index and tree objects, preserving your staging index and branches.

## Configure verification

Checks are detected from root Node, Rust, Go and Python markers. For monorepos or custom
checks, save `.codex/verify.json` using only commands your project supports:

```json
{
  "checks": ["npm run typecheck", "npm run lint", "npm test"],
  "parallelChecks": true,
  "alignment": { "model": "sonnet", "effort": "medium", "riskModel": "opus", "riskPaths": ["src/auth/**", "migrations/**"] },
  "ui": { "startCommand": "npm run dev", "url": "http://localhost:3000", "readyTimeoutSec": 90, "viewports": [375, 1280], "model": "sonnet", "effort": "medium" },
  "handoff": { "thread": "", "waitSeconds": 90 },
  "headless": { "settingSources": "project,local" }
}
```

`checks` replaces detection; `[]` disables project checks, while phase gates still run.
`parallelChecks: false` runs checks sequentially. The plan overrides UI start command, URL
and viewports. `baseline: false` disables the initial failure baseline. Failed commands are
compared by diagnostic lines, ignoring locations, counts and timings and counting repetitions.
`headless.settingSources` is optional: user settings may carry authentication/proxy settings.

```sh
node .codex/hooks/claude-verify.js --print-checks
node .codex/autopilot.js check .codex/plans/<task>.md
```

## Token usage for Claude and Codex

The installer itself calls no models; installation through Claude uses conversation tokens.
Claude and Codex have separate usage accounting. Headless Claude uses its own authenticated
account or API credentials. This plugin does not supply credits or combine billing.

Headless Claude calls = **(phases + reworks)** alignment calls, plus **(1 + UI reworks)**
when `ui: yes`. Three phases without rework use three calls, or four with UI. Gate/check
failures before alignment add no model calls. Plan review is one Codex call, counted as
Codex usage. Interactive planning and the final review/summary are separate Claude usage.
Calls may contain several turns and tools; call counts are not token counts.

Each headless call uses only its required built-in tools and no MCP servers, except the
final UI audit's Playwright server. JSON verdicts come from structured_output, with text
verdicts supported for older CLIs. Every call records tokens, cache usage, model, effort,
turns and API list-price cost in `.codex/verify/usage.jsonl`:

```sh
node .codex/autopilot.js usage
node .codex/autopilot.js usage .codex/plans/<task>.md
```

This log excludes Codex and interactive sessions; an API-equivalent estimate is not a
subscription invoice. Compare actual usage through the clients and account dashboards.
See [Claude cost guidance](https://code.claude.com/docs/en/costs) and
[Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Upgrading from 2.x

Re-run setup. Version 3 removes `autopilot.js run`, `--resume`/`--force` for that driver,
`--new-terminal`, the Codex Stop hook and its locks, `phase.json` inference, headless
`triage` and `.orig.md`, the Step A fixer (`checks-fix`), per-phase UI audit blocks and
headless task-summary calls. Legacy workflow hooks are removed from both project and
user files, preserving unrelated entries; review a tracked hooks file's migration diff.
Existing customized plan templates are kept: align them with the bundled v3 template.

## Tools considered

`@playwright/cli` is a follow-up for browser token savings; the current integration remains
Playwright MCP. Claude Code's LSP plugins are optional per-user installs. Serena, repomix
and ast-grep overlap with graphify, so they are not added here.

## Reports and troubleshooting

| File | Purpose |
|---|---|
| `.codex/autopilot/status.json`, `<task>.log` | Run state, phase, reason and progress |
| `.codex/autopilot/<task>.baseline.json` | Starting gate/check failures |
| `.codex/verify/<task>/plan-review.json` | Read-only plan findings |
| `.codex/verify/<task>/phase-<N>.*` | Alignment, gate/check output and diff |
| `.codex/verify/<task>/final-ui-audit.md`, `final-ui/` | Final UI report and screenshots |
| `.codex/verify/last.log`, `alignment.md`, `phase.diff` | Latest alignment run |
| `.codex/tasks/<date>-<task>.md` | Interactive Claude's task summary |

- Plan did not reach Codex: keep its session open in the repo, pin a thread if needed,
  or paste the exit-5 line. Queue/app-server support is experimental and needs a recent CLI.
- Wait timeout (6): inspect the Codex session, then wait again. Stuck (4) or failed (1):
  read the reason and reports, resolve it and hand off with `--continue`.
- UI BLOCKED: check `final-ui.app.log`, the app URL, browser installation and login state.
  Re-run full setup if Playwright is missing; project-only setup does not install it.
- Checks conflict when parallel: set parallelChecks false. Wrong checks: use verify.json.
- Headless launch/network failure: verify CLI authentication, PATH and execution permissions;
  allow a 30-minute timeout for review, verify and UI close.
- Impeccable is optional. Follow PRODUCT.md and DESIGN.md when installed; use
  `/impeccable doctor` for stale design context and remove its live block before committing.

## Repository layout

The [skill](skills/claude-codex-workflow/SKILL.md) covers setup flags, check detection and
file destinations. Templates live in `skills/claude-codex-workflow/templates/`; Node helpers
and installers are under that skill's `scripts/` and `templates/codex/` directories.
`commands/setup.md` is the Claude plugin entry point, and `.claude-plugin/` holds metadata.
Run `npm test` for installer, protocol, verification, browser-setup and usage regressions
using fake CLIs, without model calls, browser downloads or changes to user configuration.
