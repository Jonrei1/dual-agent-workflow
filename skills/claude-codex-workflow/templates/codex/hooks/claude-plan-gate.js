/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Claude Code PostToolUse hook for ExitPlanMode, installed in .claude/settings.local.json.
// When the user approves a plan, it reminds Claude of the workflow's next steps: confirm the
// role for this plan, and as orchestrator save the plan locally, check it, hand it to Codex
// and watch the run in the background. It only adds context; it never blocks.

const fs = require("node:fs");

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
Route THIS plan by task type without asking: backend, functions and scraping go to Codex; Claude builds all frontend itself after Codex finishes. Ask only if the type is unclear. For ui: yes also ask headed or headless, record it as - Browser: in the UI audit, and list the frontend under ## Frontend (Claude). For Codex, save and check the plan, run review when required, handoff (manual: --phase N), then wait in the background.
When wait returns, review the reports and diff, build the frontend and audit it, run the QA pass, write the task summary and report to the user.`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }) + "\n");
