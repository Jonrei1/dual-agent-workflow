"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const installer = path.join(__dirname, "..", "skills", "claude-codex-workflow", "scripts", "install.js");
const plain = ["--project-only", "--skip-graphify"];
const pluginVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;

function installerRun(cwd, args, env = {}) {
  return spawnSync(process.execPath, [installer, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-sync-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  assert.strictEqual(installerRun(dir, plain).status, 0);
  return dir;
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const git = (dir, ...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
const gitStatus = (dir) => git(dir, "status", "--porcelain").stdout.trim();

function editManifest(dir, change) {
  const file = path.join(dir, ".codex", "workflow-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  change(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest));
}

function commitAll(dir, ...files) {
  git(dir, "add", "-f", ...files);
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "tracked");
}

test("install records the owned scripts in a manifest at the plugin's version", () => {
  const dir = tempProject();
  const manifest = JSON.parse(read(dir, ".codex/workflow-manifest.json"));
  assert.strictEqual(manifest.version, pluginVersion);
  for (const file of [".codex/autopilot.js", ".codex/hooks/claude-verify.js", ".codex/hooks/workflow-lib.js", ".codex/workflow/CODEX.md"]) assert.ok(manifest.files.includes(file), file);
});

test("sync replaces a stale autopilot, removes dropped scripts and updates the workflow section", () => {
  const dir = tempProject();
  editManifest(dir, (manifest) => {
    manifest.version = "1.0.0";
    manifest.files.push(".codex/old-script.js");
  });
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

test("notes written below the workflow section's end marker survive updates", () => {
  const dir = tempProject();
  const file = path.join(dir, "CLAUDE.local.md");
  fs.writeFileSync(file, `# My notes first\n\n${read(dir, "CLAUDE.local.md").replace("## Workflow", "## Workflow\nSTALE LINE")}\n## My own section\nkeep me\n\n### Deep note\nkeep me too\n`);
  editManifest(dir, (manifest) => (manifest.version = "1.0.0"));
  installerRun(dir, ["--sync"]);
  const text = read(dir, "CLAUDE.local.md");
  assert.doesNotMatch(text, /STALE LINE/);
  assert.match(text, /^# My notes first/);
  assert.match(text, /## My own section\nkeep me\n\n### Deep note\nkeep me too\n$/);
  assert.strictEqual(text.match(/^## Workflow$/gm).length, 1);
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, "");
});

test("a pre-v4 section without an end marker is replaced up to the next level-2 heading", () => {
  const dir = tempProject();
  const file = path.join(dir, "CLAUDE.local.md");
  fs.writeFileSync(file, "## Workflow\nold text\n### Roles\nold roles\n\n## Mine\nkeep\n");
  installerRun(dir, ["--sync"]);
  const text = read(dir, "CLAUDE.local.md");
  assert.doesNotMatch(text, /old text|old roles/);
  assert.match(text, /dual-agent-workflow:end -->\n\n## Mine\nkeep\n$/);
});

test("sync is silent when current, ignores other projects, and never downgrades", () => {
  const dir = tempProject();
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, "");

  editManifest(dir, (manifest) => (manifest.version = "99.0.0"));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// newer\n");
  assert.strictEqual(installerRun(dir, ["--sync"]).stdout, "");
  assert.strictEqual(read(dir, ".codex/autopilot.js"), "// newer\n");

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-other-"));
  spawnSync("git", ["init", "-q"], { cwd: other });
  assert.strictEqual(installerRun(other, ["--sync"]).stdout, "");
  assert.ok(!fs.existsSync(path.join(other, ".codex")));
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
  assert.strictEqual(gitStatus(dir), "");
});

// ---- upgrading from v3 and v2 ----

test("sync retires the caveman skill: an unedited copy is removed, an edited one is kept", () => {
  const dir = tempProject();
  const claudeSkill = path.join(dir, ".claude", "skills", "caveman", "SKILL.md");
  const agentSkill = path.join(dir, ".agents", "skills", "caveman", "SKILL.md");
  for (const file of [claudeSkill, agentSkill]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(claudeSkill, "OLD BUNDLED");
  fs.writeFileSync(agentSkill, "MY OWN EDITS");
  editManifest(dir, (manifest) => {
    manifest.version = "3.1.0";
    manifest.managed = { ".claude/skills/caveman/SKILL.md": sha("OLD BUNDLED") };
  });
  const result = installerRun(dir, ["--sync"]);
  assert.ok(!fs.existsSync(claudeSkill), "the unedited copy goes");
  assert.ok(!fs.existsSync(path.dirname(claudeSkill)), "and its empty folder");
  assert.strictEqual(fs.readFileSync(agentSkill, "utf8"), "MY OWN EDITS");
  assert.match(result.stdout, /dual-agent-workflow v/);
});

test("an old plan template without a recorded hash is backed up, then updated", () => {
  const dir = tempProject();
  const template = path.join(dir, ".codex", "plans", "_template.md");
  fs.writeFileSync(template, "v2 template with **UI audit:**\n");
  editManifest(dir, (manifest) => {
    manifest.version = "2.0.0";
    delete manifest.managed[".codex/plans/_template.md"];
  });
  installerRun(dir, ["--sync"]);
  assert.match(read(dir, ".codex/plans/_template.md"), /Browser:/);
  assert.strictEqual(read(dir, ".codex/plans/_template.previous.md"), "v2 template with **UI audit:**\n");
});

test("a plan template you edited after install is kept", () => {
  const dir = tempProject();
  fs.appendFileSync(path.join(dir, ".codex", "plans", "_template.md"), "# mine\n");
  editManifest(dir, (manifest) => (manifest.version = "3.1.0"));
  installerRun(dir, ["--sync"]);
  assert.match(read(dir, ".codex/plans/_template.md"), /# mine/);
  assert.ok(!fs.existsSync(path.join(dir, ".codex", "plans", "_template.previous.md")));
});

test("a v2-era setup without a manifest is upgraded by setup: Stop hook removed, scripts replaced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-v2-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".codex", "plans"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// v2 autopilot\n");
  fs.writeFileSync(path.join(dir, ".codex", "plans", "_template.md"), "v2 template\n");
  fs.writeFileSync(path.join(dir, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .codex/hooks/claude-verify.js" }] }] } }));
  fs.writeFileSync(path.join(dir, "CLAUDE.local.md"), "## Workflow\nv2 rules with the Codex Stop hook\n");
  const codexHome = path.join(dir, "..", `${path.basename(dir)}-codex-home`);
  const result = installerRun(dir, plain, { CODEX_HOME: codexHome });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(read(dir, ".codex/autopilot.js"), /v2 autopilot/);
  assert.ok(!JSON.parse(read(dir, ".codex/hooks.json")).hooks.Stop);
  assert.doesNotMatch(read(dir, "CLAUDE.local.md"), /v2 rules/);
  assert.match(read(dir, ".codex/plans/_template.md"), /Browser:/);
  assert.strictEqual(read(dir, ".codex/plans/_template.previous.md"), "v2 template\n");
  assert.strictEqual(JSON.parse(read(dir, ".codex/workflow-manifest.json")).version, pluginVersion);
  assert.strictEqual(gitStatus(dir), "");
});

test("a project that used the removed shared layout gets a notice and no rewrite", () => {
  const dir = tempProject();
  editManifest(dir, (manifest) => Object.assign(manifest, { version: "3.1.0", shared: true }));
  fs.writeFileSync(path.join(dir, ".codex", "autopilot.js"), "// STALE\n");
  const result = installerRun(dir, ["--sync"]);
  assert.match(result.stdout, /shared layout, which is no longer supported/);
  assert.match(result.stdout, /setup --project-only/);
  assert.strictEqual(read(dir, ".codex/autopilot.js"), "// STALE\n");
});

test("setup on a former shared-layout project moves to the local layout and points at the tracked sections", () => {
  const dir = tempProject();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "## Workflow\nrules that call autopilot.js\n");
  commitAll(dir, "CLAUDE.md");
  editManifest(dir, (manifest) => Object.assign(manifest, { version: "3.1.0", shared: true }));
  const result = installerRun(dir, plain);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /CLAUDE\.md \(old workflow\)/);
  assert.strictEqual(read(dir, "CLAUDE.md"), "## Workflow\nrules that call autopilot.js\n");
  assert.strictEqual(JSON.parse(read(dir, ".codex/workflow-manifest.json")).shared, undefined);
  assert.strictEqual(gitStatus(dir), "");
});

test("sync never touches the Impeccable plugin cache or Codex hooks outside the project", () => {
  const dir = tempProject();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-codex-home-"));
  const hooks = path.join(codexHome, "plugins", "cache", "impeccable", "impeccable", "4.5.2", "hooks", "hooks.json");
  fs.mkdirSync(path.dirname(hooks), { recursive: true });
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: '[ ! -f ".agents/skills/impeccable/scripts/impeccable" ] || x hook' }] }] } });
  fs.writeFileSync(hooks, original);
  editManifest(dir, (manifest) => (manifest.version = "3.1.0"));
  installerRun(dir, ["--sync"], { CODEX_HOME: codexHome });
  assert.strictEqual(fs.readFileSync(hooks, "utf8"), original);
  assert.deepStrictEqual(fs.readdirSync(codexHome), ["plugins"]);
});

// ---- worktrees ----

test("sync sets up a linked git worktree from the main worktree's manifest", () => {
  const dir = tempProject();
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  assert.strictEqual(git(dir, "worktree", "add", "-q", wt, "-b", "feature").status, 0);
  assert.ok(!fs.existsSync(path.join(wt, ".codex")), "a new worktree starts without the ignored workflow files");

  const result = installerRun(wt, ["--sync"]);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(wt, ".codex", "autopilot.js")));
  assert.match(fs.readFileSync(path.join(wt, "CLAUDE.local.md"), "utf8"), /^## Workflow/m);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(wt, ".codex", "workflow-manifest.json"), "utf8")).version, pluginVersion);
  assert.strictEqual(gitStatus(wt), "");
  assert.strictEqual(installerRun(wt, ["--sync"]).stdout, "");
});

test("a worktree of a repo that doesn't use the workflow is left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-plainwt-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  git(dir, "worktree", "add", "-q", wt, "-b", "feature");
  assert.strictEqual(installerRun(wt, ["--sync"]).stdout, "");
  assert.ok(!fs.existsSync(path.join(wt, ".codex")));
});

// ---- safety ----

test("a planted manifest can only remove plugin script paths under .codex/", () => {
  const dir = tempProject();
  const victims = [".env", "src/app.js", ".codex/plans/my-plan.md", ".codex/verify.json", ".codex/hooks/../../.env.local", "C:evil.js", ".codex/plans/../../notes.js"];
  for (const file of [".env", ".env.local", "src/app.js", ".codex/plans/my-plan.md", ".codex/verify.json", "notes.js"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "keep\n");
  }
  fs.writeFileSync(path.join(dir, ".codex", "old-helper.js"), "// dropped\n");
  editManifest(dir, (manifest) => manifest.files.push(...victims, ".git/config", ".codex/old-helper.js"));

  assert.strictEqual(installerRun(dir, ["--sync"]).status, 0);
  for (const file of [".env", ".env.local", "src/app.js", ".codex/plans/my-plan.md", ".codex/verify.json", "notes.js", ".git/config"]) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} must survive`);
  }
  assert.ok(!fs.existsSync(path.join(dir, ".codex", "old-helper.js")));
});

test("a committed manifest isn't trusted: sync removes nothing", () => {
  const dir = tempProject();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Team rules\n");
  fs.writeFileSync(path.join(dir, ".codex", "old-helper.js"), "// would be removed\n");
  editManifest(dir, (manifest) => {
    manifest.version = "1.0.0";
    manifest.files.push(".codex/old-helper.js");
  });
  commitAll(dir, "CLAUDE.md", ".codex/workflow-manifest.json");

  const result = installerRun(dir, ["--sync"]);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /committed to git, so it isn't trusted/);
  assert.ok(fs.existsSync(path.join(dir, ".codex", "old-helper.js")));
  assert.strictEqual(read(dir, "CLAUDE.md"), "# Team rules\n");
  assert.strictEqual(gitStatus(dir).split("\n").filter((line) => !line.endsWith("old-helper.js")).join(""), "");
});

test("new exclude entries join the existing workflow block instead of adding a second heading", () => {
  const dir = tempProject();
  const exclude = path.join(dir, ".git", "info", "exclude");
  const original = fs.readFileSync(exclude, "utf8");
  fs.writeFileSync(exclude, original.replace(".codex/tasks/\n", "") + "# mine\nlocal-notes/\n");
  installerRun(dir, ["--sync"]);
  const updated = fs.readFileSync(exclude, "utf8");
  assert.strictEqual(updated.match(/^# Claude \+ Codex workflow \(local only\)$/gm).length, 1);
  assert.match(updated, /\.codex\/tasks\/\n[\s\S]*# mine\nlocal-notes\/\n$/);
});

test("setup refuses to downgrade a project set up by a newer plugin", () => {
  const dir = tempProject();
  editManifest(dir, (manifest) => (manifest.version = "99.0.0"));
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

test("graphify scope: user by default, global when asked", () => {
  const dir = tempProject();
  const run = (extra) =>
    spawnSync(process.execPath, [installer, "--tools-only", "--dry-run", "--skip-playwright", "--skip-skills", ...extra], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).stdout;
  const out = run([]);
  // graphify may already be installed on this machine; the scope line only shows when it isn't.
  if (/graphify install scope/.test(out)) {
    assert.match(out, /graphify install scope: user/);
    assert.match(run(["--graphify-scope=global"]), /graphify install scope: global/);
  }
});
