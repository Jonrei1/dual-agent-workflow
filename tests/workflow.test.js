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
  const result = spawnSync(process.execPath, [installer, "--project-only", "--skip-graphify", "--root", dir, ...extra], {
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
- Browser: headless
- Checks:
  - the badge is visible next to the name

## Frontend (Claude)
- Builds: the profile page and its Badge component
**Covers:** A1

## Phase 1: API
**Scope:** src/api/badge.js
**Steps:**
1. Add the endpoint.
**Covers:** A2
**Done when:** GET /badge returns { count }.
**Hands off:** \`getBadge()\` in src/api/badge.js returning { count: number }.
**Gate (must pass):**
- \`node --version\`

## Phase 2: Wiring
**Scope:** src/api/index.js
**Steps:**
1. Export the endpoint.
**Covers:** A2
**Done when:** the endpoint is reachable.
**Hands off:** \`GET /badge\` returns { count: number }.
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
    .replace(/## UI audit[\s\S]*?(?=## Frontend)/, "");
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
    write(dir, ".codex/autopilot/status.json", JSON.stringify({ slug: "add-badge", state, phase: state === "stuck" ? "2" : "", reason: state === "stuck" ? "phase 2 still needs rework" : "", updated: new Date().toISOString(), phases: { 1: { verdict: "PASS", alignment: "PASS", checks: "pass", ui: "not run" } } }));
  status("done");
  let result = autopilot(dir, ["wait", ".codex/plans/add-badge.md", "--since", since, "--timeout", "30"]);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Run add-badge: DONE/);
  assert.match(result.stdout, /Phase 1 \(API\): PASS/);
  assert.match(result.stdout, /build the frontend/);
  status("stuck");
  result = autopilot(dir, ["wait", ".codex/plans/add-badge.md", "--since", since, "--timeout", "30"]);
  assert.strictEqual(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /handoff \.codex\/plans\/add-badge\.md --phase 2 --continue/);
});

// ---- explicit alignment verification ----

// A headless-claude stand-in on PATH. It answers the alignment review with PASS and records
// each call (name, start, end) in times.jsonl.
function fakeClaude({ verdict = "PASS", structured = true, status = 0, must = [] } = {}) {
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
  const output = { result: name === "ui" ? "UI AUDIT: PASS" : "DONE: fallback\\nVERDICT: PASS", structured_output: ${structured} ? name === "ui" ? { checks: [{ item: "badge visible", viewport: "375", status: ${JSON.stringify(verdict)} === "NEEDS REWORK" ? "FAIL" : "PASS", evidence: "snapshot" }], risks: [], polish: ["tighten card spacing"], verdict: ${JSON.stringify(verdict)} } : { done: [{ item: "all", evidence: "src/label.js:1" }], partial: [], missing: [], outOfScope: [], handsOff: [], must: ${JSON.stringify(must)}, unneeded: [], risks: [], verdict: ${JSON.stringify(verdict)} } : undefined };
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
  const state = JSON.parse(read(dir, ".codex/verify/fix-label/state.json"));
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
  assert.match(read(dir, ".codex/verify/fix-label/alignment.md"), /all: src\/label.js:1/);
  for (const file of ["phase-1.alignment.md", "phase-1.checks.log", "phase-1.diff"]) {
    assert.ok(fs.existsSync(path.join(dir, ".codex/verify/fix-label", file)), file);
  }
});

test("structured alignment verdict takes precedence over text and falls back for old clients", () => {
  const dir = gateRepo("");
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  const result = step(dir, ["verify", "1"], fakeClaude({ verdict: "NEEDS REWORK" }).env);
  assert.strictEqual(result.status, 3, result.stdout + result.stderr);
  assert.strictEqual(JSON.parse(read(dir, ".codex/verify/fix-label/state.json")).lastVerdict, "NEEDS REWORK");
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
  write(dir, "base.txt", "base\n");
  git(dir, "add", "--", "base.txt");
  git(dir, "commit", "-qm", "base");
  write(dir, "unrelated.txt", "user work\n");
  git(dir, "add", "--", "unrelated.txt");
  write(dir, ".codex/verify.json", JSON.stringify({ checks: [], baseline: false }));
  const handed = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--phase", "1", "--print"]);
  assert.strictEqual(handed.status, 5);
  assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/handoff.json")).phase, "1");
  const since = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(autopilot(dir, ["phase", ".codex/plans/add-badge.md", "1"]).status, 0);
  write(dir, "phase.txt", "phase one\n");
  const claude = fakeClaude();
  const result = autopilot(dir, ["verify", ".codex/plans/add-badge.md", "1"], claude.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PAUSED/);
  const waited = autopilot(dir, ["wait", ".codex/plans/add-badge.md", "--since", since, "--timeout", "2"]);
  assert.strictEqual(waited.status, 0, waited.stdout + waited.stderr);
  assert.match(waited.stdout, /handoff .* --phase 2/);
  // Claude's checkpoint must preserve other staged work and allow the next phase to start.
  git(dir, "add", "--", "phase.txt");
  git(dir, "commit", "--only", "-qm", "feat(add-badge): phase 1", "--", "phase.txt");
  assert.strictEqual(git(dir, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "phase.txt");
  assert.strictEqual(git(dir, "diff", "--cached", "--name-only"), "unrelated.txt");
  assert.strictEqual(autopilot(dir, ["phase", ".codex/plans/add-badge.md", "2"]).status, 0);
  const state = JSON.parse(read(dir, ".codex/autopilot/status.json"));
  assert.strictEqual(lib.changedFiles(dir, state.phaseBase, lib.snapshot(dir)).length, 0);
  const resumed = autopilot(dir, ["handoff", ".codex/plans/add-badge.md", "--phase", "2", "--continue", "--print"]);
  assert.strictEqual(resumed.status, 5);
  assert.match(resumed.stdout, /section Single-phase handoff\. Resume only phase 2/);
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


// ---- headed or headless browser ----

test("a ui: yes plan must say whether the audit browser is headless or headed", () => {
  const withoutBrowser = goodPlan.replace("- Browser: headless\n", "");
  const dir = planRepo(withoutBrowser);
  const problems = lib.planProblems(dir, "add-badge", withoutBrowser).join("\n");
  assert.match(problems, /UI audit browser is headless or headed/);
  const placeholder = goodPlan.replace("- Browser: headless", "- Browser: <headless | headed>");
  assert.match(lib.planProblems(dir, "add-badge", placeholder).join("\n"), /UI audit browser/);
  assert.deepStrictEqual(lib.planProblems(dir, "add-badge", goodPlan.replace("- Browser: headless", "- Browser: headed (I want to watch)")), []);
  assert.strictEqual(lib.uiSettings(dir, goodPlan.replace("- Browser: headless", "- Browser: headed")).headed, true);
  assert.strictEqual(lib.uiSettings(dir, goodPlan).headed, false);
  // verify.json is only the fallback when the plan is silent.
  write(dir, ".codex/verify.json", JSON.stringify({ ui: { headed: true } }));
  assert.strictEqual(lib.uiSettings(dir, withoutBrowser).headed, true);
  assert.deepStrictEqual(lib.planProblems(dir, "add-badge", withoutBrowser), []);
  assert.strictEqual(lib.uiSettings(dir, goodPlan).headed, false, "the plan wins over verify.json");
});

// ---- per-task state, run owner and the gate-tamper guard ----

test("verify state and reports live under the task's folder, never in a shared global file", () => {
  const dir = gateRepo("");
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  assert.strictEqual(step(dir, ["verify", "1"], fakeClaude().env).status, 0);
  for (const file of ["state.json", "last.log", "alignment.md", "phase.diff", "phase-1.alignment.md"]) {
    assert.ok(fs.existsSync(path.join(dir, ".codex/verify/fix-label", file)), file);
  }
  for (const file of ["state.json", "last.log", "alignment.md", "phase.diff"]) {
    assert.ok(!fs.existsSync(path.join(dir, ".codex/verify", file)), `${file} must not be global`);
  }
});

test("begin records who started the run, and a second begin names the owner and suggests a worktree", () => {
  const dir = gateRepo("");
  write(dir, ".codex/plans/other.md", gatePlan.replace("task: fix-label", "task: other"));
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  const status = JSON.parse(read(dir, ".codex/autopilot/status.json"));
  assert.match(status.owner, /^test@example\.com \(.+@.+\)$/);
  const second = autopilot(dir, ["begin", ".codex/plans/other.md"]);
  assert.strictEqual(second.status, 1, second.stdout + second.stderr);
  assert.match(second.stderr, /another run \(\.codex\/plans\/fix-label\.md, started by test@example\.com/);
  assert.match(second.stderr, /git worktree add/);
});

test("changing verify.json or the plan after begin stops the run instead of loosening the gates", () => {
  for (const [file, change] of [
    [".codex/verify.json", (text) => text.replace('"checks":[]', '"checks":[],"baseline":false')],
    [".codex/plans/fix-label.md", (text) => text.replace("node gate.js", "node --version")],
  ]) {
    const dir = gateRepo("");
    assert.strictEqual(step(dir, ["begin"]).status, 0);
    assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
    write(dir, file, change(read(dir, file)));
    const claude = fakeClaude();
    const result = step(dir, ["verify", "1"], claude.env);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /changed after the run began/);
    assert.strictEqual(claude.calls().length, 0);
    assert.strictEqual(JSON.parse(read(dir, ".codex/autopilot/status.json")).state, "failed");
    // A deliberate change is accepted by beginning again.
    assert.strictEqual(step(dir, ["begin"]).status, 0);
    assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  }
});

test("alignment is asked for a senior-dev and QA review, and a MUST FIX finding fails the phase", () => {
  const dir = gateRepo("");
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  const claude = fakeClaude({ must: [{ item: "src/label.js:1", evidence: "an empty label crashes render()" }] });
  const result = step(dir, ["verify", "1"], claude.env);
  assert.strictEqual(result.status, 3, result.stdout + result.stderr);
  assert.match(claude.calls()[0].prompt, /MUST FIX[\s\S]*COULD BE CUT[\s\S]*new dependency/);
  assert.match(read(dir, ".codex/verify/fix-label/alignment.md"), /## MUST FIX\r?\n\r?\n- src\/label\.js:1: an empty label crashes render\(\)/);
});

// ---- frontend is Claude's ----

test("a phase Scope that names frontend files is rejected, whatever the plan's ui setting", () => {
  const dir = gitRepo();
  for (const scope of ["src/ui/Badge.jsx", "src/components/Button.tsx", "app/styles/site.css", "views/profile.html", "pages/index.vue", "frontend/app.js"]) {
    const text = gatePlan.replace("**Scope:** src/label.js", `**Scope:** ${scope}`);
    const problems = lib.planProblems(dir, "fix-label", text).join("\n");
    assert.match(problems, /Phase 1: \*\*Scope:\*\* is backend only/, scope);
  }
  for (const scope of ["src/label.js", "src/api/badge.js, src/db/schema.sql", "server/routes/users.ts", "src/auth/ui-session.js"]) {
    const text = gatePlan.replace("**Scope:** src/label.js", `**Scope:** ${scope}`);
    assert.doesNotMatch(lib.planProblems(dir, "fix-label", text).join("\n"), /backend only/, scope);
  }
});

test("a ui: yes plan needs a Frontend (Claude) section with Covers, and a Hands off on the last phase", () => {
  const dir = planRepo(goodPlan);
  const missing = goodPlan.replace(/## Frontend \(Claude\)[\s\S]*?(?=## Phase 1)/, "").replace(/(\*\*Covers:\*\* A2\n\*\*Done when:\*\* the endpoint is reachable\.\n)/, "$1**Covers:** A1\n");
  const problems = lib.planProblems(dir, "add-badge", missing).join("\n");
  assert.match(problems, /ui: yes has a `## Frontend \(Claude\)` section/);
  const noCovers = goodPlan.replace("**Covers:** A1\n\n## Phase 1", "\n## Phase 1");
  assert.match(lib.planProblems(dir, "add-badge", noCovers).join("\n"), /Frontend \(Claude\)` has `\*\*Covers:\*\*` acceptance ids/);
  const noApi = goodPlan.replace(/\*\*Hands off:\*\* `GET \/badge`[^\n]*\n/, "");
  assert.match(lib.planProblems(dir, "add-badge", noApi).join("\n"), /Phase 2: \*\*Hands off:\*\* \(the API contract Claude builds the frontend against\)/);
  // The frontend section's ids count toward coverage; a ui: no plan doesn't need the section.
  assert.deepStrictEqual(lib.planProblems(dir, "add-badge", goodPlan), []);
  assert.deepStrictEqual(lib.frontendSpec(goodPlan).covers, ["A1"]);
});

test("the alignment review treats any frontend change in a Codex phase as out of scope", () => {
  const dir = gateRepo("");
  assert.strictEqual(step(dir, ["begin"]).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"]).status, 0);
  write(dir, "src/label.js", "exports.label = 'right';\n");
  const claude = fakeClaude();
  assert.strictEqual(step(dir, ["verify", "1"], claude.env).status, 0);
  assert.match(claude.calls()[0].prompt, /ANY change to frontend files \(pages, components, views, styles,\s+templates\): those belong to Claude/);
});

test("closing a ui: yes plan makes no headless Claude call and no browser step: Claude builds and audits the frontend", () => {
  const dir = gateRepo("");
  write(dir, ".codex/plans/fix-label.md", gatePlan.replace("ui: no", "ui: yes").replace("**Done when:** the label reads right.", "**Done when:** the label reads right.\n**Hands off:** `label()` returns the text.") + `
## UI audit
- Start: \`node ui-app.js\`
- URL: http://127.0.0.1:3999
- Browser: headed
- Checks:
  - the label shows

## Frontend (Claude)
- Builds: the label component
**Covers:** A1
`);
  const claude = fakeClaude();
  const runtime = fakeCloseTools(claude);
  assert.strictEqual(step(dir, ["begin"], runtime.env).status, 0);
  assert.strictEqual(step(dir, ["phase", "1"], runtime.env).status, 0);
  assert.strictEqual(step(dir, ["verify", "1"], runtime.env).status, 0);
  const result = step(dir, ["close"], runtime.env);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.deepStrictEqual(claude.calls().map((call) => call.name), ["alignment"]);
  assert.ok(!fs.existsSync(path.join(dir, ".codex/verify/fix-label/final-ui")));
  assert.ok(!fs.existsSync(path.join(dir, ".codex/verify/fix-label/final-ui-audit.md")));
  assert.strictEqual(fs.readFileSync(runtime.graphCalls, "utf8"), "update .\n");
  const waited = step(dir, ["wait", "--since", new Date(Date.now() - 10 * 60 * 1000).toISOString(), "--timeout", "5"]);
  assert.strictEqual(waited.status, 0, waited.stdout + waited.stderr);
  assert.match(waited.stdout, /then build the frontend \(## Frontend \(Claude\)\) and audit it with Playwright/);
});

// ---- end to end: one whole task against the fake agents ----

test("end to end: install, check, handoff, two backend phases, close and wait, leaving the frontend to Claude", () => {
  const dir = gitRepo();
  write(dir, "app.txt", "tracked\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  assert.strictEqual(install(dir).status, 0);
  write(dir, ".codex/verify.json", JSON.stringify({ checks: [] }));

  const phase = (n, title, covers, extra) => `## Phase ${n}: ${title}
**Scope:** src/p${n}.js
**Steps:**
1. Build it.
**Covers:** ${covers}
**Done when:** it works.
${extra}**Gate (must pass):**
- \`node --version\`
`;
  write(dir, ".codex/plans/e2e-task.md", `---
task: e2e-task
risk: normal
review: none
ui: yes
---

# End to end

## Acceptance
- A1: the API answers
- A2: the page shows it

## UI audit
- Start: \`node ui-app.js\`
- URL: http://127.0.0.1:3999
- Viewports: 375, 1280
- Browser: headed
- Checks:
  - the page shows the count

## Frontend (Claude)
- Builds: the count page
**Covers:** A2

${phase(1, "API", "A1", "**Hands off:** the endpoint exists.\n")}
${phase(2, "Contract", "A1", "**Hands off:** \`getCount()\` in src/p1.js returns a number.\n")}`);

  const claude = fakeClaude();
  const runtime = fakeCloseTools(claude);
  const codex = fakeCodex({ threads: [liveThread(liveId, dir)] });
  const env = { ...runtime.env, PATH: `${codex.env.PATH.split(path.delimiter)[0]}${path.delimiter}${runtime.env.PATH}` };
  const plan = ".codex/plans/e2e-task.md";
  const run = (...args) => autopilot(dir, [args[0], plan, ...args.slice(1)], env);
  const ok = (result) => assert.strictEqual(result.status, 0, result.stdout + result.stderr);

  ok(run("check"));
  ok(run("handoff"));
  assert.match(fs.readFileSync(codex.argsFile, "utf8"), new RegExp(`queue --thread ${liveId} --message "?Execute \\.codex/plans/e2e-task\\.md`));

  ok(run("begin"));
  ok(run("phase", "1"));
  write(dir, "src/p1.js", "exports.getCount = () => 1;\n");
  ok(run("verify", "1"));
  ok(run("phase", "2"));
  write(dir, "src/p2.js", "exports.contract = true;\n");
  ok(run("verify", "2"));
  ok(run("close"));
  const waited = run("wait", "--timeout", "30");
  ok(waited);
  assert.match(waited.stdout, /Run e2e-task: DONE/);
  assert.match(waited.stdout, /Phase 1 \(API\): PASS/);
  assert.match(waited.stdout, /Phase 2 \(Contract\): PASS/);
  assert.match(waited.stdout, /build the frontend/);

  // Only app files changed; every workflow file stays local and tracked files are untouched.
  const status = git(dir, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean);
  assert.deepStrictEqual(status.sort(), ["?? src/p1.js", "?? src/p2.js"]);
  assert.strictEqual(spawnSync("git", ["diff", "--quiet"], { cwd: dir }).status, 0);

  // Per-task reports, nothing global, and no UI step from the scripts.
  const reports = path.join(dir, ".codex", "verify", "e2e-task");
  for (const file of ["phase-1.alignment.md", "phase-2.alignment.md", "phase-1.checks.log", "state.json"]) assert.ok(fs.existsSync(path.join(reports, file)), file);
  assert.ok(!fs.existsSync(path.join(reports, "final-ui-audit.md")), "Claude writes the UI audit, not a script");
  assert.ok(!fs.existsSync(path.join(dir, ".codex", "verify", "alignment.md")));
  assert.ok(!fs.existsSync(path.join(dir, ".codex", "verify", "state.json")));

  // Senior-dev/QA lens, frontend out of scope for Codex, no headless UI call, run owner.
  assert.deepStrictEqual(claude.calls().map((call) => call.name), ["alignment", "alignment"]);
  assert.match(claude.calls()[0].prompt, /MUST FIX/);
  const final = JSON.parse(read(dir, ".codex/autopilot/status.json"));
  assert.strictEqual(final.state, "done");
  assert.match(final.owner, /test@example\.com/);
  assert.strictEqual(fs.readFileSync(runtime.graphCalls, "utf8"), "update .\n");
});
