## Codex execution

Read the whole .codex/plans/<task>.md first. Follow each phase's Scope, Steps, Covers,
Done when and Hands off. Plans, reports and rules are local through .git/info/exclude;
never add them to git or .gitignore. Never run git commit, git add, git stash or git push.
Leave every change in the working tree for the user. Report changed files after each phase.
If a step is wrong or impossible, stop and report it; do not silently diverge.

### Full plan execution
1. Run `node .codex/autopilot.js check .codex/plans/<task>.md`. Exit 1: report the problems.
2. Run `node .codex/autopilot.js begin .codex/plans/<task>.md`. It snapshots the untouched
   tree and records every gate/check as the failure baseline. Report a failure and stop.
3. For each phase in document order (including intermediate ids such as 2.5):
   - Run `node .codex/autopilot.js phase .codex/plans/<task>.md <N>`.
   - Implement that phase. Read only its listed files before editing; use graphify for
     other dependencies. Provide its Hands off before moving on. Keep changes within scope.
   - Run `node .codex/autopilot.js verify .codex/plans/<task>.md <N>`.
     Exit 0: go to the next phase. Exit 2: fix the listed new gate/check failures within
     scope, then verify again; leave baseline failures alone. Exit 3: read alignment.md,
     fix every MISSING/PARTIAL item and undo OUT OF SCOPE changes, then verify again.
     Findings about code this phase did not touch should be reported, without changing it.
     Exit 1 or 4: report the reason and end the turn. Three consecutive new gate/check
     failures or a failed alignment after two reworks stop the run as stuck.
4. Run `node .codex/autopilot.js close .codex/plans/<task>.md`. For ui: yes it runs checks,
   then one headless Playwright audit and writes .codex/verify/<task>/final-ui-audit.md.
   Exit 2 or 3: fix within the union of phase scopes and run close again. A failed UI
   review after two reworks stops the run; BLOCKED is reported but does not fail close.
   Close runs graphify update . and marks done. Claude writes the task summary in its review.
5. End with: `Task <task> done. Claude is reviewing it.`

Keep going through all phases without asking between them. If scope, credentials, tools,
a dependency or any other problem blocks execution, run
`node .codex/autopilot.js stop .codex/plans/<task>.md --reason "<what blocks it>"`
before ending your turn. Never leave an active run with no outcome.
Verify and UI close may take several minutes and need network access; allow a 30-minute
command timeout. The helper owns snapshots, gates, project checks and graph updates.
When asked to Continue, read .codex/autopilot/status.json, rerun the stopped step and continue.

### Single-phase handoff
For `Execute phase <N> of .codex/plans/<task>.md`, follow the same phase/verify protocol:
run phase N (it begins and records the baseline if no run is active), implement, then verify N.
On PAUSED, end the turn and report the next handoff --phase command. On the last phase's
PASS, run close and handle its exit codes as above. Do not begin another phase in this turn.

### Phase execution
Apply accepted plan findings. Do not change out-of-scope files to make a gate pass.
Gates and project checks run first as a deduplicated, baseline-aware set, with builds last;
only green checks reach the report-only Claude alignment review. Codex fixes new failures.
Run existing Playwright specs when gates/checks name them. The helper owns the browser audit.

### Plan review
Plan review is performed before handoff by `autopilot.js review`, using read-only Codex.
Do not edit or reorder the plan or app code. Return findings with phase, problem, file/graph
evidence and proposed fix. Check missing files/dependents, test gates, acceptance clarity,
Hands off interfaces and risky ordering. Propose intermediate phases without renumbering.
Return APPROVE or CHANGES NEEDED in the requested schema; Claude assesses findings with the user.

If the impeccable skill is installed, use it for UI work and follow PRODUCT.md and DESIGN.md;
run the design commands named by the plan. If it isn't installed, follow existing conventions.
Never commit impeccable's live-mode block (impeccable-live-start through impeccable-live-end).
Use graphify query, path and explain before reading many raw files. Do not update the graph
between edits; the helper runs graphify update . once at close.

Commands: check, review, handoff, wait, begin, phase, verify, stop, close, usage.
Exit codes: 0 pass/done/paused; 1 failed; 2 gate/check failure; 3 alignment or close UI rework;
4 stuck; 5 paste the handoff line; 6 wait timeout.
