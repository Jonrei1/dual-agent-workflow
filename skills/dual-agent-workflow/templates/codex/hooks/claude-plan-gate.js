/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Claude Code PostToolUse hook for ExitPlanMode, installed in .claude/settings.local.json.
// When the user approves a plan, it reminds Claude of the workflow's next steps: confirm the
// role for this plan, and as orchestrator save the plan locally, check it, hand it to Codex
// and watch the run in the background. It only adds context; it never blocks.

const fs = require("node:fs");
const path = require("node:path");
const lib = require("./workflow-lib");

let input = "";
try {
  input = fs.readFileSync(0, "utf8");
} catch {
  // no stdin
}
let event = {};
try {
  event = JSON.parse(input || "{}");
} catch {
  event = {};
}

const approved = !event.tool_response || !/reject|denied|not approved/i.test(JSON.stringify(event.tool_response).slice(0, 2000));
if (!approved) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const context = `Plan approved. Follow CLAUDE.local.md, section Workflow.
Route THIS plan by task type without asking: backend, functions and scraping go to Codex; Claude builds all frontend itself after Codex finishes. Ask only if the type is unclear. For ui: yes also ask headed or headless, record it as - Browser: in the UI audit, and list the frontend under ## Frontend (Claude). For Codex, save and check the plan, run review when required, run begin before any edits (also for UI-only plans), then handoff --phase N with run_in_background: true. Use the open Codex terminal automatically so the user sees it work; fall back to headless only when no session is open. No user handoff is needed. Never use --print automatically.
When wait returns, review the reports and diff, build the frontend and audit it, run the QA pass and autopilot.js audit PLAN in the background. Automatically route backend findings to Codex and frontend fixes to yourself, re-audit after fixes, then write the task summary. Never claim completion without a current PASS code audit.`;

// A --claude-only project has no Codex: Claude builds the whole plan itself.
const claudeOnly = `Plan approved. Follow CLAUDE.local.md, section Workflow. This project has no Codex: implement THIS plan yourself, phase by phase.
Record the base HEAD first. Per phase: edit, run its gate and the project checks, then ask approval before each commit. For ui: yes ask headed or headless before the UI audit.
After the last phase: one /ponytail-review QA pass over the whole diff, graphify update ., then the task summary. Query graphify before raw reads.`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: lib.workflowMode(path.resolve(__dirname, "..", "..")) === "claude" ? claudeOnly : context } }) + "\n");
