"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const skill = path.join(__dirname, "..", "skills", "claude-codex-workflow");
const installer = path.join(skill, "scripts", "install.js");
const lib = require(path.join(skill, "templates", "codex", "hooks", "workflow-lib"));
const isWindows = process.platform === "win32";

function git(dir, ...args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gitRepo() {
  const dir = tempDir("ccw-workflow-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  return dir;
}

function install(dir, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [installer, "--project-only", "--skip-graphify", "--skip-impeccable", "--root", dir, ...extra], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: path.join(dir, "..", `${path.basename(dir)}-codex-home`), ...env },
  });
  return result;
}

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

// ---- installer: local only, no tracked edits ----

test("setup in a team repo changes no tracked file and leaves git status clean", () => {
  const dir = gitRepo();
  write(dir, "CLAUDE.md", "# Team rules\n");
  write(dir, "AGENTS.md", "# Team agents\n");
  write(dir, ".gitignore", "node_modules/\n");
  write(dir, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [] } }, null, 2));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "team files");

  const first = install(dir);
  assert.strictEqual(first.status, 0, first.stdout + first.stderr);
  assert.strictEqual(git(dir, "status", "--porcelain", "--untracked-files=all"), "", first.stdout);
  assert.strictEqual(read(dir, "CLAUDE.md"), "# Team rules\n");
  assert.strictEqual(read(dir, "AGENTS.md"), "# Team agents\n");
  assert.strictEqual(read(dir, ".gitignore"), "node_modules/\n");

  assert.match(read(dir, "CLAUDE.local.md"), /^## Workflow/m);
  assert.match(read(dir, ".codex/workflow/CODEX.md"), /## Codex execution/);
  assert.ok(fs.existsSync(path.join(dir, ".codex/plans/_template.md")));
  const exclude = read(dir, ".git/info/exclude");
  assert.match(exclude, /# Claude \+ Codex workflow \(local only\)/);
  assert.match(exclude, /^\.codex\/plans\/$/m);
  assert.match(exclude, /^CLAUDE\.local\.md$/m);
  assert.doesNotMatch(exclude, /^\.codex\/hooks\.json$/m, "a tracked hooks.json isn't excluded");

  assert.ok(!fs.existsSync(path.join(dir, "..", `${path.basename(dir)}-codex-home`, "hooks.json")));

  const settings = JSON.parse(read(dir, ".claude/settings.local.json"));
  assert.strictEqual(settings.hooks.PostToolUse[0].matcher, "ExitPlanMode");

  // Re-running changes nothing.
  const files = ["CLAUDE.local.md", ".git/info/exclude", ".claude/settings.local.json", ".codex/workflow/CODEX.md"].map((rel) => read(dir, rel));
  const second = install(dir);
  assert.strictEqual(second.status, 0, second.stdout + second.stderr);
  assert.deepStrictEqual(["CLAUDE.local.md", ".git/info/exclude", ".claude/settings.local.json", ".codex/workflow/CODEX.md"].map((rel) => read(dir, rel)), files);
  assert.strictEqual(git(dir, "status", "--porcelain", "--untracked-files=all"), "");
});

test("setup in a fresh repo creates and hides its own .codex/hooks.json", () => {
  const dir = gitRepo();
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(read(dir, ".git/info/exclude"), /^\.codex\/hooks\.json$/m);
  const hooks = JSON.parse(read(dir, ".codex/hooks.json"));
  assert.ok(!hooks.hooks.Stop && hooks.hooks.PreToolUse);
  assert.strictEqual(git(dir, "status", "--porcelain", "--untracked-files=all"), "");
  assert.ok(!fs.existsSync(path.join(dir, ".gitignore")));
  assert.ok(!fs.existsSync(path.join(dir, "CLAUDE.md")));
});

test("upgrade removes workflow hooks from project and user files, preserving other hooks", () => {
  const dir = gitRepo();
  const other = { type: "command", command: "echo unrelated" };
  const old = { type: "command", command: "node .codex/hooks/claude-verify.js" };
  const config = { hooks: { Stop: [{ matcher: "*", hooks: [old, other] }, { hooks: [{ ...old, command: "old launcher", commandWindows: old.command }] }] } };
  write(dir, ".codex/hooks.json", JSON.stringify(config));
  const userFile = path.join(dir, "..", `${path.basename(dir)}-codex-home`, "hooks.json");
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify(config));
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  for (const file of [path.join(dir, ".codex/hooks.json"), userFile]) {
    const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks;
    assert.deepStrictEqual(hooks.Stop, [{ matcher: "*", hooks: [other] }]);
  }
  assert.ok(JSON.parse(read(dir, ".codex/hooks.json")).hooks.PreToolUse, "an untracked project file gets the graphify hooks");
  assert.ok(!JSON.parse(fs.readFileSync(userFile, "utf8")).hooks.PreToolUse, "the user file only loses the old hook");
  const before = read(dir, ".codex/hooks.json");
  assert.strictEqual(install(dir).status, 0);
  assert.strictEqual(read(dir, ".codex/hooks.json"), before);
});

test("upgrade only points out the old Stop hook in a tracked .codex/hooks.json", () => {
  const dir = gitRepo();
  const legacy = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .codex/hooks/claude-verify.js" }] }] } });
  write(dir, ".codex/hooks.json", legacy);
  git(dir, "add", ".codex/hooks.json");
  git(dir, "commit", "-qm", "legacy hooks");
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.strictEqual(read(dir, ".codex/hooks.json"), legacy, "a tracked file is never edited");
  assert.match(result.stdout, /\.codex\/hooks\.json \(old workflow\): still has the previous version's Stop hook/);
  assert.strictEqual(git(dir, "status", "--porcelain", "--untracked-files=all"), "");
});

test("untracked plans from the old plans/ folder move to .codex/plans/", () => {
  const dir = gitRepo();
  write(dir, "plans/old-task.md", "---\ntask: old-task\n---\n");
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(dir, ".codex/plans/old-task.md")));
  assert.ok(!fs.existsSync(path.join(dir, "plans/old-task.md")));
});

test("--shared keeps the team-wide layout in CLAUDE.md, AGENTS.md and .gitignore", () => {
  const dir = gitRepo();
  const result = install(dir, ["--shared"]);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(read(dir, "CLAUDE.md"), /^## Workflow/m);
  assert.match(read(dir, "AGENTS.md"), /^## Codex execution/m);
  assert.match(read(dir, ".gitignore"), /^\.codex\/plans\/\*$/m);
  assert.ok(!fs.existsSync(path.join(dir, "CLAUDE.local.md")));
});

// ---- planning checklist ----

const goodPlan = `---
task: add-badge
risk: normal
review: none
ui: yes
---

# Add a badge

## Acceptance
- A1: badge renders on the profile page
- A2: badge count comes from the API

## UI audit
- Start: \`node --version\`
- URL: http://localhost:3999/profile
- Viewports: 375, 1280
- Checks:
  - the badge is visible next to the name

## Phase 1: API
**Scope:** src/api/badge.js
**Steps:**
1. Add the endpoint.
**Covers:** A2
**Done when:** GET /badge returns { count }.
**Hands off:** \`getBadge()\` in src/api/badge.js returning { count: number }.
**Gate (must pass):**
- \`node --version\`

## Phase 2: UI
**Scope:** src/ui/Badge.jsx
**Steps:**
1. Render the badge.
**Covers:** A1
**Done when:** the badge shows the count.
**Gate (must pass):**
- \`node --version\`
`;

function planRepo(text, pkg) {
  const dir = gitRepo();
  if (pkg) write(dir, "package.json", JSON.stringify(pkg));
  write(dir, ".codex/plans/add-badge.md", text);
  return dir;
}

test("a complete plan passes every checklist item", () => {
  const dir = planRepo(goodPlan);
  const failed = lib.planChecklist(dir, "add-badge", goodPlan).filter((item) => !item.ok);
  assert.deepStrictEqual(failed, []);
});

test("the checklist catches uncovered acceptance, missing handoff, missing scripts and UI gaps", () => {
  const text = goodPlan
    .replace("**Covers:** A1", "**Covers:** A3")
    .replace(/\*\*Hands off:\*\*.*\n/, "")
    .replace("- `node --version`\n\n## Phase 2", "- `npm run nope`\n\n## Phase 2")
    .replace(/## UI audit[\s\S]*?(?=## Phase 1)/, "");
  const dir = planRepo(text, { scripts: { test: "node --test" } });
  const problems = lib.planProblems(dir, "add-badge", text).join("\n");
  assert.match(problems, /every acceptance item is covered by a phase: A1/);
  assert.match(problems, /every \*\*Covers:\*\* id exists under Acceptance: A3/);
  assert.match(problems, /Phase 1: \*\*Hands off:\*\*/);
  assert.match(problems, /no "nope" script in package\.json/);
  assert.match(problems, /ui: yes has a `## UI audit` section/);
});

test("gates must be runnable: unknown programs are reported", () => {
  const dir = gitRepo();
  assert.match(lib.gateProblem(dir, "definitely-not-a-real-tool-xyz --check"), /isn't on PATH/);
  assert.strictEqual(lib.gateProblem(dir, "node --version && git --version"), "");
});

// ---- Codex session discovery ----

// A thread as the Codex app-server's thread/read returns it.
function liveThread(id, cwd, extra = {}) {
  return { id, cwd, source: "vscode", status: { type: "idle" }, threadSource: "user", ephemeral: false, parentThreadId: null, createdAt: 1000, updatedAt: 1000, ...extra };
}

test("pickCodexSession picks the newest of the user's own sessions in the repo", () => {
  const repo = tempDir("ccw-repo-");
  const threads = [
    liveThread("old-match", repo, { updatedAt: 1000 }),
    liveThread("new-match", isWindows ? `\\\\?\\${repo.toUpperCase()}` : repo, { updatedAt: 3000 }),
    liveThread("other-repo", path.join(repo, "..", "elsewhere"), { updatedAt: 9000 }),
    liveThread("headless", repo, { source: "exec", updatedAt: 9000 }),
    liveThread("subagent", repo, { parentThreadId: "new-match", updatedAt: 9000 }),
    liveThread("title", repo, { ephemeral: true, threadSource: "thread_title", updatedAt: 9000 }),
  ];
  const { session, others } = lib.pickCodexSession(threads, repo);
  assert.strictEqual(session.id, "new-match");
  assert.strictEqual(session.status, "idle");
  assert.deepStrictEqual(others.map((other) => other.id), ["old-match"]);
  assert.strictEqual(lib.pickCodexSession(threads, path.join(repo, "..", "nowhere")).session, null);
});

test("WebSocket frames round-trip at every length encoding", () => {
  for (const size of [5, 300, 70000]) {
    const text = "x".repeat(size);
    for (const mask of [true, false]) {
      const frame = lib.encodeFrame(text, { mask });
      const { frames, rest } = lib.decodeFrames(Buffer.concat([frame, frame.subarray(0, 1)]));
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].text, text);
      assert.strictEqual(rest.length, 1);
    }
  }
});

// ---- autopilot handoff and wait ----

function workflowRepo() {
  const dir = gitRepo();
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  write(dir, ".codex/plans/add-badge.md", goodPlan);
  return dir;
}

function autopilot(dir, args, env = {}) {
  return spawnSync(process.execPath, [path.join(dir, ".codex", "autopilot.js"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}

test("handoff refuses a plan that fails the checklist", () => {
  const dir = workflowRepo();
  write(dir, ".codex/plans/add-badge.md", goodPlan.replace("**Covers:** A1", ""));
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--print"]);
  assert.strictEqual(result.status, 1, result.stdout);
  assert.match(result.stdout, /Not handed off/);
});

test("handoff --print exits 5 with the paste line", () => {
  const dir = workflowRepo();
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--print"]);
  assert.strictEqual(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /Execute \.codex\/plans\/add-badge\.md\. Follow \.codex\/workflow\/CODEX\.md, section Full plan execution\./);
});

// A codex stand-in (tests/fixtures/fake-codex.js) on PATH. Its app-server serves the threads
// in threadsFile; `queue` records its arguments in argsFile.
function fakeCodex({ threads, queueCode = 0, proxyCode = 0, review, execCode = 0 } = {}) {
  const bin = tempDir("ccw-bin-");
  const config = { threadsFile: path.join(bin, "threads.json"), argsFile: path.join(bin, "args.txt"), queueCode, proxyCode, review, execCode };
  fs.writeFileSync(path.join(bin, "config.json"), JSON.stringify(config));
  if (threads) fs.writeFileSync(config.threadsFile, JSON.stringify(threads));
  const script = path.join(__dirname, "fixtures", "fake-codex.js");
  if (isWindows) fs.writeFileSync(path.join(bin, "codex.cmd"), `@"${process.execPath}" "${script}" "${path.join(bin, "config.json")}" %*\r\n`);
  else {
    fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "${path.join(bin, "config.json")}" "$@"\n`);
    fs.chmodSync(path.join(bin, "codex"), 0o755);
  }
  return { ...config, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}

const liveId = "11111111-2222-3333-4444-555555555555";

test("handoff sends the plan to the Codex session open in the repo, and names it", () => {
  const dir = workflowRepo();
  const codex = fakeCodex({ threads: [liveThread(liveId, dir), liveThread("title-thread", dir, { ephemeral: true, threadSource: "thread_title", updatedAt: 5000 })] });
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md"], codex.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(codex.argsFile, "utf8"), new RegExp(`queue --thread ${liveId} --message "?Execute \\.codex/plans/add-badge\\.md`));
  assert.match(result.stdout, new RegExp(`Sent to Codex session ${liveId} \\(vscode, idle\\) in `));
  const handoff = JSON.parse(read(dir, ".codex/autopilot/handoff.json"));
  assert.strictEqual(handoff.via, "codex queue");
  assert.strictEqual(handoff.thread, liveId);
  assert.strictEqual(handoff.source, "vscode");
});

test("handoff with no Codex session open prints the paste line instead of opening a terminal", () => {
  const dir = workflowRepo();
  const codex = fakeCodex({ threads: [liveThread(liveId, path.join(dir, "..", "elsewhere"))] });
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--wait", "0"], codex.env);
  assert.strictEqual(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /No Codex session is open in this repo\./);
  assert.match(result.stdout, /Paste this into Codex:\s+Execute \.codex\/plans\/add-badge\.md/);
  assert.ok(!fs.existsSync(codex.argsFile), "nothing should be queued");
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/handoff.json")).via, "print");
});

test("handoff waits for Codex to be started in the repo, then sends the plan to it", async () => {
  const dir = workflowRepo();
  const codex = fakeCodex();
  const child = spawn(process.execPath, [path.join(dir, ".codex", "autopilot.js"), "handoff", ".codex/plans/add-badge.md", "--wait", "30"], {
    cwd: dir,
    env: { ...process.env, ...codex.env },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stdout += chunk));
  setTimeout(() => fs.writeFileSync(codex.threadsFile, JSON.stringify([liveThread(liveId, dir)])), 1000);
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.strictEqual(status, 0, stdout);
  assert.match(stdout, /Start Codex in a terminal here/);
  assert.match(fs.readFileSync(codex.argsFile, "utf8"), new RegExp(`queue --thread ${liveId}`));
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/handoff.json")).via, "codex queue");
});

test("handoff prints the paste line when codex queue fails", () => {
  const dir = workflowRepo();
  const codex = fakeCodex({ threads: [liveThread(liveId, dir)], queueCode: 1 });
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md"], codex.env);
  assert.strictEqual(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`codex queue to ${liveId} failed`));
  assert.match(result.stdout, /Paste this into Codex:/);
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/handoff.json")).via, "print");
});

test("handoff explains an unreachable Codex app-server and prints the paste line", () => {
  const dir = workflowRepo();
  const codex = fakeCodex({ proxyCode: 1 });
  const result = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--wait", "0"], codex.env);
  assert.strictEqual(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /Couldn't ask the Codex app-server for open sessions: codex app-server proxy exited with 1/);
  assert.match(result.stdout, /Paste this into Codex:/);
  assert.ok(!fs.existsSync(codex.argsFile), "nothing should be queued");
});

test("wait returns when the run is done, with a summary, and 4 when it's stuck", () => {
  const dir = workflowRepo();
  const since = new Date(Date.now() - 1000).toISOString();
  const status = (state) =>
    write(dir, ".codex/autopilot/status.json", JSON.stringify({ slug: "add-badge", state, reason: state === "stuck" ? "phase 2 still needs rework" : "", updated: new Date().toISOString(), phases: { 1: { verdict: "PASS", alignment: "PASS", checks: "pass", ui: "not run" } } }));
  status("done");
  let result = autopilot(dir, ["wait", ".codex/plans/add-badge.md", "--since", since, "--timeout", "30"]);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Run add-badge: DONE/);
  assert.match(result.stdout, /Phase 1 \(API\): PASS/);
  assert.match(result.stdout, /final-ui-audit\.md/);
  status("stuck");
  result = autopilot(dir, ["wait", ".codex/plans/add-badge.md", "--since", since, "--timeout", "30"]);
  assert.strictEqual(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /handoff \.codex\/plans\/add-badge\.md --continue/);
});

// ---- explicit alignment verification ----

// A headless-claude stand-in on PATH. It answers the alignment review with PASS and records
// each call (name, start, end) in times.jsonl.
function fakeClaude({ verdict = "PASS", structured = true, status = 0 } = {}) {
  const bin = tempDir("ccw-claude-");
  const times = path.join(bin, "times.jsonl");
  const fake = path.join(bin, "fake-claude.js");
  fs.writeFileSync(
    fake,
    `const fs = require("fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
const name = /UI AUDIT/.test(prompt) ? "ui" : "alignment";
const start = Date.now();
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(times)}, JSON.stringify({ name, args: process.argv.slice(2), prompt, start, end: Date.now() }) + "\\n");
  const output = { result: name === "ui" ? "UI AUDIT: PASS" : "DONE: fallback\\nVERDICT: PASS", structured_output: ${structured} ? name === "ui" ? { checks: [{ item: "badge visible", viewport: "375", status: ${JSON.stringify(verdict)} === "NEEDS REWORK" ? "FAIL" : "PASS", evidence: "snapshot" }], risks: [], polish: ["tighten card spacing"], verdict: ${JSON.stringify(verdict)} } : { done: [{ item: "all", evidence: "src/label.js:1" }], partial: [], missing: [], outOfScope: [], handsOff: [], risks: [], verdict: ${JSON.stringify(verdict)} } : undefined };
  process.stdout.write(JSON.stringify(output));
  process.exit(${status});
}, 100);
`,
  );
  // Shaped like npm's shim, which workflow-lib resolves to `node <script>` on Windows.
  if (isWindows) fs.writeFileSync(path.join(bin, "claude.cmd"), `@node "%dp0%\\fake-claude.js" %*\r\n`);
  else {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    fs.chmodSync(path.join(bin, "claude"), 0o755);
  }
  const calls = () => (fs.existsSync(times) ? fs.readFileSync(times, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { bin, calls, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}

// ---- baseline: failures that were there before the task ----

test("diagnostic lines ignore locations, counts and timings, but count repeats", () => {
  const before = lib.diagnosticLines("src/a.ts(10,5): error TS2307: Cannot find module 'exceljs'.\nFound 4 errors in 1 file. Done in 3.2s");
  assert.deepStrictEqual(lib.newFailureLines("src/a.ts(42,5): error TS2307: Cannot find module 'exceljs'.\nFound 5 errors in 1 file. Done in 9.9s", before), []);
  const twice = "src/a.ts(1,1): error TS2307: Cannot find module 'exceljs'.\nsrc/a.ts(9,1): error TS2307: Cannot find module 'exceljs'.";
  assert.deepStrictEqual(lib.newFailureLines(twice, before), ["src/a.ts(9,1): error TS2307: Cannot find module 'exceljs'."]);
  assert.deepStrictEqual(lib.newFailureLines("src/b.ts:3:7 error no-unused-vars", before), ["src/b.ts:3:7 error no-unused-vars"]);
});

const gatePlan = `---
task: fix-label
risk: normal
review: none
ui: no
---

# Fix the label

## Acceptance
- A1: the label reads right

## Phase 1: Label
**Scope:** src/label.js
**Steps:**
1. Fix the label.
**Covers:** A1
**Done when:** the label reads right.
**Gate (must pass):**
- \`node gate.js\`
`;

const oldError = "src/old.ts(1,23): error TS2307: Cannot find module 'exceljs'.";

// A repo whose gate prints errors.txt and fails when it isn't empty.
function gateRepo(errors) {
  const dir = gitRepo();
  const result = install(dir);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  write(dir, ".codex/plans/fix-label.md", gatePlan);
  write(dir, ".codex/verify.json", JSON.stringify({ checks: [] }));
  write(dir, "gate.js", 'const fs = require("fs");\nconst text = fs.existsSync("errors.txt") ? fs.readFileSync("errors.txt", "utf8") : "";\nprocess.stdout.write(text);\nprocess.exit(text.trim() ? 1 : 0);\n');
  write(dir, "errors.txt", errors);
  return dir;
}

function step(dir, args, env = {}) {
  return autopilot(dir, [args[0], ".codex/plans/fix-label.md", ...args.slice(1)], env);
}

test("begin records a baseline, and a gate failing only with those errors doesn't block", () => {
  const dir = gateRepo(`${oldError}\nFound 1 error.\n`);
  const claude = fakeClaude();
  let result = step(dir, ["begin"]);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /baseline: "node gate\.js" already fails before the task/);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  write(dir, "src/label.js", "module.exports = 'right';\n");
  // The same error, moved to another line, is still the pre-existing one.
  write(dir, "errors.txt", `${oldError.replace("(1,23)", "(7,23)")}\nFound 1 error.\n`);
  result = step(dir, ["verify", "1"], claude.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /fails only with errors that were there before the task started; not blocking/);
  assert.match(result.stdout, /VERDICT: PASS/);
  const status = JSON.parse(read(dir, ".codex/autopilot/status.json"));
  assert.deepStrictEqual(status.phases["1"].preexisting, ["node gate.js"]);
});

test("a gate with a new failure exits 2 and lists what's new; the 3rd failure stops the run", () => {
  const dir = gateRepo(`${oldError}\n`);
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  write(dir, "errors.txt", `${oldError}\nsrc/label.js(2,1): error TS2322: Type 'number' is not assignable to type 'string'.\n`);
  let result = step(dir, ["verify", "1"]);
  assert.strictEqual(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /GATE FAILED \(try 1 of 3\)/);
  assert.match(result.stdout, /New since the task started:\nsrc\/label\.js\(2,1\): error TS2322/);
  assert.match(result.stdout, /autopilot\.js stop \.codex\/plans\/fix-label\.md --reason/);
  assert.strictEqual(step(dir, ["verify", "1"]).status, 2);
  result = step(dir, ["verify", "1"]);
  assert.strictEqual(result.status, 4, result.stdout + result.stderr);
  const status = JSON.parse(read(dir, ".codex/autopilot/status.json"));
  assert.strictEqual(status.state, "stuck");
  assert.match(status.reason, /still fails after 3 tries/);
});

test("stop marks the run stuck with Codex's reason, and wait reports it", () => {
  const dir = gateRepo("");
  const since = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  let result = step(dir, ["stop", "--reason", "needs the exceljs package installed"]);
  assert.strictEqual(result.status, 4, result.stdout + result.stderr);
  const status = JSON.parse(read(dir, ".codex/autopilot/status.json"));
  assert.strictEqual(status.state, "stuck");
  assert.match(status.reason, /needs the exceljs package installed \(at phase 1, step implement\)/);
  result = step(dir, ["wait", "--since", since, "--timeout", "30"]);
  assert.strictEqual(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /STUCK -- needs the exceljs package installed/);
});

// A run that began and is still "running", handed off to Codex session `thread`.
function runningRepo(thread) {
  const dir = gateRepo("");
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  const at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  write(dir, ".codex/autopilot/handoff.json", JSON.stringify({ slug: "fix-label", plan: ".codex/plans/fix-label.md", via: "codex queue", thread, at }));
  return dir;
}

const fastWait = { CCW_WAIT_POLL_MS: "100", CCW_WAIT_CHECK_MS: "200", CCW_WAIT_QUIET_MS: "1", CCW_WAIT_GRACE_MS: "1" };

test("wait notices Codex stopped without finishing and passes on its last message", () => {
  const dir = runningRepo(liveId);
  const lastMessage = "Execution stopped at the TypeScript gate: master-product-export.service.ts is missing exceljs.";
  const codex = fakeCodex({
    threads: [liveThread(liveId, dir, { turns: [{ status: "completed", items: [{ type: "userMessage", content: [] }, { type: "agentMessage", text: lastMessage }] }] })],
  });
  const result = step(dir, ["wait", "--timeout", "60"], { ...codex.env, ...fastWait });
  assert.strictEqual(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /STUCK -- Codex stopped without finishing the run \(last step: implement, phase 1\)/);
  assert.match(result.stdout, /Codex's last message:\n\s+Execution stopped at the TypeScript gate/);
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/status.json")).state, "stuck");
});

test("wait notices the Codex session was closed mid-run", () => {
  const dir = runningRepo(liveId);
  const result = step(dir, ["wait", "--timeout", "60"], { ...fakeCodex({ threads: [] }).env, ...fastWait });
  assert.strictEqual(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /the Codex session was closed before the run finished/);
});

test("wait keeps waiting while Codex is working", () => {
  const dir = runningRepo(liveId);
  const codex = fakeCodex({ threads: [liveThread(liveId, dir, { status: { type: "active", activeFlags: ["waitingOnApproval"] } })] });
  const result = step(dir, ["wait", "--timeout", "2"], { ...codex.env, ...fastWait });
  assert.strictEqual(result.status, 6, result.stdout + result.stderr);
  assert.match(result.stdout, /Codex is waiting for your approval in its panel/);
});

test("verify carries baseline check failures into one alignment review", () => {
  const dir = gateRepo("");
  write(dir, "check.js", `process.stdout.write(${JSON.stringify(oldError)}); process.exit(1);\n`);
  write(dir, ".codex/verify.json", JSON.stringify({ checks: ["node check.js"] }));
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  write(dir, "src/label.js", "module.exports = 'right';\n");
  const claude = fakeClaude();
  const result = step(dir, ["verify", "1"], claude.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const state = JSON.parse(read(dir, ".codex/verify/state.json"));
  assert.deepStrictEqual(JSON.parse(read(dir, ".codex/autopilot/status.json")).phases["1"].preexisting, ["node check.js"]);
  assert.strictEqual(state.lastVerdict, "PASS");
  assert.strictEqual(claude.calls().length, 1);
});

test("a new project check failure exits 2 without any Claude call, then stops on the third failure", () => {
  const dir = gateRepo("");
  write(dir, "check.js", 'const fs = require("fs"); const text = fs.readFileSync("check-errors.txt", "utf8"); process.stdout.write(text); process.exit(text ? 1 : 0);');
  write(dir, "check-errors.txt", "");
  write(dir, ".codex/verify.json", JSON.stringify({ checks: ["node check.js"] }));
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  write(dir, "check-errors.txt", "new check failure");
  const claude = fakeClaude();
  const result = step(dir, ["verify", "1"], claude.env);
  assert.strictEqual(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /New since the task started:\nnew check failure/);
  assert.strictEqual(step(dir, ["verify", "1"], claude.env).status, 2);
  assert.strictEqual(step(dir, ["verify", "1"], claude.env).status, 4);
  assert.strictEqual(claude.calls().length, 0);
});

test("green verification deduplicates checks and makes one structured alignment call", () => {
  const dir = gateRepo("");
  write(dir, "gate.js", 'const fs = require("fs"); fs.appendFileSync("gate-count.txt", "x");');
  write(dir, ".codex/verify.json", JSON.stringify({ checks: ["node gate.js", "node gate.js"] }));
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  write(dir, "gate-count.txt", "");
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  write(dir, "src/label.js", "module.exports = 'right';\n");
  const claude = fakeClaude();
  const result = step(dir, ["verify", "1"], claude.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.strictEqual(read(dir, "gate-count.txt"), "x");
  const calls = claude.calls();
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].args.includes("--json-schema"));
  assert.strictEqual(calls[0].args[calls[0].args.indexOf("--max-turns") + 1], "40");
  assert.match(calls[0].prompt, /Phase diff:[\s\S]*module.exports/);
  assert.match(read(dir, ".codex/verify/alignment.md"), /all: src\/label.js:1/);
  for (const file of ["phase-1.alignment.md", "phase-1.checks.log", "phase-1.diff"]) {
    assert.ok(fs.existsSync(path.join(dir, ".codex/verify/fix-label", file)), file);
  }
});

test("structured alignment verdict takes precedence over text and falls back for old clients", () => {
  const dir = gateRepo("");
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  const result = step(dir, ["verify", "1"], fakeClaude({ verdict: "NEEDS REWORK" }).env);
  assert.strictEqual(result.status, 3, result.stdout + result.stderr);
  assert.strictEqual(JSON.parse(read(dir, ".codex/verify/state.json")).lastVerdict, "NEEDS REWORK");
  assert.strictEqual(step(dir, ["verify", "1"], fakeClaude({ structured: false }).env).status, 0);
});

test("removed run command returns usage", () => {
  const dir = workflowRepo();
  const result = autopilot(dir, ["run", ".codex/plans/add-badge.md"]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /usage:/);
});

test("single-phase handoff begins automatically, pauses on PASS and wait names next phase", () => {
  const dir = workflowRepo();
  write(dir, ".codex/verify.json", JSON.stringify({ checks: [], baseline: false }));
  const handed = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--phase", "1", "--print"]);
  assert.strictEqual(handed.status, 5);
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/handoff.json")).phase, "1");
  const since = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(autopilot(dir, ["phase", ".codex/plans/add-badge.md", "1"]).status, 0);
  const claude = fakeClaude();
  const result = autopilot(dir, ["verify", ".codex/plans/add-badge.md", "1"], claude.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PAUSED/);
  const waited = autopilot(dir, ["wait", ".codex/plans/add-badge.md", "--since", since, "--timeout", "2"]);
  assert.strictEqual(waited.status, 0, waited.stdout + waited.stderr);
  assert.match(waited.stdout, /handoff .* --phase 2/);
  assert.strictEqual(autopilot(dir, ["phase", ".codex/plans/add-badge.md", "2"]).status, 0);
});


test("review is read-only and ephemeral, prints and saves structured findings without editing the plan", () => {
  const dir = workflowRepo();
  const original = read(dir, ".codex/plans/add-badge.md");
  const codex = fakeCodex({ review: { findings: [{ phase: "2", problem: "missing UI spec", evidence: "src/ui/Badge.jsx", proposedFix: "add a spec gate" }], verdict: "CHANGES NEEDED" } });
  const result = autopilot(dir, ["review", ".codex/plans/add-badge.md"], codex.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Phase 2: missing UI spec/);
  assert.match(result.stdout, /Evidence: src\/ui\/Badge.jsx/);
  assert.match(result.stdout, /Proposed fix: add a spec gate/);
  assert.match(result.stdout, /PLAN REVIEW: CHANGES NEEDED/);
  const args = JSON.parse(fs.readFileSync(codex.argsFile, "utf8"));
  assert.strictEqual(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes("--ephemeral") && args.includes("--output-schema"));
  assert.strictEqual(read(dir, ".codex/plans/add-badge.md"), original);
  assert.strictEqual(JSON.parse(read(dir, ".codex/verify/add-badge/plan-review.json")).verdict, "CHANGES NEEDED");
  assert.ok(!fs.existsSync(path.join(dir, ".codex/plans/.add-badge.orig.md")));
});

// Isolate graphify and the globally installed Playwright package for close-time tests.
function fakeCloseTools(claude) {
  const bin = claude.bin;
  const globalRoot = path.join(bin, "global");
  write(globalRoot, "@playwright/mcp/package.json", JSON.stringify({ version: "test", bin: { "playwright-mcp": "cli.js" } }));
  write(globalRoot, "@playwright/mcp/cli.js", "");
  const browser = path.join(bin, "chromium");
  fs.writeFileSync(browser, "");
  write(globalRoot, "@playwright/mcp/node_modules/playwright/package.json", JSON.stringify({ main: "index.js" }));
  write(globalRoot, "@playwright/mcp/node_modules/playwright/index.js", `module.exports = { chromium: { executablePath: () => ${JSON.stringify(browser)} } };`);
  const graphCalls = path.join(bin, "graph-calls.txt");
  for (const [name, code] of [["npm", `console.log(${JSON.stringify(globalRoot)});`], ["graphify", `require("fs").appendFileSync(${JSON.stringify(graphCalls)}, process.argv.slice(2).join(" ") + "\\n");`]]) {
    const file = path.join(bin, `${name}.js`);
    fs.writeFileSync(file, code);
    if (isWindows) fs.writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${file}" %*\r\n`);
    else {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  }
  return { graphCalls, env: claude.env };
}

async function closeUiRepo() {
  const dir = gateRepo("");
  const server = require("node:net").createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const text = gatePlan.replace("ui: no", "ui: yes") + `\n## UI audit\n- Start: \`node ui-app.js\`\n- URL: http://127.0.0.1:${port}\n- Checks:\n  - badge visible\n`;
  write(dir, ".codex/plans/fix-label.md", text);
  write(dir, "ui-app.js", `console.log("ui app started"); require("http").createServer((req, res) => res.end("badge")).listen(${port}, "127.0.0.1");`);
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  return dir;
}

test("non-UI begin to close makes one alignment call and no summary call", () => {
  const dir = gateRepo("");
  const claude = fakeClaude();
  const runtime = fakeCloseTools(claude);
  assert.strictEqual(step(dir, ["begin"], runtime.env).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"], runtime.env).status, 0);
  assert.strictEqual(step(dir, ["verify", "1"], runtime.env).status, 0);
  const result = step(dir, ["close"], runtime.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.deepStrictEqual(claude.calls().map((call) => call.name), ["alignment"]);
  assert.strictEqual(fs.readFileSync(runtime.graphCalls, "utf8"), "update .\n");
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/status.json")).state, "done");
  assert.ok(!fs.existsSync(path.join(dir, ".codex/tasks")));
});

test("UI close makes one structured report-only audit, logs app startup and becomes done", async () => {
  const dir = await closeUiRepo();
  const claude = fakeClaude();
  const runtime = fakeCloseTools(claude);
  const result = step(dir, ["close"], runtime.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.strictEqual(claude.calls().length, 1);
  const call = claude.calls()[0];
  assert.strictEqual(call.name, "ui");
  assert.strictEqual(call.args[call.args.indexOf("--max-turns") + 1], "80");
  assert.ok(call.args.includes("--json-schema") && call.args.includes("--mcp-config"));
  assert.ok(call.args.includes("mcp__playwright__browser_navigate"));
  assert.ok(call.args.includes("--disallowedTools"));
  assert.match(read(dir, ".codex/verify/fix-label/final-ui-audit.md"), /PASS: badge visible/);
  assert.match(read(dir, ".codex/verify/fix-label/final-ui-audit.md"), /## Polish notes for Claude\r?\n- tighten card spacing/);
  assert.match(call.prompt, /polish notes never fail the audit/);
  assert.match(result.stdout, /Claude polishes the UI in its review/);
  assert.match(read(dir, ".codex/verify/fix-label/final-ui.app.log"), /ui app started/);
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/status.json")).state, "done");
});

test("UI close reworks twice and then stops, without graphify or a summary call", async () => {
  const dir = await closeUiRepo();
  const claude = fakeClaude({ verdict: "NEEDS REWORK" });
  const runtime = fakeCloseTools(claude);
  for (const code of [3, 3, 4]) {
    const result = step(dir, ["close"], runtime.env);
    assert.strictEqual(result.status, code, result.stdout + result.stderr);
  }
  assert.strictEqual(claude.calls().length, 3);
  assert.ok(!fs.existsSync(runtime.graphCalls));
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/status.json")).state, "stuck");
});

test("UI close blocks new check failures before calling Claude and accepts baseline failures", async () => {
  const dir = await closeUiRepo();
  write(dir, "check.js", 'const fs = require("fs"); const text = fs.readFileSync("check-errors.txt", "utf8"); process.stdout.write(text); process.exit(1);');
  write(dir, "check-errors.txt", oldError);
  write(dir, ".codex/verify.json", JSON.stringify({ checks: ["node check.js"] }));
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  const claude = fakeClaude({ verdict: "BLOCKED" });
  const runtime = fakeCloseTools(claude);
  write(dir, "check-errors.txt", oldError + "\nnew failure");
  assert.strictEqual(step(dir, ["close"], runtime.env).status, 2);
  assert.strictEqual(claude.calls().length, 0);
  write(dir, "check-errors.txt", oldError);
  const result = step(dir, ["close"], runtime.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /UI AUDIT: BLOCKED/);
  assert.strictEqual(claude.calls().length, 1);
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/status.json")).state, "done");
});
