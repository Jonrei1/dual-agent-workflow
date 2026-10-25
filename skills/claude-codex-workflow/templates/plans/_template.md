---
task: <slug>
risk: normal            # normal | high (schema, auth, payments, cross-layer contracts)
review: none            # none | codex
ui: no                  # yes | no (yes: Claude builds the frontend after the backend phases, then audits it with Playwright)
---

# <Task title>

## Goal
One or two sentences. What changes for the user.

## Impact (from graphify)
- Expected files: ...
- Dependents to re-test: ...
- Do not touch: ...

## Acceptance
Every item has an id, and every id is covered by a phase's `**Covers:**` (backend) or by the
`## Frontend (Claude)` section's (UI). Phases are non-UI (backend, functions, scraping): Codex never builds frontend files.
- A1: <observable result, with the test command or endpoint check that proves it>
- A2: <...>

## UI audit
Only when `ui: yes`. After Codex finishes, Claude builds the frontend and then audits it itself
with Playwright against these checks, at each viewport.
- Start: `<app start command, e.g. npm run dev>`
- URL: <http://localhost:3000/page>
- Viewports: 375, 1280
- Browser: <headless | headed>   (ask the user: headed opens a visible window to watch the audit)
- Checks:
  - <what the user must see or be able to do, per state>

## Frontend (Claude)
Only when `ui: yes`. What Claude builds after the backend phases pass: pages, components, states
(loading, empty, error), copy and accessibility, using the last phase's Hands off as the API.
- Builds: <pages and components, e.g. the profile page and its Badge component>
**Covers:** A1

Keep it small: the fewest backend phases that keep each diff reviewable (one is fine).

## Phase 1: <title>
**Scope:** <files and interfaces this phase may change>
**Steps:**
1. ...
**Covers:** A1
**Done when:** <what is true when this phase is finished>
**Hands off:** <what phase 2 relies on: files, exports, API shapes, data>
**Gate (must pass):**
- `<runnable command, e.g. npx tsc --noEmit>`
**Suggested commit (Claude proposes after PASS; requires approval):** `<type>(<slug>): <summary>`

## Phase 2: <title>
**Scope:** ...
**Steps:**
1. ...
**Covers:** A2
**Done when:** ...
**Gate (must pass):**
- `<command>`
**Suggested commit (Claude proposes after PASS; requires approval):** `<type>(<slug>): <summary>`
