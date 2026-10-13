"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lib = require("../skills/claude-codex-workflow/templates/codex/hooks/workflow-lib");

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-usage-"));
  fs.mkdirSync(path.join(dir, ".codex", "verify"), { recursive: true });
  return dir;
}

function record(task, name, extra = {}) {
  return JSON.stringify({
    task,
    name,
    model: "sonnet",
    effort: "low",
    ok: true,
    inputTokens: 10,
    cacheCreationTokens: 100,
    cacheReadTokens: 1000,
    outputTokens: 5,
    costUsd: 0.01,
    ...extra,
  });
}

test("usageSummary reports no usage before any call", () => {
  const dir = tempRepo();
  assert.match(lib.usageSummary(dir, ""), /No usage recorded yet/);
});

test("usageSummary groups by step, filters by task and counts failures", () => {
  const dir = tempRepo();
  const lines = [
    record("a", "alignment"),
    record("a", "alignment"),
    record("a", "ui-audit", { ok: false }),
    record("b", "alignment"),
    "not json",
  ];
  fs.writeFileSync(path.join(dir, ".codex", "verify", "usage.jsonl"), `${lines.join("\n")}\n`);

  const forA = lib.usageSummary(dir, "a");
  assert.match(forA, /alignment \(sonnet\/low\): 2 call\(s\), 2220 input, 10 output tokens/);
  assert.match(forA, /ui-audit \(sonnet\/low\): 1 call\(s\).*1 failed/);
  assert.match(forA, /Total: 3 call\(s\)/);

  assert.match(lib.usageSummary(dir, "b"), /Total: 1 call\(s\)/);
  assert.match(lib.usageSummary(dir, "missing"), /No usage recorded for missing/);
});


test("v3 documentation and templates describe the single-driver protocol", () => {
  const repo = path.join(__dirname, "..");
  const skill = path.join(repo, "skills", "claude-codex-workflow");
  const templates = path.join(skill, "templates");
  function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  }
  const docs = [path.join(repo, "README.md"), path.join(skill, "SKILL.md"), path.join(repo, "commands", "setup.md")];
  const removed = /autopilot\.js run|--new-terminal|\btriage\b|phase\.json|checks-fix|\*\*UI audit:\*\*|parallelWithChecks|ui\.paths/i;
  for (const file of [...files(templates), ...docs]) {
    let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (file === docs[0]) text = text.replace(/^## Upgrading from 2\.x\n[\s\S]*?(?=^## |$(?![\s\S]))/m, "");
    assert.ok(!removed.test(text), `${path.relative(repo, file)} contains a removed feature outside the upgrade note`);
  }
  const claude = fs.readFileSync(path.join(templates, "CLAUDE.workflow.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(claude.trimEnd().split(/\r?\n/).length <= 70);
  assert.ok(/```md\n([\s\S]*?)```/.exec(claude)[1].trimEnd().split("\n").length <= 25);
  for (const term of ["AskUserQuestion", "manual phases", "review", "handoff", "wait", "final-ui-audit.md", ".codex/tasks/", "git commit"]) assert.ok(claude.includes(term), term);
  const gate = fs.readFileSync(path.join(templates, "codex", "hooks", "claude-plan-gate.js"), "utf8");
  assert.ok(/const context = `([\s\S]*?)`;/.exec(gate)[1].split("\n").length <= 5);
  for (const file of docs.slice(0, 2)) {
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /phases \+ reworks/);
    assert.match(text, /1 \+ UI reworks/);
  }
  for (const file of ["package.json", ".claude-plugin/plugin.json"]) assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo, file), "utf8")).version, "3.0.0");
});
