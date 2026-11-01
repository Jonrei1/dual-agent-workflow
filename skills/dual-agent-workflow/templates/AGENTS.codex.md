## Codex execution

<!-- only:dual -->
Read the whole .codex/plans/<task>.md first. Follow each phase's Scope, Steps, Covers,
Done when and Hands off. Plans, reports and rules are local through .git/info/exclude;
never add them to git or .gitignore. Never run git commit, git add, git stash or git push.
Leave phase changes in the working tree for Claude to review, request approval and commit. Report changed files after each phase.
If a step is wrong or impossible, stop and report it; do not silently diverge.
You build the backend, standalone functions and logic, and web scraping. Never create or edit frontend files: pages, components, views,
styles, templates, and the copy, markup or accessibility in them. Claude builds every frontend
from the start, against the API contract in your last Hands off. If a phase seems to need
frontend work, stop and report it.
<!-- /only -->
<!-- only:codex -->
This project uses Codex alone: you plan, build everything (backend, functions, scraping and
frontend), check, review and ask the user before every commit. Plans, reports and rules are
local through .git/info/exclude; never add them to git or .gitignore. Never stash or push.
If a step is wrong or impossible, stop and report it; do not silently diverge.
You carry the whole task alone, so spend tokens carefully: graphify query, path or explain
before reading raw files; read only the files a phase touches; reply in caveman mode when its
plugin is installed (`$caveman:caveman`), but write code, commits, plans, reports and summaries
in normal prose.
<!-- /only -->
Scraping: test parsers against saved fixtures, never the live network in a gate; respect robots.txt, rate limits and site terms; keep credentials and API keys out of code.
Never edit the plan or .codex/verify.json during a run: a change stops it.
Work in ponytail mode when its plugin is installed (`$ponytail:ponytail`): the smallest change
that solves the phase. Reuse existing code; add no dependency, config option or abstraction
the phase's Steps don't call for; give new non-trivial logic one small test.

<!-- only:codex -->
### Plan
For every task that changes app code (skip read-only questions and doc/config-only edits):
1. Save a plan as .codex/plans/<slug>.md from .codex/plans/_template.md, with the fewest
   phases that keep each diff reviewable (one is fine). Frontend files go in phases too.
2. For ui: yes, ask the user "Watch the browser (headed) or run headless?" and write the answer
   as `- Browser: headed | headless` in `## UI audit`.
3. Run `node .codex/autopilot.js check .codex/plans/<slug>.md` and fix what it lists.
4. Only for risk: high, run `node .codex/autopilot.js review .codex/plans/<slug>.md` (read-only,
   takes minutes) and fold in the findings you agree with.
5. Show the plan to the user and wait for explicit approval before step 1 of Full plan execution.
Before editing, record HEAD and staged/unstaged changes in .codex/tasks/<slug>-base.md.

<!-- /only -->
### Full plan execution
1. Run `node .codex/autopilot.js check .codex/plans/<task>.md`. Exit 1: report the problems.
2. Run `node .codex/autopilot.js begin .codex/plans/<task>.md`. It snapshots the untouched
   tree and records every gate/check as the failure baseline. Report a failure and stop.
3. For each phase in document order (including intermediate ids such as 2.5):
   - Run `node .codex/autopilot.js phase .codex/plans/<task>.md <N>`.
   - Implement that phase. Read only its listed files before editing; use graphify for
     other dependencies. Provide its Hands off before moving on. Keep changes within scope.
   - Run `node .codex/autopilot.js verify .codex/plans/<task>.md <N>`.
<!-- only:codex -->
     It runs gates and project checks on every phase, and the read-only alignment review once,
     on the last phase, over the whole task diff.
<!-- /only -->
     Exit 0: go to the next phase. Exit 2: fix the listed new gate/check failures within
     scope, then verify again; leave baseline failures alone. Exit 3: read
     .codex/verify/<task>/alignment.md, fix every MISSING, PARTIAL and MUST FIX item and undo
     OUT OF SCOPE changes (extra dependencies and abstractions included), then verify again.
     COULD BE CUT items are advice.
     Findings about code this phase did not touch should be reported, without changing it.
     Exit 1 or 4: report the reason and end the turn. Three consecutive new gate/check
     failures or a failed alignment after two reworks stop the run as stuck.
<!-- only:codex -->
   - Commit the passing phase only after explicit approval (see Phase checkpoints).
<!-- /only -->
4. Run `node .codex/autopilot.js close .codex/plans/<task>.md`. It runs graphify update . and
<!-- only:dual -->
   marks the run done. Claude then builds the frontend and writes the task summary.
5. End with: `Task <task> done. Claude is reviewing it.`
<!-- /only -->
<!-- only:codex -->
   marks the run done.
5. ui: yes: run the UI audit below. Then write .codex/tasks/<YYYY-MM-DD>-<slug>.md (25 lines
   max: what shipped, deviations from the plan, findings that mattered, follow-ups, base HEAD
   and every commit SHA) and report to the user.
<!-- /only -->

<!-- only:dual -->
Keep going through all phases without asking between them. If scope, credentials, tools,
<!-- /only -->
<!-- only:codex -->
Between phases, stop only for the commit approval. If scope, credentials, tools,
<!-- /only -->
a dependency or any other problem blocks execution, run
`node .codex/autopilot.js stop .codex/plans/<task>.md --reason "<what blocks it>"`
before ending your turn. Never leave an active run with no outcome.
Verify may take several minutes and needs network access; allow a 30-minute
command timeout. The helper owns snapshots, gates, project checks and graph updates.
When asked to Continue, read .codex/autopilot/status.json, rerun the stopped step and continue.

<!-- only:dual -->
### Single-phase handoff
For Continue with a phase id, re-run the stopped step without resetting its snapshot; finish only that phase using this protocol.
For `Execute phase <N> of .codex/plans/<task>.md`, follow the same phase/verify protocol:
run phase N (it begins and records the baseline if no run is active), implement, then verify N.
On PAUSED, end the turn so Claude can review, ask approval and commit before the next handoff. Report the next handoff --phase command. On the last phase's
PASS, run close and handle its exit codes as above. Do not begin another phase in this turn.

### Phase execution
Apply accepted plan findings. Do not change out-of-scope files to make a gate pass.
Gates and project checks run first as a deduplicated, baseline-aware set, with builds last;
only green checks reach the report-only Claude alignment review. Codex fixes new failures.
Run existing Playwright specs when gates/checks name them. The helper owns the browser audit.

Frontend work is Claude's: leave it alone, and expose what it needs (endpoints, types, data,
errors) exactly as the last phase's Hands off describes.

### Plan review
Plan review is performed before handoff by `autopilot.js review`, using read-only Codex.
Do not edit or reorder the plan or app code. Return findings with phase, problem, file/graph
evidence and proposed fix. Check missing files/dependents, test gates, acceptance clarity,
Hands off interfaces and risky ordering. Propose intermediate phases without renumbering.
Return APPROVE or CHANGES NEEDED in the requested schema; Claude assesses findings with the user.
<!-- /only -->
<!-- only:codex -->
### Phase checkpoints
- Before every git commit (phase, frontend, QA fix or retry), show the files, diff summary and
  proposed message and wait for the user's explicit approval. Prior approval never covers another
  commit; silence is not approval. Never commit failed or unfinished phases; skip empty commits.
- Stage only phase paths, never git add . or -A: use git commit --only -m "<message>" --
  <explicit phase paths>. If a file also contains pre-existing user changes, stop and explain.
  Never reset or discard user work, bypass hooks, or commit local workflow files or secrets.
- A rejected or pending approval, or a failed commit, blocks the next phase.

### UI audit (ui: yes)
Build frontend phases as the finished design (taste-skill when installed:
redesign-existing-projects for app screens, design-taste-frontend for new public pages). Then
audit it once with Playwright against `## UI audit`: start the app with its Start command (stop
it after), use the server the user chose (playwright-headed to watch, playwright headless), and at
each viewport check every item plus layout breaks, overflow, console errors, failed requests and
unlabeled controls. Fix what fails, re-check, run the project checks, and write
.codex/verify/<slug>/final-ui-audit.md (PASS/FAIL per item, then `UI AUDIT: PASS | NEEDS REWORK | BLOCKED`).
<!-- /only -->

Use graphify query, path and explain before reading many raw files. Do not update the graph
between edits; the helper runs graphify update . once at close.

<!-- only:dual -->
Commands: check, review, handoff, wait, begin, phase, verify, stop, close.
Exit codes: 0 pass/done/paused; 1 failed; 2 gate/check failure; 3 alignment rework;
4 stuck; 5 paste the handoff line; 6 wait timeout.
<!-- /only -->
<!-- only:codex -->
Commands: check, review, begin, phase, verify, stop, close.
Exit codes: 0 pass/done; 1 failed; 2 gate/check failure; 3 alignment rework; 4 stuck.
<!-- /only -->
