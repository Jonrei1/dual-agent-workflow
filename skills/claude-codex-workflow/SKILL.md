---
name: dual-agent-workflow
description: >
  Set up the Claude + Codex workflow in a new or existing Git project: install tools, local
  rules, checks and the Codex queue handoff, plus the ponytail (senior dev and QA) and
  taste-skill (UI/UX) plugins. One execution driver, gates and checks before alignment, and one
  final Playwright UI audit that is headless or headed. Use for workflow installation,
  configuration and orchestrator handoff setup.
---

# Claude + Codex workflow: setup and reference

Daily operation is documented in [README](../../README.md#daily-use-what-happens-during-a-task).
Installed CLAUDE.local.md and .codex/workflow/CODEX.md own the agent instructions.
There is one driver: the open Codex session reached by codex queue. Verify runs gates and
project checks first, then one report-only alignment call. Close updates graphify;
interactive Claude uses handoff --phase N, reviews each passing phase and asks for explicit commit approval, then automatically
commits and hands off the next after approval (manual mode also waits before handoff). It records base HEAD and checkpoint SHAs
in the task summary, preserves unrelated staged/unstaged work, and never stashes or pushes.
Final QA covers the full diff from base HEAD, including committed phases; frontend and QA fixes
get separate checked commits, each requiring fresh approval, including retries. Pending/rejected
approval or failed commits block continuation; empty phases need no commit.
Headless Claude calls = (phases + reworks) alignment calls, and no UI calls.
Roles: Codex builds the backend only (a plan's phases never include frontend files). Claude builds
every frontend itself from the start, after Codex finishes, and audits it with Playwright
against the plan's `## UI audit`, so there is no Codex-builds-then-Claude-fixes rework.
ponytail keeps changes small (Codex builds in its mode; Claude runs /ponytail-review as the QA
pass and the alignment review applies the same lens). taste-skill guides the frontend Claude builds.
Every UI plan records `- Browser: headless | headed`, which Claude asks the user.
Plan review uses Codex usage through autopilot.js review before handoff.

## When invoked

1. Check whether the project is new or existing and is a Git repo. Ask before git init.
2. If graphify is missing and no scope is supplied, ask user-only (recommended) or global;
   pass --graphify-scope=user|global. Global pip usually needs administrator rights.
3. Run `node <this skill's folder>/scripts/install.js` from the target project root with
   the chosen flags. A headless installer cannot prompt; report missing tools and ask
   before adding --yes unless tool installation is already authorized.
4. Show created/merged/skipped steps, check git status, and explain any tracked-file notices.
   Propose verify.json if checks are unsuitable, alignment.riskPaths for risky modules, and
   UI defaults (startCommand, url, viewports) for an app.
5. List remaining setup steps below. Never commit, stage, stash or push user changes.

## Setup

```
/dual-agent-workflow:setup
npx github:Jonrei1/Claude-Codex-Workflow
node <skill folder>/scripts/install.js
```

Requires Node 18+ and Git; use a supported Node LTS and OS for browser tooling.
The installer checks/installs Claude Code, Codex CLI, Playwright MCP and matching Chromium,
graphify, and the ponytail and taste-skill plugins. Sign in to the CLIs separately.
Playwright is registered for Claude in user scope, with absolute executable paths and
--isolated, as `playwright` (--headless) and `playwright-headed` (a visible window). The two
skills are installed as user-scope plugins for Claude and Codex (`claude plugin install`,
`codex plugin add`); nothing from them goes into the repo. Existing registrations and plugins
are preserved, and installed Chromium is reused. Graphify uses uv tool, pipx or pip --user
for user scope; global scope uses system pip. See README for machine prerequisites.

| Flag | Meaning |
|---|---|
| --yes | Approve missing machine tools, Playwright setup and the two plugins |
| --dry-run | Print actions without installation or writes |
| --tools-only | Machine setup only |
| --project-only | Project setup only; no tools/browser/MCP/plugin installation |
| --graphify-scope=user|global | Choose graphify installation scope |
| --skip-graphify | Skip graphify project integration; tools stage still checks it |
| --skip-playwright | Skip browser package, download and registrations |
| --skip-skills | Skip the ponytail and taste-skill plugins |
| --root <dir> | Configure the Git repo containing that directory |
| --sync | Quiet, files-only upgrade of a set-up project; run by the plugin's SessionStart hook |

Re-running upgrades the .codex/ scripts, .codex/workflow/CODEX.md and the CLAUDE.local.md
section, deletes files an earlier version installed that this one dropped (recorded in
.codex/workflow-manifest.json), and refreshes the plan template while unedited. After a plugin
update, the SessionStart hook runs install.js --sync in projects that have a manifest (and in
their linked git worktrees), so no re-run is needed.

### Project files

Workflow state is local through .git/info/exclude. Setup and sync never write or delete a
tracked file: a tracked hooks file with the legacy Stop hook is only reported, with the fix.
Stale-script removal is limited to .codex/*.js, .codex/hooks/*.js and .codex/workflow/*.md; a
committed manifest is ignored. Each developer sets up their own clone; nothing is shared
through git. See the [upgrade notes](../../README.md#upgrading).

| Template | Destination | Action |
|---|---|---|
| CLAUDE.workflow.md | CLAUDE.local.md | Replace the Workflow section (ends at its end marker; notes below it are kept) |
| AGENTS.codex.md | .codex/workflow/CODEX.md | Copy current rules |
| codex/autopilot.js | .codex/autopilot.js | Copy driver coordination helper |
| codex/hooks/*.js | .codex/hooks/ | Copy alignment runner, library and plan hook |
| codex/hooks.json | .codex/hooks.json | Merge graphify PreToolUse guards when untracked |
| plans/_template.md | .codex/plans/_template.md | Create if missing; an older unedited-or-v2 copy is backed up to _template.previous.md |

Setup adds an ExitPlanMode reminder in .claude/settings.local.json and reports old tracked
workflow sections for team cleanup.

### Left for you

- Restart Claude Code so it loads local rules, the plan hook and the plugins; inspect /mcp for
  playwright and playwright-headed. In Codex, trust the plugin and workflow hooks (/hooks).
- Sign in to Claude/Codex and keep a Codex session open in the repo.
- Allow review/verify/UI close network access and long command timeouts (30 minutes).
- Scaffold an app first if new; build the initial graph with /graphify . once code exists.
- Check detected commands and add verify.json as needed. Project-only setup skips browser installation.

## Checks

A verify.json checks array overrides detection (an empty array disables project checks).
Otherwise every detected stack is included; builds run last and parallelChecks false serializes.

| Root marker | Detected checks |
|---|---|
| package.json | typecheck or tsc --noEmit, lint, build, non-watch test; package manager from lockfile |
| Cargo.toml | cargo check, cargo test |
| go.mod | go vet ./..., go build ./..., go test ./... |
| Python project markers | ruff, mypy and pytest when their configuration/markers exist |

The plan's gates join these checks, deduplicated and compared against the begin baseline.
New failures return to Codex without a model call. The alignment review is read-only, uses
structured verdicts with a text fallback and caps at 40 turns; it reports MUST FIX (a concrete failing case: fails the phase) and COULD
BE CUT (advice), and counts unrequested dependencies, abstractions and any frontend change as out
of scope. High risk uses Opus. `check` rejects a phase whose Scope names frontend files, and a
ui: yes plan needs a `## Frontend (Claude)` section. Configure checks, parallelChecks, baseline,
alignment, ui (startCommand, url, viewports, headed), handoff and headless in verify.json; see
[the complete example](../../README.md#configure-verification). Inspect commands with
`node .codex/hooks/claude-verify.js --print-checks`.

Run state and reports live in .codex/autopilot/ and .codex/verify/<task>/. A run records who
started it. The plan and verify.json are hashed at begin; changing either mid-run stops the run.

## Command reference

| Command | Purpose |
|---|---|
| check PLAN | Validate plan shape and runnable gates |
| review PLAN | Read-only ephemeral Codex findings before handoff |
| handoff PLAN [--phase N] [--continue] [--thread ID] [--wait SEC] [--print] | Post to the open Codex session, or print paste line |
| wait PLAN [--since ISO] [--timeout SEC] | Watch run/session and print outcome/reports |
| begin PLAN | Starting snapshot, failure baseline, owner and input hashes |
| phase PLAN N | Phase snapshot; automatically begin if needed |
| verify PLAN N | Gates/checks, then alignment on green code |
| stop PLAN --reason TEXT | Record an explicit stuck outcome |
| close PLAN | Graph update, then done |

All commands use `node .codex/autopilot.js`. Exit codes: 0 pass/done/paused, 1 failed,
2 gate/check failure, 3 alignment/UI rework, 4 stuck, 5 paste, 6 wait timeout.
Single-phase handoffs pause after intermediate PASS and wait prints the next handoff command.
Claude asks for approval and commits the passing phase before sending that command automatically
(except manual mode). Always show the files, diff summary and message and wait for explicit approval
before every commit; prior approval never covers another commit.
The helper and Codex never commit; a direct full-plan handoff has no intermediate Claude checkpoints.

## Troubleshooting

- Missing tools: check PATH/authentication, then re-run setup with authorized installation flags.
- Old workflow still runs: start a new session after a plugin update (SessionStart runs --sync)
  or run setup --project-only once if there is no workflow-manifest.json; restart both CLIs.
- "Committed manifest isn't trusted": git rm --cached .codex/workflow-manifest.json, run setup.
- "Newer than this plugin": update the plugin; setup and sync never downgrade a project.
- A run says "changed after the run began": the plan or verify.json was edited; run begin again.
- Another run is active: finish or stop it, or use a git worktree for the second task.
- Paste fallback: keep Codex open in the repo or pin --thread; queue/app-server is experimental.
- Failed/stuck: read status/logs and .codex/verify/<task>/alignment.md, fix the blocker, then handoff --continue.
- Browser tools missing: check /mcp for playwright and playwright-headed, and the Playwright and Chromium setup.
- A headed window won't open: the machine has no display (Linux without DISPLAY/WAYLAND_DISPLAY); use headless.
- check says a phase Scope is not backend only: move the frontend files to ## Frontend (Claude).
- Conflicting checks: parallelChecks false. Monorepo checks: explicit checks in verify.json.

## Tools considered

Playwright CLI is a browser-efficiency follow-up; MCP remains the integration.
Claude Code LSP plugins are optional per-user installs. Existing graphify handles code relationships.
