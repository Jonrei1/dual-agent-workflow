---
description: Install the tools (Claude Code, Codex CLI, Playwright, graphify, ponytail, taste-skill, caveman) and set up the Claude + Codex workflow, or a Claude-only or Codex-only version, in this project, as local files only (tracked files are never edited).
argument-hint: "[--yes] [--dry-run] [--dual|--claude-only|--codex-only] [--tools-only|--project-only] [--graphify-scope=user|global] [--skip-graphify] [--skip-playwright] [--skip-skills] [--root <dir>]"
allowed-tools: Bash(node:*), Bash(git status:*), Read, Write, Edit, AskUserQuestion
---

Set up the Claude + Codex workflow in the current project.

0. **Pick the mode.** If `$ARGUMENTS` has none of `--dual`, `--claude-only` or `--codex-only` and the
   project has no `.codex/workflow-manifest.json`, ask with AskUserQuestion which agents the
   user has: both (add `--dual`), only Claude (add `--claude-only`) or only Codex (add
   `--codex-only`). A set-up project keeps its mode unless a flag changes it.
1. **Check graphify.** Run `graphify --version`.
   - If it isn't installed, and `$ARGUMENTS` has no `--graphify-scope`, ask with AskUserQuestion
     where to install it:
     - for the current user only (recommended: no admin rights, uv/pipx/pip --user);
     - globally for every user (system-wide pip, usually needs admin rights).
   - Add `--graphify-scope=user` or `--graphify-scope=global`. `--yes` does not answer this.
2. From the project root, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/dual-agent-workflow/scripts/install.js" $ARGUMENTS <the mode flag from step 0> <the graphify-scope flag from step 1>
   ```

   The installer can't prompt from here. If it reports tools as missing and the user
   didn't pass `--yes`, list the install commands it printed and ask whether to re-run
   with `--yes`.
3. Show the summary: what was created, merged or skipped, and the steps that need
   attention. Run `git status` and confirm workflow state is hidden; report any tracked-file notices (a tracked hooks file is never edited; pass on the fix it prints).
   - Explain that everything is local: plans, verify logs, task summaries, `CLAUDE.local.md`
     and `.codex/workflow/CODEX.md` are hidden through `.git/info/exclude`, and each developer
     sets up their own clone.
   - Explain that a step reported as "tracked by git, left unchanged" is expected.
   - If it points out old workflow sections in tracked `CLAUDE.md`, `AGENTS.md` or
     `.gitignore`, suggest removing them in a normal team commit.
   - Mention any stale files it removed. Later plugin updates sync the project (and its git
     worktrees) automatically through the plugin's SessionStart hook.
4. Read the detected checks it printed. If they're wrong or empty, propose a
   `.codex/verify.json`. Also propose:
   - `alignment.riskPaths` for the project's schema, migration and auth paths;
   - for apps with a UI, a `ui` block (`startCommand`, `url`, `viewports`) so
     Claude can audit the frontend it builds with Playwright.

   See the dual-agent-workflow skill, "Checks".
5. List the "Left for you" steps, and the new- or existing-project steps from the skill's
   Setup section (`/graphify .`). Stress that the user must:
   - restart Claude Code, which loads `CLAUDE.local.md`, the plan hook and the plugins;
   - trust the plugin and workflow hooks in Codex (`/hooks`) and keep a Codex session open in
     the repo to see output. Claude discovers it and posts tasks and code audits automatically; no open session uses headless fallback.
6. Explain the machine-level pieces, installed only with approval:
   - Playwright setup installs a global MCP server and matching Chromium, and registers it for
     Claude twice: `playwright` (headless) and `playwright-headed` (a visible window). Claude
     builds every frontend itself and audits it with one of them; it asks which for every UI plan. Backend, function and scraping work is routed to Codex automatically. Existing registrations are kept. Restart Claude
     and check `/mcp`.
   - ponytail (senior dev and QA), taste-skill (UI/UX) and caveman (terse replies) are
     installed as user-scope plugins for each agent in use, and graphify's skill per agent.
     `--skip-skills` and `--skip-graphify` opt out.
   - In `--codex-only`, Playwright is registered for Codex instead, and Codex must trust the
     SessionStart hook that loads its rules (`/hooks`).
   - `--project-only` skips both; `--skip-playwright` opts out of Playwright explicitly.

Don't commit anything.
