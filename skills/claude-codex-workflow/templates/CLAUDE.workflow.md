## Workflow

Plans, reports, summaries and rules are local: .codex/plans/, .codex/verify/, .codex/tasks/,
CLAUDE.local.md and .codex/workflow/CODEX.md are hidden through .git/info/exclude.
Never add them to git or .gitignore. Claude prepares each passing phase for a commit and always asks approval before git commit; never stash or push.
One run per clone/worktree. Before editing or handing off, record HEAD and staged/unstaged changes in .codex/tasks/<slug>-base.md.

### Roles
**Claude builds every frontend, from the start.** Pages, components, views, styles, templates and
the states, copy and accessibility in them are never given to Codex and never appear in a plan
phase; Codex builds the backend and exposes the API Claude builds against. This avoids
Codex-builds-then-Claude-fixes rework. Backend problems found while building the frontend go to Codex.
Smallest change first (ponytail, when installed: /ponytail): reuse what exists, add no
dependency, option or abstraction the task doesn't need, and plan the fewest phases that keep
each diff reviewable (one is fine). Explore only what the task needs: graphify query first, and
at most 2 Explore subagents with model: "haiku", only when the work spans many files.

### Plan and handoff
- Ask on every new plan that changes app code, using AskUserQuestion: **Codex implements
  (Claude orchestrates)**, **Claude implements**, or **Codex, manual phases**. The answer
  holds for this plan only, and means the backend: Claude always builds the frontend.
  Skip read-only questions and doc/config-only edits.
- For ui: yes, also ask "Watch the browser (headed) or run headless?" and write the answer as
  `- Browser: headed` or `- Browser: headless` in the plan's `## UI audit`. Ask it again before
  any UI check you run outside a plan. List the pages and components you will build under
  `## Frontend (Claude)` with its `**Covers:**` ids; the last Codex phase's Hands off is the API.
- Claude implements: for each phase, edit, run checks and QA, then request commit approval using the checkpoint rules below.
- Codex implements: save the approved plan as .codex/plans/<slug>.md using _template.md. Its
  phases are backend only (`check` rejects frontend files in a phase's Scope). Run
  `node .codex/autopilot.js check .codex/plans/<slug>.md` and fix what it lists.
- For review: codex or risk: high, run `node .codex/autopilot.js review .codex/plans/<slug>.md`.
  Assess the findings with the user, edit the plan as agreed, and run check again.
- Run `node .codex/autopilot.js handoff .codex/plans/<slug>.md --phase N` for the first phase (timeout at least 150000 ms).
  Use one-phase handoffs in both automatic and manual modes. Name the codex queue session used; exit 5: show the paste line in its own code block.
- Start `node .codex/autopilot.js wait .codex/plans/<slug>.md` with run_in_background: true.
  Tell the user you're watching. If Codex is waiting for approval/input, direct them to its panel.
  Don't write app files while the run is active: they would show up in Codex's phase diffs.
- Don't edit the plan or .codex/verify.json while a run is active; a change stops the run
  (re-run `begin` after a deliberate edit). For a second task at once, use a git worktree.

### Review when Codex finishes
- Done (0): read per-phase alignment/check reports, spot-check git diff and git status. Then
  request approval and commit the last backend phase, build the frontend (ui: yes), then QA and request approval to commit that work separately.
- Paused (0): review the passing phase, ask approval and commit, then handoff --phase for the next id and wait again. After the approved commit succeeds, continue automatically; manual mode also waits before handoff.
- Stuck (4) or failed (1): explain the reason and Codex's last message. Resolve environment
  or plan problems; ask before handoff --phase N --continue for the stopped phase. For NOT STARTED, use --phase N without --continue.
- Timed out (6): report whether Codex never started or is still running; offer to wait again.
- QA pass: review the current phase before its commit; final QA reviews the entire diff from recorded task-base HEAD
  through the working tree (including committed phases), using /ponytail-review when installed. Fix mechanical Must findings; behavior problems
  become a rework plan, and ask before handing it to Codex. Report Should and Nice findings
  without acting on them.
- Write .codex/tasks/<YYYY-MM-DD>-<slug>.md from the template below (25 lines max), using the actual diff for deviations; report shipped work, verdicts, baseline failures and follow-ups.
  Record paused or unfinished work as such instead of claiming the task passed.
- During Codex execution, new check failures and alignment findings go back to Codex within scope; after completion, propose a rework plan for backend problems and ask before handoff. The helper updates the graph at close; after direct code edits run graphify update . once.

### Phase checkpoints (Claude only)
- Before every git commit (phase, frontend, QA fix or retry), show the files, diff summary and proposed message; ask with AskUserQuestion and wait for explicit approval. Prior approval never covers another commit.
- Checks and review must pass first; document baseline failures. Never commit failed or unfinished phases. Stage only phase paths, never git add . or -A; preserve unrelated staged/unstaged work.
- Use git commit --only -m "<message>" -- <explicit phase paths>; if a file also contains pre-existing user changes, stop and explain.
  Never reset or discard user work. Never include unrelated staged hunks, local workflow files or secrets.
- Use Suggested commit or `<type>(<slug>): phase <N> - <title>`; skip empty commits. Record each SHA (or no changes).
- Rejected or pending approval, or a failed commit, blocks the next handoff; never bypass hooks or treat silence as approval. Commit reviewed QA fixes separately. Final summaries list the base HEAD and all checkpoint SHAs for backtracking.

### Frontend (ui: yes, and any UI task you implement)
Build it yourself, once, as the finished design: components, styles, states, copy and
accessibility, wired to the API from the last Hands off. Use taste-skill when installed:
redesign-existing-projects for app screens, design-taste-frontend for new public pages.
Bounds: only what `## Frontend (Claude)` lists; no new dependency, design system or image
sourcing unless the plan asks. Then audit your own work once with Playwright against `## UI
audit`: start the app with its Start command (stop it after), use the server the user chose
(mcp__playwright-headed__* to watch, mcp__playwright__* headless), and at each viewport check
every item plus layout breaks, overflow, console errors, failed requests and unlabeled controls.
Fix what fails (frontend files only; a backend defect goes to Codex in a rework plan), re-check,
run the project checks, and write .codex/verify/<slug>/final-ui-audit.md (PASS/FAIL per item,
screenshots, then `UI AUDIT: PASS | NEEDS REWORK | BLOCKED`).

### Task summary template
```md
# <Task title>

- Date: <YYYY-MM-DD>
- Risk: normal | high
- Plan reviewed by Codex: yes | no
- Final verdict: PASS | PASS WITH NOTES | PAUSED | STUCK | FAILED | TIMED OUT
- UI audit: PASS | NEEDS REWORK | BLOCKED | not run
- Claude frontend: built | not needed

## What shipped
- Phase 1: <title> (<main files changed>)

## Deviations from the plan
- <actual diff vs plan, or none>

## Review findings that mattered
- <plan, alignment, QA or UI findings, or none>

## Follow-ups
- <deferred work, baseline failures or next phase, or none>
```
<!-- dual-agent-workflow:end -->
