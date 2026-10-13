---
name: claude-codex-workflow
description: >
  Set up the Claude + Codex workflow in a new or existing Git project: install tools,
  local rules, checks and the Codex queue handoff. Uses one execution driver, gates and
  checks before alignment, and one final Playwright UI audit. Impeccable is optional.
  Use for workflow installation, configuration and orchestrator handoff setup.
---

# Claude + Codex workflow: setup and reference

Daily operation is documented in [README](../../README.md#daily-use-what-happens-during-a-task).
Installed CLAUDE.local.md and .codex/workflow/CODEX.md own the agent instructions.
There is one driver: the open Codex session reached by codex queue. Verify runs gates and
project checks first, then one report-only alignment call. Close runs one UI audit for
ui: yes and updates graphify; interactive Claude reads reports and writes the task summary.
Headless Claude calls = (phases + reworks) alignment, plus (1 + UI reworks) for ui: yes.
Plan review uses Codex usage through autopilot.js review before handoff.

## When invoked

1. Check whether the project is new or existing and is a Git repo. Ask before git init.
2. Ask about optional Impeccable unless flags already choose it. Explain its installer
   writes shared files. Pass --impeccable or --skip-impeccable; when Claude already has its
   plugin, use --impeccable-providers=codex. --yes does not choose Impeccable.
3. If graphify is missing and no scope is supplied, ask user-only (recommended) or global;
   pass --graphify-scope=user|global. Global pip usually needs administrator rights.
4. Run `node <this skill's folder>/scripts/install.js` from the target project root with
   the chosen flags. A headless installer cannot prompt; report missing tools and ask
   before adding --yes unless tool installation is already authorized.
5. Show created/merged/skipped steps, check git status, and explain any tracked hook cleanup.
   Propose verify.json if checks are unsuitable, alignment.riskPaths for risky modules, and
   UI defaults (startCommand, url, viewports) for an app. Do not enable --shared unasked.
6. List remaining setup steps below. Never commit, stage, stash or push user changes.

## Setup

```
/claude-codex-workflow:setup
npx github:Jonrei1/Claude-Codex-Workflow
node <skill folder>/scripts/install.js
```

Requires Node 18+ and Git; use a supported Node LTS and OS for browser tooling.
The installer checks/installs Claude Code, Codex CLI, Playwright MCP and matching Chromium,
and graphify. Sign in to the CLIs separately. Playwright is registered for Claude in user
scope, with absolute executable paths and --headless --isolated; --playwright-codex adds
Codex registration. Existing registrations are preserved, and installed Chromium is reused.
Graphify uses uv tool, pipx or pip --user for user scope; global scope uses system pip.
Impeccable installs only when opted in. See README for machine prerequisites and browser setup.

| Flag | Meaning |
|---|---|
| --yes | Approve missing machine tools and Playwright setup; Impeccable stays optional |
| --dry-run | Print actions without installation or writes |
| --tools-only | Machine setup only |
| --project-only | Project setup only; no tools/browser/MCP installation |
| --shared | Team layout in CLAUDE.md, AGENTS.md and .gitignore |
| --update-sections | With --shared, replace existing rule sections |
| --impeccable, --skip-impeccable | Choose optional design skills |
| --impeccable-providers=codex | Install design skills for Codex only; implies --impeccable |
| --graphify-scope=user|global | Choose graphify installation scope |
| --skip-graphify | Skip graphify project integration; tools stage still checks it |
| --skip-playwright | Skip browser package, download and registrations |
| --playwright-codex | Also register browser tools for Codex |
| --root <dir> | Configure the Git repo containing that directory |
| --sync | Quiet, files-only upgrade of a set-up project; run by the plugin's SessionStart hook |

Re-running upgrades the .codex/ scripts, .codex/workflow/CODEX.md and the CLAUDE.local.md
section, deletes files an earlier version installed that this one dropped (recorded in
.codex/workflow-manifest.json), and refreshes the plan template and caveman skills while
unedited. After a plugin update, the SessionStart hook runs install.js --sync in projects that
have a manifest, so no re-run is needed.

### Project files

Workflow state is local through .git/info/exclude. Tracked team rules are left alone unless
--shared is requested. Upgrade cleanup of legacy workflow hooks can change a tracked project
hooks file; unrelated hooks are preserved. See the [v3 upgrade note](../../README.md#upgrading-from-2x).

| Template | Destination | Action |
|---|---|---|
| CLAUDE.workflow.md | CLAUDE.local.md | Replace the Workflow section |
| AGENTS.codex.md | .codex/workflow/CODEX.md | Copy current rules |
| codex/autopilot.js | .codex/autopilot.js | Copy driver coordination helper |
| codex/hooks/*.js | .codex/hooks/ | Copy alignment runner, library and plan hook |
| codex/hooks.json | .codex/hooks.json | Merge graphify PreToolUse guards when untracked |
| plans/_template.md | .codex/plans/_template.md | Create if missing |
| skills/caveman/SKILL.md | .claude/skills/caveman/, .agents/skills/caveman/ | Create if missing |

Setup adds an ExitPlanMode reminder in .claude/settings.local.json. It moves untracked old
plans into .codex/plans/ and reports old tracked workflow sections for team cleanup.
With --shared, rules go into CLAUDE.md/AGENTS.md and workflow state goes into .gitignore;
graphify project installers run. Impeccable's own installer can write shared design files.

### Left for you

- Restart Claude Code so it loads local rules and the plan hook; inspect /mcp for Playwright.
- Sign in to Claude/Codex, trust Codex graphify hooks, and keep a Codex session open in the repo.
- Allow review/verify/UI close network access and long command timeouts (30 minutes).
- Scaffold an app first if new; build the initial graph with /graphify . once code exists.
- With Impeccable, run /impeccable init for PRODUCT.md, and /impeccable document for an existing UI.
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
New failures return to Codex without a model call. The alignment review is read-only,
uses structured verdicts with a text fallback and caps at 40 turns. High risk uses Opus.
The final UI audit uses Playwright with write/code-execution tools denied and caps at 80 turns.
Configure checks, parallelChecks, baseline, alignment, ui, handoff and headless in verify.json;
see [the complete example](../../README.md#configure-verification). Inspect commands with
`node .codex/hooks/claude-verify.js --print-checks`.

## Command reference

| Command | Purpose |
|---|---|
| check PLAN | Validate plan shape and runnable gates |
| review PLAN | Read-only ephemeral Codex findings before handoff |
| handoff PLAN [--phase N] [--continue] [--thread ID] [--wait SEC] [--print] | Post to the open Codex session, or print paste line |
| wait PLAN [--since ISO] [--timeout SEC] | Watch run/session and print outcome/reports |
| begin PLAN | Starting snapshot and failure baseline |
| phase PLAN N | Phase snapshot; automatically begin if needed |
| verify PLAN N | Gates/checks, then alignment on green code |
| stop PLAN --reason TEXT | Record an explicit stuck outcome |
| close PLAN | Final checks/UI audit when needed, graph update, done |
| usage [PLAN] | Headless Claude tokens and list-price cost |

All commands use `node .codex/autopilot.js`. Exit codes: 0 pass/done/paused, 1 failed,
2 gate/check failure, 3 alignment/UI rework, 4 stuck, 5 paste, 6 wait timeout.
Single-phase handoffs pause after intermediate PASS and wait prints the next handoff command.

## Troubleshooting

- Missing tools: check PATH/authentication, then re-run setup with authorized installation flags.
- Old workflow still runs: start a new session after a plugin update (SessionStart runs --sync)
  or run setup --project-only once if there is no workflow-manifest.json; restart both CLIs.
- Codex hook fails on every event on Windows: Impeccable's `if exist (...)` command breaks under
  PowerShell. Setup and --sync rewrite it to `cmd.exe /d /c`, even in a tracked
  .codex/hooks.json (commit that change); trust the hooks again with /hooks.
- Paste fallback: keep Codex open in the repo or pin --thread; queue/app-server is experimental.
- Failed/stuck: read status/logs and alignment.md, fix the blocker, then handoff --continue.
- UI BLOCKED: inspect final-ui.app.log, app URL/start command, Playwright and Chromium setup.
- Conflicting checks: parallelChecks false. Monorepo checks: explicit checks in verify.json.
- Optional Impeccable: use PRODUCT.md and DESIGN.md; remove its live block before committing.

## Tools considered

Playwright CLI is a browser-efficiency follow-up; MCP remains the integration.
Claude Code LSP plugins are optional per-user installs. Existing graphify handles code relationships.
