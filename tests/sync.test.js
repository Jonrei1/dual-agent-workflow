"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const installer = path.join(__dirname, "..", "skills", "claude-codex-workflow", "scripts", "install.js");
const plain = ["--project-only", "--skip-graphify", "--skip-impeccable"];

function installerRun(cwd, args) {
  return spawnSync(process.execPath, [installer, ...args], { cwd, encoding: "utf8" });
}

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-sync-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  assert.strictEqual(installerRun(dir, plain).status, 0);
  return dir;
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

test("install records the owned scripts in a manifest", () => {
  const dir = tempProject();
  const manifest = JSON.parse(read(dir, ".codex/workflow-manifest.json"));
  for (const file of [".codex/autopilot.js", ".codex/hooks/claude-verify.js", ".codex/hooks/workflow-lib.js", ".codex/workflow/CODEX.md"]) assert.ok(manifest.files.includes(file), file);
});

test("sync replaces a stale autopilot, removes dropped scripts and updates the workflow sections", () => {
  const dir = tempProject();
  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.version = "1.0.0";
  manifest.files.push(".codex/old-script.js");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// STALE-MARKER\n");
  fs.writeFileSync(path.join(dir, ".codex", "old-script.js"), "// dropped\n");
  fs.writeFileSync(path.join(dir, ".codex", "user-script.js"), "// not ours\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.local.md"), read(dir, "CLAUDE.local.md").replace("## Workflow", "## Workflow\nSTALE LINE"));

  const result = installerRun(dir, ["--sync"]);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /updated/);
  assert.doesNotMatch(read(dir, ".codex/autopilot.js"), /STALE-MARKER/);
  assert.ok(!fs.existsSync(path.join(dir, ".codex", "old-script.js")));
  assert.ok(fs.existsSync(path.join(dir, ".codex", "user-script.js")));
  assert.doesNotMatch(read(dir, "CLAUDE.local.md"), /STALE LINE/);
  });

test("sync is silent when current, ignores other projects, and never downgrades", () => {
  const dir = tempProject();
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, "");

  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.version = "99.0.0";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// newer\n");
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, "");
  assert.strictEqual(read(dir, ".codex/autopilot.js"), "// newer\n");

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-other-"));
  spawnSync("git", ["init", "-q"], { cwd: other });
  assert.strictEqual(installerRun(other, ["--sync"]).stdout, "");
  assert.ok(!fs.existsSync(path.join(other, ".codex")));
});

test("customized caveman skill is kept; an untouched older copy is refreshed", () => {
  const dir = tempProject();
  const claudeSkill = path.join(dir, ".claude", "skills", "caveman", "SKILL.md");
  fs.appendFileSync(claudeSkill, "# mine\n");
  installerRun(dir, ["--sync"]);
  installerRun(dir, ["--sync"]);
  assert.match(fs.readFileSync(claudeSkill, "utf8"), /# mine/);

  const agentSkill = path.join(dir, ".agents", "skills", "caveman", "SKILL.md");
  fs.writeFileSync(agentSkill, "OLD BUNDLED");
  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.managed[".agents/skills/caveman/SKILL.md"] = require("node:crypto").createHash("sha256").update("OLD BUNDLED").digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  installerRun(dir, ["--sync"]);
  assert.notStrictEqual(fs.readFileSync(agentSkill, "utf8"), "OLD BUNDLED");
});

test("a project without a manifest gets a hint, not a rewrite", () => {
  const dir = tempProject();
  fs.rmSync(path.join(dir, ".codex", "workflow-manifest.json"));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// legacy\n");
  const result = installerRun(dir, ["--sync"]);
  assert.match(result.stdout, /setup --project-only/);
  assert.strictEqual(read(dir, ".codex/autopilot.js"), "// legacy\n");
});

test("setup leaves git status clean, including the manifest", () => {
  const dir = tempProject();
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout;
  assert.strictEqual(status.trim(), "");
});

const BROKEN_WINDOWS = 'if exist ".agents/skills/impeccable/scripts/impeccable.cmd" (".agents/skills/impeccable/scripts/impeccable.cmd" hook & exit /b)';

function impeccableHooks() {
  const hook = (timeout) => ({
    type: "command",
    command: '[ ! -f ".agents/skills/impeccable/scripts/impeccable" ] || ".agents/skills/impeccable/scripts/impeccable" hook',
    commandWindows: BROKEN_WINDOWS,
    timeout,
  });
  return { hooks: { Stop: [{ hooks: [hook(30)] }], PostToolUse: [{ matcher: "Edit|Write", hooks: [hook(5)] }] } };
}

function commitAll(dir, ...files) {
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("add", ...files);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "tracked");
}

const gitStatus = (dir) => spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout.trim();

test("sync fixes Impeccable's broken Windows hook in an untracked hooks.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-imp-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const file = path.join(dir, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(impeccableHooks(), null, 2));

  const result = installerRun(dir, ["--sync"]);
  assert.match(result.stdout, /fixed 2 Impeccable Windows hook/);
  const fixed = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const hook of [fixed.hooks.Stop[0].hooks[0], fixed.hooks.PostToolUse[0].hooks[0]]) {
    assert.match(hook.commandWindows, /^cmd\.exe \/d \/c "if exist /);
    assert.doesNotMatch(hook.commandWindows, /exit \/b/);
    assert.match(hook.command, /^\[ ! -f/); // the POSIX command is untouched
  }
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, ""); // nothing left to repair
});

test("a tracked hooks.json with the broken Impeccable hook is never edited, only reported with the fix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-imp-tracked-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const file = path.join(dir, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify(impeccableHooks(), null, 4).replace(/\n/g, "\r\n");
  fs.writeFileSync(file, original);
  commitAll(dir, ".codex/hooks.json");

  const result = installerRun(dir, ["--sync"]);
  assert.match(result.stdout, /tracked by git and has 2 Impeccable Windows hook\(s\).*left unchanged/);
  assert.match(result.stdout, /cmd\.exe \/d \/c/); // the exact fix to commit
  assert.strictEqual(fs.readFileSync(file, "utf8"), original);
  assert.strictEqual(gitStatus(dir), "");
});

test("a planted manifest can only remove plugin script paths under .codex/", () => {
  const dir = tempProject();
  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const victims = [".env", "src/app.js", ".codex/plans/my-plan.md", ".codex/verify.json", ".codex/hooks/../../.env.local", "C:evil.js", ".codex/plans/../../notes.js"];
  for (const file of [".env", ".env.local", "src/app.js", ".codex/plans/my-plan.md", ".codex/verify.json", "notes.js"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "keep\n");
  }
  fs.writeFileSync(path.join(dir, ".codex", "old-helper.js"), "// dropped\n");
  manifest.files.push(...victims, ".git/config", ".codex/old-helper.js");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));

  assert.strictEqual(installerRun(dir, ["--sync"]).status, 0);
  for (const file of [".env", ".env.local", "src/app.js", ".codex/plans/my-plan.md", ".codex/verify.json", "notes.js", ".git/config"]) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} must survive`);
  }
  assert.ok(!fs.existsSync(path.join(dir, ".codex", "old-helper.js")));
});

test("a committed manifest isn't trusted: sync neither removes files nor switches to the shared layout", () => {
  const dir = tempProject();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Team rules\n");
  fs.writeFileSync(path.join(dir, ".codex", "old-helper.js"), "// would be removed\n");
  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  Object.assign(manifest, { version: "1.0.0", shared: true });
  manifest.files.push(".codex/old-helper.js");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  spawnSync("git", ["add", "-f", "CLAUDE.md", ".codex/workflow-manifest.json"], { cwd: dir });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "planted"], { cwd: dir });

  const result = installerRun(dir, ["--sync"]);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /committed to git, so it isn't trusted/);
  assert.ok(fs.existsSync(path.join(dir, ".codex", "old-helper.js")));
  assert.strictEqual(read(dir, "CLAUDE.md"), "# Team rules\n");
  assert.strictEqual(gitStatus(dir).split("\n").filter((line) => !line.endsWith("old-helper.js")).join(""), "");
});

test("sync never upgrades a shared-layout project; it points to setup --shared", () => {
  const dir = tempProject();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Team rules\n");
  commitAll(dir, "CLAUDE.md");
  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  Object.assign(manifest, { version: "1.0.0", shared: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// STALE\n");

  const result = installerRun(dir, ["--sync"]);
  assert.match(result.stdout, /shared layout; run \/dual-agent-workflow:setup --project-only --shared/);
  assert.strictEqual(read(dir, ".codex/autopilot.js"), "// STALE\n");
  assert.strictEqual(read(dir, "CLAUDE.md"), "# Team rules\n");
});

test("new exclude entries join the existing workflow block instead of adding a second heading", () => {
  const dir = tempProject();
  const exclude = path.join(dir, ".git", "info", "exclude");
  const original = fs.readFileSync(exclude, "utf8");
  fs.writeFileSync(exclude, original.replace(".impeccable/\n", "").replace(".agents/skills/impeccable/\n", "") + "# mine\nlocal-notes/\n");
  installerRun(dir, ["--sync"]);
  const updated = fs.readFileSync(exclude, "utf8");
  assert.strictEqual(updated.match(/^# Claude \+ Codex workflow \(local only\)$/gm).length, 1);
  assert.match(updated, /\.impeccable\/\n[\s\S]*# mine\nlocal-notes\/\n$/);
});

test("setup refuses to downgrade a project set up by a newer plugin", () => {
  const dir = tempProject();
  const manifestFile = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.version = "99.0.0";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// newer\n");
  const result = installerRun(dir, plain);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /newer than this plugin/);
  assert.strictEqual(read(dir, ".codex/autopilot.js"), "// newer\n");
});

test("JSON files saved with a UTF-8 BOM (Windows PowerShell) still merge", () => {
  const dir = tempProject();
  const settings = path.join(dir, ".claude", "settings.local.json");
  fs.writeFileSync(settings, `﻿${JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }, null, 2)}`);
  const result = installerRun(dir, ["--sync"]);
  assert.doesNotMatch(result.stdout, /isn't valid JSON/);
  const merged = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepStrictEqual(merged.permissions.allow, ["Bash(npm test)"]);
  assert.ok(merged.hooks.PostToolUse.some((group) => group.matcher === "ExitPlanMode"));
});

function impeccablePlugin(codexHome, launcherBody) {
  const root = path.join(codexHome, "plugins", "cache", "impeccable", "impeccable", "4.5.2");
  const upstream = '[ ! -f "${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts/impeccable" ] || "${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts/impeccable" hook';
  const hook = (timeout) => ({ type: "command", command: upstream, timeout });
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook(5)] }], PostToolUse: [{ matcher: "Edit|Write", hooks: [hook(5)] }], Stop: [{ hooks: [hook(30)] }] } }, null, 2));
  const scripts = path.join(root, "skills", "impeccable", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "impeccable.cmd"), launcherBody);
  return root;
}

test.skipIf(process.platform !== "win32")("the Impeccable Codex plugin's POSIX-only hooks are rewritten to a Node launcher that never fails on setup problems", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-codex-home-"));
  const root = impeccablePlugin(codexHome, "@echo off\r\nmore >nul\r\necho ran %1\r\nexit /b 0\r\n");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-nogit-"));
  const env = { ...process.env, CODEX_HOME: codexHome };
  const sync = () => spawnSync(process.execPath, [installer, "--sync"], { cwd: outside, encoding: "utf8", env });

  assert.match(sync().stdout, /3 Impeccable plugin hook\(s\) now run through Node/);
  const config = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
  const commands = Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
  assert.strictEqual(new Set(commands.map((hook) => hook.command)).size, 1);
  assert.match(commands[0].command, /^node ".*impeccable-hook\.js"$/);
  assert.ok(commands.every((hook) => hook.commandWindows === undefined && hook.timeout));
  assert.strictEqual(sync().stdout, ""); // idempotent

  for (const shell of [["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", commands[0].command], ["cmd.exe", "/d", "/s", "/c", commands[0].command]]) {
    const result = spawnSync(shell[0], shell.slice(1), { cwd: outside, input: '{"hook_event_name":"Stop"}', encoding: "utf8", windowsHide: true, windowsVerbatimArguments: shell[0] === "cmd.exe" });
    assert.strictEqual(result.status, 0, `${shell[0]}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ran hook/, shell[0]);
  }

  // An engine that can't be found (the launcher's exit 127) is a setup problem, not a hook failure.
  fs.writeFileSync(path.join(root, "skills", "impeccable", "scripts", "impeccable.cmd"), "@echo off\r\nexit /b 127\r\n");
  const missing = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", commands[0].command], { cwd: outside, encoding: "utf8", windowsHide: true });
  assert.strictEqual(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /Impeccable hook skipped/);

  // A real design finding (any other exit code) still reaches Codex.
  fs.writeFileSync(path.join(root, "skills", "impeccable", "scripts", "impeccable.cmd"), "@echo off\r\nexit /b 2\r\n");
  assert.strictEqual(spawnSync(process.execPath, [path.join(root, "hooks", "impeccable-hook.js")], { cwd: outside, windowsHide: true }).status, 2);
});

test.skipIf(process.platform !== "win32")("the repaired Impeccable command runs under PowerShell and cmd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-imp-run-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const script = path.join(dir, ".agents", "skills", "impeccable", "scripts", "impeccable.cmd");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "@echo off\r\necho ran %1\r\nexit /b 0\r\n");
  const file = path.join(dir, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(impeccableHooks()));
  installerRun(dir, ["--sync"]);
  const command = JSON.parse(fs.readFileSync(file, "utf8")).hooks.Stop[0].hooks[0].commandWindows;
  for (const shell of [["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], ["cmd.exe", "/d", "/s", "/c", command]]) {
    const result = spawnSync(shell[0], shell.slice(1), { cwd: dir, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: shell[0] === "cmd.exe" });
    assert.strictEqual(result.status, 0, `${shell[0]}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ran hook/, shell[0]);
  }
});
