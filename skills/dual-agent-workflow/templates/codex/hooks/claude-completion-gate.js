"use strict";

// Snapshots catch edits made through shells as well as Claude's editing tools.
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./workflow-lib");
const root = path.resolve(__dirname, "..", "..");

function main() {
  const event = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  if (lib.workflowMode(root) !== "dual") return {};
  if (!event.session_id) return {};
  const id = require("node:crypto").createHash("sha256").update(event.session_id).digest("hex");
  const dir = path.join(root, ".codex", "autopilot", "sessions");
  const file = path.join(dir, `${id}.json`);
  const session = lib.readJsonFile(file);
  const current = lib.snapshot(root);
  if (event.hook_event_name === "SessionStart") {
    fs.mkdirSync(dir, { recursive: true });
    if (!session) fs.writeFileSync(file, JSON.stringify({ tree: current }));
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Dual-agent workflow active. Read CLAUDE.local.md Workflow. Automatically route backend, functions and scraping to Codex through autopilot handoff; prefer the open Codex CLI so the user sees output. Claude builds frontend. Run begin before app edits and require autopilot audit PASS before completion. Never ask the user to hand off or paste work into Codex." } };
  }
  const block = (reason) => event.stop_hook_active ? { systemMessage: `Workflow remains incomplete: ${reason}` } : { decision: "block", reason };
  if (!session) return block("Workflow session baseline is missing. Restart Claude Code before claiming task completion.");
  const codeChanges = (from, to) => lib.changedFiles(root, from, to).filter((name) => !/\.(?:json|ya?ml|toml|ini|lock)$/i.test(name));
  if (!codeChanges(session.tree, current).length) return {};
  const state = lib.readJsonFile(path.join(root, ".codex", "autopilot", "status.json"));
  if (["stuck", "failed"].includes(state?.state) && state.reason) return { systemMessage: `Task blocked, not complete: ${state.reason}` };
  if (!state?.plan || !lib.planPattern.test(state.plan) || !lib.treeExists(root, state.startTree)) return block("Code changed without a recorded task. Save the approved plan and record its original baseline; do not claim completion without the required Codex audit.");
  if (codeChanges(session.tree, state.startTree).length) return block("Code changed before begin recorded the task baseline. Restore the correct original task baseline before auditing; those changes must be included.");
  const audit = lib.readJsonFile(path.join(lib.taskVerifyDir(root, state.slug), "code-audit.json"));
  if (audit?.verdict !== "PASS" || audit.base !== state.startTree || audit.tree !== current
      || audit.planHash !== lib.fileHash(path.join(root, state.plan))
      || audit.configHash !== lib.fileHash(path.join(root, ".codex", "verify.json"))) {
    return block(`Run node .codex/autopilot.js audit ${state.plan} automatically. Fix backend findings through Codex and frontend findings through Claude, then audit again. Never ask the user to hand off the work. If blocked, record stop --reason and report the blocker instead of claiming success.`);
  }
  fs.writeFileSync(file, JSON.stringify({ tree: current }));
  return {};
}

try { console.log(JSON.stringify(main())); }
catch (error) {
  console.error(`Workflow completion check failed: ${error.message}`);
  process.exitCode = 2;
}
