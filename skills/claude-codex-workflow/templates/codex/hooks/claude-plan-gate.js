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
Ask who implements THIS plan if not already answered; for Codex, save and check the plan, run review when required, handoff (manual: --phase N), then wait in the background.
When wait returns, review the reports and diff, write the task summary and report to the user; use the rules there for stopped runs.`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }) + "\n");
