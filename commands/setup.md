---
description: Install the tools (Claude Code, Codex CLI, Playwright, graphify, ponytail, taste-skill) and set up the Claude + Codex workflow in this project, as local files only (tracked files are never edited).
argument-hint: "[--yes] [--dry-run] [--tools-only|--project-only] [--graphify-scope=user|global] [--skip-graphify] [--skip-playwright] [--skip-skills] [--root <dir>]"
allowed-tools: Bash(node:*), Bash(git status:*), Read, Write, Edit, AskUserQuestion
---

Set up the Claude + Codex workflow in the current project.

1. **Check graphify.** Run `graphify --version`.
   - If it isn't installed, and `$ARGUMENTS` has no `--graphify-scope`, ask with AskUserQuestion
     where to install it:
     - for the current user only (recommended: no admin rights, uv/pipx/pip --user);
     - globally for every user (system-wide pip, usually needs admin rights).
   - Add `--graphify-scope=user` or `--graphify-scope=global`. `--yes` does not answer this.
2. From the project root, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/claude-codex-workflow/scripts/install.js" $ARGUMENTS <the graphify-scope flag from step 1>
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
     the repo, because Claude posts plans into it with `codex queue`.
6. Explain the machine-level pieces, installed only with approval:
   - Playwright setup installs a global MCP server and matching Chromium, and registers it for
     Claude twice: `playwright` (headless) and `playwright-headed` (a visible window). Claude
     builds every frontend itself and audits it with one of them; it asks which for every UI plan. Backend, function and scraping work is routed to Codex automatically. Existing registrations are kept. Restart Claude
     and check `/mcp`.
   - ponytail (senior dev and QA) and taste-skill (UI/UX) are installed as user-scope plugins
     for Claude and Codex. `--skip-skills` opts out.
   - `--project-only` skips both; `--skip-playwright` opts out of Playwright explicitly.

Don't commit anything.
