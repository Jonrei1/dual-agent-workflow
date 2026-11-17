---
description: Build the plan's frontend in the real repo, remove AI slop, and verify every affected screen locally.
argument-hint: "[plan path or UI request]"
---

# Execute the UI change plan

Plan or request: $ARGUMENTS

This is an execution order. Edit the code, run the app locally, inspect it, fix it, and report
verified results. A proposal, mockup or audit alone is not done.

## Inputs, in priority order
1. The user's latest instructions and reference images.
2. The plan: the path above, else the active `.codex/plans/<slug>.md` (its `## Frontend (Claude)`
   and `## UI audit`), else the user's request as the plan. Never invent a plan file.
3. The project's existing components, tokens, fonts, icons and adjacent screens.
4. API contracts proven by code or tests (in a Claude + Codex project: the last phase's Hands off).
5. `.claude/rules/frontend-ai-slop.md`, a quality bar, not permission to redesign.

## Rules
- Work locally; never deploy or push. Never fabricate paths, scripts, data, screenshots or results.
- Reuse what exists; no new library, palette or component kit unless the plan asks.
- Build only what the plan lists. A backend defect goes to Codex as rework, not into your diff.
- Any edit after a visual check invalidates it: re-screenshot and re-check.
- Skills: ui-ux-pro-max for palette, type and UX guideline lookups; taste-skill
  (redesign-existing-projects for app screens, design-taste-frontend for public pages) for
  direction; superpowers:verification-before-completion before claiming PASS. The anti-slop rule
  wins over any skill suggestion.

## Steps
1. **Read.** Find the frontend root, framework, package manager and real dev/build/test commands.
   List each plan item as: requirement -> files -> visible result -> how it is checked. Open the
   target files and neighbours. If feasible, screenshot the current screens first.
2. **Build.** Implement every item in source, wired to real routes, handlers and data, with
   loading, empty, error and success states, semantic controls, keyboard use, visible focus and
   reduced motion. A blocked item gets a concrete blocker; finish the rest.
3. **Remove slop.** Check the rendered result against `.claude/rules/frontend-ai-slop.md` and fix
   each hit in the screens you touched. Record any exception and its reason.
4. **Run locally.** Run lint, type-check, tests and build. Start the app with its Start command on
   localhost. Use the Playwright server the plan's `- Browser:` names (mcp__playwright-headed__*
   or mcp__playwright__*; ask headed or headless when there is no plan). At 375x812, 768x1024
   and 1440x900, check overflow, clipped or unreadable text, broken assets, console errors,
   failed requests, focus, keyboard use and unlabeled controls. Fix and repeat steps 3-4.
   Stop the app after.
5. **Evidence.** Save screenshots to `.codex/verify/<slug>/` (`frontend-latest` without a plan)
   and write `final-ui-audit.md` there: PASS/FAIL per `## UI audit` item and per slop item,
   exceptions, URLs, commands run, then `UI AUDIT: PASS | NEEDS REWORK | BLOCKED`.
6. **Reconcile.** Check each plan item: implemented, rendered, slop-checked, verified. Then follow
   the workflow: QA, `node .codex/autopilot.js audit <plan>`, commit approval.

## Report
```text
UI CHANGE PLAN EXECUTION: PASS | PARTIAL | BLOCKED | NOT VERIFIED
Plan source: <file or request>
Implemented plan items: <requirement -> result>
Changed files: <paths>
AI slop removed: <pattern -> fix, or none found>
Exceptions kept: <style -> reason, or none>
Routes/states checked: <localhost URLs and interactions>
Screenshots: <paths>
Checks run: <commands -> outcome>
Outstanding: <blockers or none>
```
