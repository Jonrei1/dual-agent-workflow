"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.join(__dirname, "..");
const skill = path.join(repo, "skills", "claude-codex-workflow");
const templates = path.join(skill, "templates");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const docs = [path.join(repo, "README.md"), path.join(skill, "SKILL.md"), path.join(repo, "commands", "setup.md")];
// README sections that deliberately talk about what was removed.
const upgradeSection = /^## Upgrading\n[\s\S]*?(?=^## |$(?![\s\S]))/m;

test("v4 templates and docs describe the single-driver protocol and no removed feature", () => {
  const removed = /autopilot\.js run|--new-terminal|\btriage\b|phase\.json|checks-fix|\*\*UI audit:\*\*|parallelWithChecks|ui\.paths|--playwright-codex|--update-sections|usageSummary|usage\.jsonl/i;
  for (const file of [...files(templates), ...docs, ...files(path.join(skill, "scripts"))]) {
    let text = read(file);
    if (file === docs[0]) text = text.replace(upgradeSection, "");
    assert.ok(!removed.test(text), `${path.relative(repo, file)} mentions a removed feature outside the upgrade notes`);
  }
});

test("Impeccable, caveman and the shared layout are gone from code, templates and docs", () => {
  const gone = /impeccable|caveman|--shared|PRODUCT\.md|DESIGN\.md/i;
  const code = [...files(templates), ...files(path.join(skill, "scripts")), ...docs, path.join(repo, "package.json"), ...files(path.join(repo, ".claude-plugin"))];
  for (const file of code) {
    let text = read(file);
    if (file === docs[0]) text = text.replace(upgradeSection, "");
    // The installer keeps the hashes and notices that clean up what older versions installed.
    if (file === path.join(skill, "scripts", "install.js")) text = text.replace(/RETIRED[\s\S]*?\];/, "").replace(/^.*(?:caveman|shared layout|--shared).*$/gm, "");
    assert.ok(!gone.test(text), `${path.relative(repo, file)} still mentions a removed feature`);
  }
  assert.ok(!fs.existsSync(path.join(templates, "skills")), "the caveman template is gone");
});

test("the rules wire in ponytail, taste-skill, the headed or headless question and Claude-owned frontend", () => {
  const claude = read(path.join(templates, "CLAUDE.workflow.md"));
  assert.ok(claude.trimEnd().split("\n").length <= 100);
  assert.ok(/```md\n([\s\S]*?)```/.exec(claude)[1].trimEnd().split("\n").length <= 25);
  for (const term of ["AskUserQuestion", "manual phases", "review", "handoff", "wait", "final-ui-audit.md", ".codex/tasks/", "git commit"]) assert.ok(claude.includes(term), term);
  for (const term of ['model: "haiku"', "### Frontend", "Claude builds every frontend, from the start", "## Frontend (Claude)", "backend only", "Don't write app files while the run is active", "/ponytail-review", "redesign-existing-projects", "design-taste-frontend", "headed", "headless", "mcp__playwright-headed__*", "- Browser:", "worktree"]) assert.ok(claude.includes(term), term);
  assert.match(claude, /^<!-- dual-agent-workflow:end -->\n?$/m);
  const codex = read(path.join(templates, "AGENTS.codex.md"));
  assert.match(claude, /backend and API, standalone functions and logic, and web scraping/);
  assert.match(claude, /Route every new plan that changes app code by task type, without asking/);
  assert.match(codex, /standalone functions and logic, and web scraping/);
  assert.match(codex, /saved fixtures/);
  assert.match(claude, /autopilot\.js review [^\n]*run_in_background: true/);
  assert.match(codex, /Never create or edit frontend files/);
  assert.match(codex, /Claude builds every frontend/);
  assert.match(codex, /ponytail/);
  assert.match(codex, /MUST FIX/);
  assert.match(read(path.join(templates, "plans", "_template.md")), /- Browser: <headless \| headed>/);
  const gate = read(path.join(templates, "codex", "hooks", "claude-plan-gate.js"));
  assert.ok(/const context = `([\s\S]*?)`;/.exec(gate)[1].split("\n").length <= 5);
  assert.match(gate, /headed or headless/);
  assert.match(gate, /Claude builds all frontend itself/);
  assert.match(gate, /without asking: backend, functions and scraping go to Codex/);
  const template = read(path.join(templates, "plans", "_template.md"));
  assert.match(template, /## Frontend \(Claude\)/);
  assert.doesNotMatch(template, /Polish focus|polishes the visuals/);
  assert.match(read(path.join(templates, "codex", "hooks", "claude-verify.js")), /ANY change to frontend files/);
});

test("Claude asks approval for every phase commit before continuing, with final QA across commits", () => {
  const claude = read(path.join(templates, "CLAUDE.workflow.md"));
  assert.match(claude, /handoff .*--phase N/);
  assert.match(claude, /both automatic and manual modes/);
  assert.match(claude, /Paused \(0\): review the passing phase, ask approval and commit, then handoff --phase/);
  assert.match(claude, /After the approved commit succeeds, continue automatically; manual mode also waits/);
  assert.match(claude, /Before every git commit \(phase, frontend, QA fix or retry\)/);
  assert.match(claude, /ask with AskUserQuestion and wait for explicit approval/);
  assert.match(claude, /Prior approval never covers another commit/);
  assert.match(claude, /Never commit failed or unfinished phases/);
  assert.match(claude, /git commit --only/);
  assert.match(claude, /pre-existing user changes, stop and explain/);
  assert.match(claude, /Rejected or pending approval, or a failed commit, blocks the next handoff/);
  assert.match(claude, /never bypass hooks or treat silence as approval/);
  assert.match(claude, /skip empty commits/);
  assert.match(claude, /entire diff from recorded task-base HEAD\n  through the working tree \(including committed phases\)/);
  assert.match(claude, /base HEAD and all checkpoint SHAs/);
  assert.doesNotMatch(claude, /Never run git commit|\/ponytail-review uncommitted/);
  assert.match(read(path.join(templates, "AGENTS.codex.md")), /Never run git commit, git add, git stash or git push/);
  assert.match(read(path.join(templates, "plans", "_template.md")), /Suggested commit \(Claude proposes after PASS; requires approval\)/);
});

test("docs state the call counts and every doc names the two plugins", () => {
  for (const file of docs.slice(0, 2)) {
    const text = read(file);
    assert.match(text, /phases \+ reworks/);
    assert.doesNotMatch(text, /1 \+ UI reworks/);
    assert.match(text, /no UI calls|no headless UI calls/);
    assert.match(text, /ponytail/);
    assert.match(text, /taste-skill/);
  }
  assert.match(read(docs[2]), /ponytail/);
  assert.match(read(docs[0]), /Several developers, one repo/);
  assert.match(read(docs[0]), /playwright-headed/);
});

test("versions and manifests agree on v4", () => {
  for (const file of ["package.json", ".claude-plugin/plugin.json"]) assert.strictEqual(JSON.parse(read(path.join(repo, file))).version, "4.1.0");
  const marketplace = JSON.parse(read(path.join(repo, ".claude-plugin", "marketplace.json")));
  assert.match(marketplace.plugins[0].description, /ponytail/);
  assert.ok(JSON.parse(read(path.join(repo, "package.json"))).files.includes("skills"));
});
