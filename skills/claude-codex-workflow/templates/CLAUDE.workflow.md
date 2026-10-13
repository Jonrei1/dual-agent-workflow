## Workflow

Plans, reports, summaries and rules are local: .codex/plans/, .codex/verify/, .codex/tasks/,
CLAUDE.local.md and .codex/workflow/CODEX.md are hidden through .git/info/exclude.
Never add them to git or .gitignore. Never run git commit, git add, git stash or git push.

### Plan and handoff
- Ask on every new plan that changes app code, using AskUserQuestion: **Codex implements
  (Claude orchestrates)**, **Claude implements**, or **Codex, manual phases**. The answer
  holds for this plan only. Skip read-only questions and doc/config-only edits.
- Claude implements: edit, run the project checks, and audit UI changes yourself.
- Codex implements: save the approved plan as .codex/plans/<slug>.md using _template.md.
  Run `node .codex/autopilot.js check .codex/plans/<slug>.md` and fix what it lists.
- For review: codex or risk: high, run `node .codex/autopilot.js review .codex/plans/<slug>.md`.
  Assess the findings with the user, edit the plan as agreed, and run check again.
- Run `node .codex/autopilot.js handoff .codex/plans/<slug>.md` (timeout at least 150000 ms).
  Add `--phase N` for manual phases. It posts with codex queue into the open repo session;
  name the session used. Exit 5: show the printed paste line in its own code block.
- Start `node .codex/autopilot.js wait .codex/plans/<slug>.md` with run_in_background: true.
  Tell the user you're watching. If Codex is waiting for approval/input, direct them to its panel.

### Review when Codex finishes
- Done (0): read per-phase alignment/check reports and final-ui-audit.md when ui: yes;
  spot-check git diff and git status. The helper already ran the final browser audit.
- Paused (0): review the finished phase, then show the next handoff --phase command.
- Stuck (4) or failed (1): explain the reason and Codex's last message. Resolve environment
  or plan problems; ask before handoff --continue. For NOT STARTED, hand off without --continue.
- Timed out (6): report whether Codex never started or is still running; offer to wait again.
- Write .codex/tasks/<YYYY-MM-DD>-<slug>.md from the template below (25 lines max), using
  the actual diff for deviations; report shipped work, verdicts, baseline failures and follow-ups.
  For paused or unfinished work, record that status instead of claiming the task passed.
- During Codex execution, new check failures and alignment findings go back to Codex within scope; after completion, propose a rework plan for behavior problems and ask before handoff. Interactive mechanical fixes may be made directly; use graphify query/path/explain before many reads. The helper updates the graph at close; after direct code edits run graphify update . once.
- Impeccable is optional: if /impeccable is available or .impeccable/ exists, follow PRODUCT.md and DESIGN.md and name the design commands in UI plans; otherwise follow existing conventions. Never commit its live block (impeccable-live-start through impeccable-live-end).

### Task summary template
```md
# <Task title>

- Date: <YYYY-MM-DD>
- Risk: normal | high
- Plan reviewed by Codex: yes | no
- Final verdict: PASS | PASS WITH NOTES | PAUSED | STUCK | FAILED | TIMED OUT
- UI audit: PASS | NEEDS REWORK | BLOCKED | not run

## What shipped
- Phase 1: <title> (<main files changed>)

## Deviations from the plan
- <actual diff vs plan, or none>

## Review findings that mattered
- <plan, alignment or UI findings, or none>

## Follow-ups
- <deferred work, baseline failures or next phase, or none>
```
