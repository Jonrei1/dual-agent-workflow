#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// One-command setup for the Claude + Codex workflow. Run it from the project root:
//
//   node <plugin>/skills/dual-agent-workflow/scripts/install.js [flags]
//   npx github:Jonrei1/dual-agent-workflow [flags]
//   /dual-agent-workflow:setup [flags]          (in Claude Code)
//
// Mode: both agents (default), or one with --claude-only / --codex-only. The mode is kept in
// .codex/workflow-manifest.json, so sync and later runs keep it until the other flag is given.
//
// 1. Tools: checks node, git, Claude Code and/or Codex CLI, Playwright, graphify (and its skill
//    for each agent) and the agent plugins (ponytail, taste-skill, caveman), and installs the
//    missing ones (global installs ask first unless --yes is given). Playwright MCP is
//    registered for the agent that builds the frontend (Claude, or Codex when it works alone):
//    `playwright` (headless) and `playwright-headed` (a visible window).
// 2. Project, local only: copies the workflow scripts into .codex/, writes the rules for the
//    agents in use (CLAUDE.local.md section, .codex/workflow/CODEX.md), merges the ExitPlanMode
//    and graphify hooks into .claude/settings.local.json and the Codex hooks into
//    .codex/hooks.json, and hides all of it through .git/info/exclude. Then it prints the
//    detected checks.
//
// It never modifies a file git tracks, so setting up the workflow leaves `git status` clean
// and can't cause merge conflicts for teammates: every developer sets up their own clone. The
// scripts under .codex/ belong to the workflow and are updated on every run, so re-running the
// installer upgrades a project. Scripts an earlier version installed and this one no longer
// ships are removed (listed in the untracked .codex/workflow-manifest.json; only .codex/ script
// paths are ever removed). It never commits.
//
// The plugin also runs `install.js --sync` from a SessionStart hook, so a plugin update reaches
// every project that already uses the workflow (and its git worktrees) without re-running setup.
// Sync writes only inside the project.
//
// Flags:
//   --sync                      quiet, files-only upgrade of an already-set-up project (used by the
//                               plugin's SessionStart hook): no tools, prompts or graphify
//   --yes                       approve missing global tools, Playwright setup and the agent skills
//   --dual | --claude-only | --codex-only  explicitly select both agents or one agent
//   --tools-only | --project-only
//   --dry-run                   print what would happen, change nothing
//   --graphify-scope=<s>        user (default) or global; asked on a terminal when graphify is missing
//   --skip-graphify | --skip-playwright | --skip-skills
//   --root <dir>                project directory (default: current directory)

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");
const { setupPlaywright } = require("./playwright");
const { setupSkills } = require("./skills");
const lib = require("../templates/codex/hooks/workflow-lib");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flagValue = (name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : "";
};

const isWindows = process.platform === "win32";
const dryRun = flag("--dry-run");
const sync = flag("--sync");
const modeFlag = flag("--dual") ? "dual" : flag("--claude-only") ? "claude" : flag("--codex-only") ? "codex" : "";
// The agents a mode uses.
const agents = (mode) => (mode === "dual" ? ["claude", "codex"] : [mode]);
let projectDir = "";
const templates = path.join(__dirname, "..", "templates");
const pluginRoot = path.join(__dirname, "..", "..", "..");
const pluginVersion = readJson(path.join(pluginRoot, "package.json"))?.version || readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"))?.version || "0.0.0";
const MANIFEST = ".codex/workflow-manifest.json";
// Scripts the workflow owns: always the plugin's version, and removed once a later version drops them.
const OWNED = ["codex/hooks/claude-verify.js", "codex/hooks/workflow-lib.js", "codex/hooks/claude-plan-gate.js", "codex/hooks/claude-completion-gate.js", "codex/autopilot.js"];
const CODEX_RULES = ".codex/workflow/CODEX.md";
// Files the user may customize: created when missing, refreshed only while still unmodified.
const MANAGED = [["plans/_template.md", ".codex/plans/_template.md"]];
// Files an earlier version installed and this one dropped. An unedited copy (its hash matches
// what a plugin version wrote) is removed; an edited one is kept and reported.
const RETIRED = [
  { file: ".claude/skills/caveman/SKILL.md", sha: "9a91f3b38aa3ee25df2615d7d8cb4ddc1c2622c7d09ab450ec27e5bd9785ff61" },
  { file: ".agents/skills/caveman/SKILL.md", sha: "9a91f3b38aa3ee25df2615d7d8cb4ddc1c2622c7d09ab450ec27e5bd9785ff61" },
];
// The end of the CLAUDE.local.md section the workflow owns; notes below it are never touched.
const SECTION_END = "<!-- dual-agent-workflow:end -->";
const results = [];
const changed = [];
const notices = [];

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => String(v).split(".").map((n) => parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

const sha = (text) => require("node:crypto").createHash("sha256").update(text).digest("hex");

function record(step, ok, note = "") {
  results.push({ step, ok, note });
  if (sync) return;
  const mark = ok === true ? "ok  " : ok === false ? "FAIL" : "--  ";
  console.log(`  [${mark}] ${step}${note ? `: ${note}` : ""}`);
}

function quote(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// Windows needs a shell to run npm/npx/claude/codex (.cmd shims).
function run(command, commandArgs = [], options = {}) {
  return spawnSync(isWindows ? [command, ...commandArgs].map(quote).join(" ") : command, isWindows ? [] : commandArgs, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    shell: isWindows,
    windowsHide: true,
    stdio: options.inherit ? "inherit" : "pipe",
    timeout: options.timeout || 10 * 60 * 1000,
  });
}

function has(command) {
  const result = run(command, ["--version"], { timeout: 60 * 1000 });
  return result.status === 0 ? (result.stdout || "").trim().split("\n")[0] : "";
}

// Asks on the terminal, whatever flags were given. False when there's no terminal to ask on.
async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// --yes approves the machine tools and plugins.
async function confirm(question) {
  return flag("--yes") || ask(question);
}

// Where graphify goes: "user" (default) or "global". --graphify-scope=<user|global> decides;
// otherwise a terminal is asked, and --yes, --dry-run or no terminal mean "user".
async function graphifyScope() {
  const given = flagValue("--graphify-scope").toLowerCase();
  if (given === "user" || given === "global") return given;
  if (dryRun || flag("--yes") || !process.stdin.isTTY) return "user";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) =>
    rl.question("Install graphify for your user only, or globally for every user (needs admin rights)? [user/global] (default user) ", resolve),
  );
  rl.close();
  return /^g(lobal)?$/i.test(answer.trim()) ? "global" : "user";
}

// Runs an install command after asking. Returns true when it ran and succeeded.
async function install(step, command, commandArgs) {
  const line = [command, ...commandArgs].join(" ");
  if (dryRun) {
    record(step, null, `would run \`${line}\``);
    return false;
  }
  if (!(await confirm(`${step} is missing. Run \`${line}\`?`))) {
    record(step, false, `missing; install with \`${line}\` (or re-run with --yes)`);
    return false;
  }
  console.log(`  $ ${line}`);
  const result = run(command, commandArgs, { inherit: true });
  return result.status === 0;
}

// graphify installs into ~/.local/bin (uv, pipx) or the Python user scripts dir, which
// may not be on this process's PATH yet.
function findGraphify() {
  if (has("graphify")) return "graphify";
  const exe = isWindows ? "graphify.exe" : "graphify";
  const candidates = [path.join(os.homedir(), ".local", "bin", exe)];
  if (isWindows && process.env.APPDATA) {
    const pythonDir = path.join(process.env.APPDATA, "Python");
    try {
      for (const version of fs.readdirSync(pythonDir)) candidates.push(path.join(pythonDir, version, "Scripts", exe));
    } catch {
      // no user Python scripts
    }
  }
  const found = candidates.find((file) => fs.existsSync(file));
  return found ? found.split(path.sep).join("/") : "";
}

// graphify's skill teaches an agent to query the graph instead of reading raw files. It is
// installed per user (graphify install --platform <agent>), not into the project.
function graphifySkillFile(client) {
  const base = client === "claude" ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") : path.join(os.homedir(), ".codex");
  return path.join(base, "skills", "graphify", "SKILL.md");
}

async function setupGraphifySkills(graphify, clients) {
  for (const client of clients) {
    const step = `graphify skill (${client})`;
    if (fs.existsSync(graphifySkillFile(client))) record(step, true, "present");
    else if (await install(step, graphify, ["install", "--platform", client])) record(step, fs.existsSync(graphifySkillFile(client)), graphifySkillFile(client));
  }
}

async function installTools(mode) {
  console.log(`\nTools (${mode === "dual" ? "Claude + Codex" : `${mode} only`})`);
  const major = Number(process.versions.node.split(".")[0]);
  record("node", major >= 18, major >= 18 ? process.version : `${process.version}; need 18 or newer`);
  const gitVersion = has("git");
  record("git", Boolean(gitVersion), gitVersion || "missing; install it with your OS package manager");

  for (const tool of [
    { step: "Claude Code", command: "claude", pkg: "@anthropic-ai/claude-code" },
    { step: "Codex CLI", command: "codex", pkg: "@openai/codex" },
  ].filter((tool) => agents(mode).includes(tool.command))) {
    let version = has(tool.command);
    if (!version && (await install(tool.step, "npm", ["install", "-g", tool.pkg]))) version = has(tool.command);
    if (version) record(tool.step, true, version);
    else if (!dryRun && !results.some((r) => r.step === tool.step)) record(tool.step, false, `\`npm install -g ${tool.pkg}\` failed`);
  }
  if (mode !== "claude" && has("codex") && !dryRun && run("codex", ["login", "status"], { timeout: 60 * 1000 }).status !== 0) {
    record("Codex login", false, "run `codex login`");
  }

  if (flag("--skip-playwright")) record("Playwright setup", null, "skipped (--skip-playwright)");
  else await setupPlaywright({ run, has, confirm, record, dryRun, client: mode === "codex" ? "codex" : "claude" });

  if (flag("--skip-skills")) record("Skills (ponytail, taste-skill, caveman)", null, "skipped (--skip-skills)");
  else await setupSkills({ run, has, confirm, record, dryRun, clients: agents(mode) });

  let graphify = findGraphify();
  if (!graphify) {
    const python = isWindows ? "python" : "python3";
    const scope = await graphifyScope();
    console.log(`  graphify install scope: ${scope}`);
    // user: into your home directory, no admin rights. global: system-wide pip, which
    // usually needs administrator/root rights and is shared by every user on the machine.
    const installers =
      scope === "global"
        ? [[python, ["-m", "pip", "install", "graphifyy"]]]
        : [
          ["uv", ["tool", "install", "graphifyy"]],
          ["pipx", ["install", "graphifyy"]],
          [python, ["-m", "pip", "install", "--user", "graphifyy"]],
        ];
    const available = installers.find(([command]) => has(command));
    if (!available) record("graphify", false, "install uv (https://docs.astral.sh/uv/) or Python, then re-run");
    else if (await install("graphify", available[0], available[1])) graphify = findGraphify();
  }
  if (graphify) {
    record("graphify", true, graphify === "graphify" ? has("graphify") : `${graphify} (not on PATH; add its folder to PATH)`);
    if (!flag("--skip-graphify")) await setupGraphifySkills(graphify, agents(mode));
  } else if (!dryRun && !results.some((r) => r.step === "graphify")) {
    record("graphify", false, "installed but not found; add ~/.local/bin to PATH and re-run");
  }

  return graphify;
}

// ---- project files ----

function gitIn(root, gitArgs) {
  return spawnSync(isWindows ? "git.exe" : "git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
}

function isTracked(root, rel) {
  return gitIn(root, ["ls-files", "--error-unmatch", "--", rel]).status === 0;
}

// A path inside the project, relative to it, or "" for a path outside (e.g. ~/.codex).
function projectRel(file) {
  if (!projectDir) return "";
  const rel = path.relative(projectDir, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : "";
}

// True when the path, or a folder on its way, is a symlink or junction: a write or delete
// through it could land outside the repo.
function throughLink(root, rel) {
  let current = root;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

// A file git tracks is never written: teammates would see the change, and two developers
// setting up the workflow would get merge conflicts. The refusal is a notice, not a failure,
// so the rest of the upgrade still completes.
function write(file, content, step, note) {
  const rel = projectRel(file);
  if (rel && isTracked(projectDir, rel)) {
    return record(step, null, "tracked by git, left unchanged (setup only writes local files)");
  }
  if (rel && throughLink(projectDir, rel)) return record(step, false, "is reached through a symlink; left unchanged");
  if (dryRun) return record(step, null, `dry run, not written (${note})`);
  // Write beside the target and rename, so a reader never sees a half-written script.
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    return record(step, false, `couldn't write: ${error.message}`);
  }
  changed.push(step);
  record(step, true, note);
}

// Deletes a file an earlier version installed. Tracked files and links are never touched.
function remove(root, rel) {
  if (isTracked(root, rel)) return record(rel, null, "stale, but tracked by git; left in place");
  if (throughLink(root, rel)) return record(rel, null, "stale, but reached through a symlink; left in place");
  if (dryRun) return record(rel, null, "dry run, stale file not removed");
  try {
    fs.rmSync(path.join(root, rel), { force: true });
  } catch (error) {
    return record(rel, false, `couldn't remove: ${error.message}`);
  }
  changed.push(`${rel} (removed)`);
  record(rel, true, "stale file from an earlier version removed");
}

// Reads a text file without a UTF-8 BOM (Windows PowerShell 5.1 writes one, and JSON.parse
// rejects it), or null when it can't be read.
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return null;
  }
}

// Workflow-owned files: always the plugin's version.
function writeOwned(root, source, to) {
  const current = readText(path.join(root, to));
  if (current === source) return record(to, true, "up to date");
  write(path.join(root, to), source, to, current === null ? "created" : "updated to the plugin's version");
}

function copyOwned(root, from, to) {
  writeOwned(root, fs.readFileSync(path.join(templates, from), "utf8"), to);
}

// Files the user may customize: created when missing, and refreshed to the plugin's version
// only while they still match what an earlier run installed (the manifest holds its hash).
// Edited files are kept.
function copyManaged(root, source, to, previous) {
  const current = readText(path.join(root, to));
  if (current === null) return write(path.join(root, to), source, to, "created");
  if (current === source) return record(to, true, "up to date");
  if (previous[to] && previous[to] === sha(current)) return write(path.join(root, to), source, to, "updated to the plugin's version");
  if (!previous[to]) {
    // Installed before the manifest tracked it (v2): keep a copy of the old file, then update.
    const backup = to.replace(/\.md$/, ".previous.md");
    if (readText(path.join(root, backup)) === null) write(path.join(root, backup), current, backup, "copy of your previous version");
    return write(path.join(root, to), source, to, "updated to the plugin's version");
  }
  record(to, true, "customized, kept");
}

// Only paths shaped like a script the plugin ships can be removed: a top-level .codex/*.js,
// .codex/hooks/*.js or .codex/workflow/*.md. A manifest naming anything else (.env, .git/config,
// a plan, a drive-relative or ".." path) is ignored, so a planted manifest can't delete files.
const STALE_PATH = /^\.codex\/(?:hooks\/[\w-]+(?:\.[\w-]+)*\.js|workflow\/[\w-]+(?:\.[\w-]+)*\.md|[\w-]+(?:\.[\w-]+)*\.js)$/;

// Deletes files an earlier version installed that this one no longer ships.
function removeStale(root, previous, current) {
  for (const file of Array.isArray(previous.files) ? previous.files : []) {
    if (typeof file !== "string" || current.includes(file) || !STALE_PATH.test(file)) continue;
    if (readText(path.join(root, file)) !== null) remove(root, file);
  }
}

function sectionRange(text, heading) {
  const match = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(text);
  if (!match) return null;
  // A section written by v4 or later ends at its end marker, so notes below it survive.
  const marker = text.indexOf(SECTION_END, match.index);
  if (marker !== -1) return { start: match.index, end: marker + SECTION_END.length };
  // Older sections end at the next level-2 heading outside a fenced code block.
  let offset = match.index + match[0].length;
  let fenced = false;
  for (const line of text.slice(offset).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^## /.test(line)) return { start: match.index, end: offset };
    offset += line.length + 1;
  }
  return { start: match.index, end: text.length };
}

// Appends the template's section, or replaces an existing, different one: it belongs to the
// workflow, and the plugin's version always wins.
function mergeSection(root, file, section, heading) {
  const target = path.join(root, file);
  const text = readText(target);
  const body = section.trim() + "\n";
  if (text === null) return write(target, body, file, `created with the ${heading} section`);
  const range = sectionRange(text, heading);
  if (!range) return write(target, `${text.trimEnd()}\n\n${body}`, file, `appended the ${heading} section`);
  const lf = (value) => value.replace(/\r\n/g, "\n").trim();
  if (lf(text.slice(range.start, range.end)) === lf(section)) return record(file, true, `${heading} is up to date`);
  const rest = text.slice(range.end).replace(/^\s+/, "");
  const updated = `${text.slice(0, range.start)}${body}${rest ? `\n${rest}` : ""}`;
  write(target, updated, file, `replaced the ${heading} section`);
}

// Merges the template hook groups into a Codex hooks file. Groups whose commands are already
// present are skipped, and the old workflow Stop hook (claude-verify.js) is removed. `events`
// limits which template events are merged. With `owned` (the project's own file), hooks the
// workflow added that no longer apply are removed too: graphify hook-guard entries (Codex
// rejects the context they print; graph guidance reaches Codex through CODEX.md instead), and
// template hooks of events not merged (the Codex-only SessionStart hook after a mode switch).
const graphifyGuard = /graphify(\.exe)?"? hook-guard/i;

function mergeHooks(file, step, { events, owned } = {}) {
  const wanted = JSON.parse(fs.readFileSync(path.join(templates, "codex", "hooks.json"), "utf8"));
  const text = readText(file);
  let config;
  try {
    config = text === null ? { description: wanted.description, hooks: {} } : JSON.parse(text);
  } catch {
    return record(step, false, "isn't valid JSON; merge templates/codex/hooks.json by hand");
  }
  config.hooks = config.hooks || {};
  const dropped = owned ? Object.entries(wanted.hooks).filter(([event]) => events && !events.includes(event)).flatMap(([, groups]) => groups.flatMap(hookCommands)) : [];
  let legacy = 0;
  let repaired = 0;
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) continue;
    config.hooks[event] = groups.map((group) => {
      const hooks = (group.hooks || []).filter((hook) => {
        const commands = [hook.command, hook.commandWindows].filter((command) => typeof command === "string");
        const stop = commands.some((command) => command.includes("claude-verify.js"));
        const old = stop || (owned && commands.some((command) => graphifyGuard.test(command) || dropped.includes(command)));
        if (stop) legacy++;
        if (old) repaired++;
        return !old;
      });
      return hooks.length === (group.hooks || []).length ? group : { ...group, hooks };
    }).filter((group) => (group.hooks || []).length);
    if (!config.hooks[event].length && groups.length) delete config.hooks[event];
  }
  let added = 0;
  for (const [event, groups] of Object.entries(wanted.hooks)) {
    if (events && !events.includes(event)) continue;
    const existing = (config.hooks[event] = config.hooks[event] || []);
    const present = new Set(existing.flatMap(hookCommands));
    for (const group of groups) {
      if (hookCommands(group).every((command) => present.has(command))) continue;
      existing.push(group);
      added++;
    }
  }
  if (!added && !repaired) return record(step, true, "hooks up to date");
  // A tracked hooks file is only pointed out, never edited, like old sections in CLAUDE.md.
  const rel = projectRel(file);
  if (rel && isTracked(projectDir, rel)) {
    if (legacy) record(`${step} (old workflow)`, null, "still has the previous version's Stop hook (claude-verify.js), which does nothing now; it's tracked, so remove it together with your team when convenient");
    return;
  }
  write(file, JSON.stringify(config, null, 2) + "\n", step, `added ${added} hook group(s), updated ${repaired} hook(s); trust them again in Codex (/hooks)`);
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// The project's .codex/hooks.json when it's ours to change; a tracked one is only checked
// (old Stop hook) and never edited. An existing user-level ~/.codex/hooks.json loses the old
// Stop hook, if any. Only a Codex-only project gets the SessionStart hook that points Codex at
// its rules (with Claude, the handoff message does); an existing project file just loses the
// hooks earlier versions added.
function mergeProjectHooks(root, mode) {
  const rel = ".codex/hooks.json";
  const userFile = path.join(codexHome(), "hooks.json");
  if (fs.existsSync(userFile)) mergeHooks(userFile, "~/.codex/hooks.json", { events: [] });
  const file = path.join(root, rel);
  const tracked = isTracked(root, rel);
  if (mode === "codex" && !tracked) return mergeHooks(file, rel, { owned: true });
  if (mode === "codex") record(`${rel} (rules hook)`, null, "tracked by git, so the SessionStart hook isn't added; start each Codex thread with: follow .codex/workflow/CODEX.md");
  if (fs.existsSync(file)) mergeHooks(file, rel, { events: [], owned: true });
}

// The graphify guard hooks `graphify claude install` would put in the shared .claude/settings.json:
// before a search or raw read, Claude is nudged to query the graph first. graphify may live at a
// full path; commands are compared without it.
function graphifyGuards(graphify) {
  const exe = !graphify ? "graphify" : / /.test(graphify) ? `"${graphify}"` : graphify;
  return [
    { matcher: "Bash|Grep", hooks: [{ type: "command", command: `${exe} hook-guard search` }] },
    { matcher: "Read|Glob", hooks: [{ type: "command", command: `${exe} hook-guard read` }] },
  ];
}
const guardKind = (command) => (graphifyGuard.test(command) ? String(command).replace(/^.*hook-guard\s+(\w+).*$/s, "$1") : "");

// Claude Code: a PostToolUse hook on ExitPlanMode that reminds Claude how this plan is run, and
// the graphify guards. settings.local.json is per-user, so teammates never see it. The plan hook
// runs .codex/hooks/claude-plan-gate.js, so it is only wired up when that script is ours: a
// tracked copy can't be updated by the plugin and may not be what the plugin ships. The guards
// are skipped with --skip-graphify (sync remembers it), and when the shared .claude/settings.json already has
// graphify's own.
function mergeClaudeSettings(root, graphify, guards, mode) {
  const rel = ".claude/settings.local.json";
  const file = path.join(root, rel);
  const text = readText(file);
  let config;
  try {
    config = text === null ? {} : JSON.parse(text);
  } catch {
    return record(rel, false, "isn't valid JSON; add the ExitPlanMode and graphify hooks by hand (see SKILL.md)");
  }
  config.hooks = config.hooks || {};
  const added = [];
  const completionCommand = "node -e \"require(require('path').join(process.env.CLAUDE_PROJECT_DIR||process.cwd(),'.codex','hooks','claude-completion-gate.js'))\"";
  for (const event of ["SessionStart", "Stop"]) {
    const groups = (config.hooks[event] || []).map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => hook.command !== completionCommand) })).filter((group) => group.hooks.length);
    if (mode === "dual" && !isTracked(root, ".codex/hooks/claude-completion-gate.js")) {
      groups.push({ hooks: [{ type: "command", command: completionCommand, timeout: 30 }] });
    }
    if (JSON.stringify(groups) !== JSON.stringify(config.hooks[event] || [])) added.push(`${event} completion check`);
    if (groups.length) config.hooks[event] = groups;
    else delete config.hooks[event];
  }
  if (isTracked(root, ".codex/hooks/claude-plan-gate.js")) {
    record(`${rel} (plan hook)`, null, ".codex/hooks/claude-plan-gate.js is tracked by git, so the plan handoff hook isn't added; remove the tracked legacy script in a team change, then rerun setup to enable automatic routing");
  } else {
    const command = "node -e \"const p=require('path').join(process.env.CLAUDE_PROJECT_DIR||process.cwd(),'.codex','hooks','claude-plan-gate.js');require('fs').existsSync(p)?require(p):console.log('{}')\"";
    const groups = (config.hooks.PostToolUse = config.hooks.PostToolUse || []);
    if (!groups.some((group) => hookCommands(group).includes(command))) {
      groups.push({ matcher: "ExitPlanMode", hooks: [{ type: "command", command }] });
      added.push("the ExitPlanMode handoff hook");
    }
  }
  if (guards && !graphifyGuard.test(readText(path.join(root, ".claude", "settings.json")) || "")) {
    const pre = (config.hooks.PreToolUse = config.hooks.PreToolUse || []);
    const present = new Set(pre.flatMap(hookCommands).map(guardKind));
    let missing = graphifyGuards("").filter((group) => !present.has(guardKind(group.hooks[0].command)));
    // Sync passes no graphify path; look it up only when a guard is actually missing.
    const exe = missing.length ? graphify || findGraphify() : "";
    if (missing.length && !exe) {
      record(`${rel} (graphify)`, null, "graphify isn't installed, so its guard hooks aren't added");
      missing = [];
    }
    missing = graphifyGuards(exe).filter((group) => missing.some((wanted) => wanted.matcher === group.matcher));
    if (missing.length) {
      pre.push(...missing);
      added.push("the graphify guard hooks");
    }
    if (!pre.length) delete config.hooks.PreToolUse;
  }
  if (!added.length) return record(rel, true, "plan and graphify hooks present");
  write(file, JSON.stringify(config, null, 2) + "\n", rel, `added ${added.join(" and ")}`);
}

function hookCommands(group) {
  return (group.hooks || []).map((hook) => hook.command);
}

// Local-only workflow paths, hidden from git status through .git/info/exclude.
function localPaths(root) {
  return [
    ".codex/plans/",
    ".codex/verify/",
    ".codex/verify.json",
    ".codex/autopilot/",
    ".codex/tasks/",
    ".codex/workflow/",
    ".codex/workflow-manifest.json",
    ".codex/autopilot.js",
    ".codex/hooks/claude-verify.js",
    ".codex/hooks/workflow-lib.js",
    ".codex/hooks/claude-plan-gate.js",
    ".codex/hooks/claude-completion-gate.js",
    ...(isTracked(root, ".codex/hooks.json") ? [] : [".codex/hooks.json"]),
    "CLAUDE.local.md",
    ".claude/settings.local.json",
    "graphify-out/",
  ];
}

// Adds the missing entries under the workflow's own heading: at the end of that block when it
// exists (so upgrades don't stack a second heading), or as a new block at the end of the file.
function appendBlock(file, step, heading, wanted) {
  const text = readText(file) || "";
  const lines = text.split(/\r?\n/);
  const missing = wanted.filter((line) => !lines.some((existing) => existing.trim() === line));
  if (!missing.length) return record(step, true, "workflow entries present");
  const note = `added ${missing.length} entr${missing.length === 1 ? "y" : "ies"}`;
  const at = lines.findIndex((line) => line.trim() === `# ${heading}`);
  if (at === -1) {
    const block = `${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}# ${heading}\n${missing.join("\n")}\n`;
    return write(file, text + block, step, note);
  }
  let end = at + 1;
  while (end < lines.length && lines[end].trim() && !lines[end].startsWith("#")) end++;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  lines.splice(end, 0, ...missing);
  write(file, lines.join(eol), step, note);
}

function updateExclude(root) {
  const rel = gitIn(root, ["rev-parse", "--git-path", "info/exclude"]).stdout.trim() || ".git/info/exclude";
  appendBlock(path.resolve(root, rel), ".git/info/exclude", "Claude + Codex workflow (local only)", localPaths(root));
}

// Earlier versions could write workflow sections into tracked files (the removed --shared
// layout). Those are only pointed out, never edited.
function migrateOldLayout(root) {
  const old = [
    ["CLAUDE.md", "## Workflow", "autopilot.js"],
    ["AGENTS.md", "## Codex execution", "autopilot.js"],
    [".gitignore", "# Claude + Codex workflow", "plans/*"],
  ];
  for (const [file, heading, marker] of old) {
    const text = readText(path.join(root, file));
    if (text && text.includes(heading) && text.includes(marker)) {
      record(`${file} (old workflow)`, null, `still has the previous version's "${heading}" block; the rules now live in local files, so remove it together with your team when convenient`);
    }
  }
}

// The manifest written by an earlier run. A committed one isn't trusted (anyone could have
// written it), so it is treated as missing.
function readManifest(root) {
  if (isTracked(root, MANIFEST)) return null;
  const manifest = readJson(path.join(root, MANIFEST));
  return manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : null;
}

function setupIntegrations(graphify) {
  if (flag("--skip-graphify")) record("graphify install", null, "skipped (--skip-graphify)");
  else if (!graphify && !dryRun) record("graphify install", false, "graphify isn't installed; re-run after installing it");
  else record("graphify project install", null, "skipped: it edits shared CLAUDE.md/AGENTS.md. The graphify rules are in the local workflow rules, and Claude's guard hooks in .claude/settings.local.json");
}

// Deletes files earlier versions installed and this one dropped, when they're still unedited.
function removeRetired(root, previous) {
  for (const { file, sha: shipped } of RETIRED) {
    const current = readText(path.join(root, file));
    if (current === null) continue;
    const hash = sha(current.replace(/\r\n/g, "\n"));
    if (hash !== shipped && hash !== previous.managed?.[file]) {
      record(file, null, "no longer part of the workflow and edited, so left in place; delete it if you don't use it");
      continue;
    }
    remove(root, file);
    try {
      fs.rmdirSync(path.dirname(path.join(root, file)));
    } catch {
      // not empty, or already gone
    }
  }
}

function setupProject(root, graphify, mode) {
  projectDir = root;
  if (!sync) console.log(`\nProject: ${root} (${mode === "dual" ? "Claude + Codex" : `${mode} only`}; local only: no tracked file is changed)`);
  const previous = readManifest(root) || {};
  // graphify guard hooks for Claude: --skip-graphify opts out, and sync remembers that.
  const guards = sync ? previous.guards !== false : !flag("--skip-graphify");
  if (typeof previous.version === "string" && compareVersions(previous.version, pluginVersion) > 0) {
    return record("project", false, `already uses workflow v${previous.version}, newer than this plugin (v${pluginVersion}); update the plugin instead of downgrading the project`);
  }
  const render = (from) => lib.forMode(fs.readFileSync(path.join(templates, from), "utf8"), mode);
  // A Claude-only project has no Codex rules; an earlier copy is removed as a stale file.
  const ownedPaths = [...OWNED.map((file) => `.${file}`), ...(mode === "claude" ? [] : [CODEX_RULES])];
  for (const file of OWNED) copyOwned(root, file, `.${file}`);
  if (mode !== "claude") {
    const title = mode === "codex" ? "Codex rules for the Codex-only workflow" : "Codex rules for the Claude + Codex workflow";
    writeOwned(root, `# ${title}\n\n${render("AGENTS.codex.md")}`, CODEX_RULES);
  }
  removeStale(root, previous, ownedPaths);
  removeRetired(root, previous);
  const managed = {};
  for (const [from, to] of MANAGED) {
    const source = render(from);
    copyManaged(root, source, to, previous.managed || {});
    // Record a hash only for text this plugin wrote; a customized file keeps the old hash, so it never matches.
    const text = readText(path.join(root, to));
    if (text !== null && text === source) managed[to] = sha(text);
    else if (previous.managed?.[to]) managed[to] = previous.managed[to];
  }
  if (!sync) migrateOldLayout(root);

  // A Codex-only project has no Claude: its CLAUDE.local.md and settings are left as they are.
  if (mode !== "codex") {
    mergeSection(root, "CLAUDE.local.md", render("CLAUDE.workflow.md"), "## Workflow");
    mergeClaudeSettings(root, graphify, guards, mode);
  }
  mergeProjectHooks(root, mode);
  updateExclude(root);

  // Sync is files only: graphify is left as it is.
  if (!sync) setupIntegrations(graphify);

  if (!dryRun && results.every((r) => r.ok !== false)) {
    const manifest = { version: pluginVersion, mode, ...(guards ? {} : { guards: false }), files: ownedPaths, managed };
    const text = JSON.stringify(manifest, null, 2) + "\n";
    if (readText(path.join(root, MANIFEST)) !== text) write(path.join(root, MANIFEST), text, MANIFEST, `workflow v${pluginVersion}`);
  }

  if (!dryRun && !sync) {
    console.log("\nDetected checks (node .codex/hooks/claude-verify.js --print-checks):");
    const checks = run(process.execPath, [path.join(root, ".codex", "hooks", "claude-verify.js"), "--print-checks"], { cwd: root });
    console.log((checks.stdout || checks.stderr || "").replace(/^/gm, "  "));
  }
}

function projectRoot() {
  const start = path.resolve(flagValue("--root") || process.cwd());
  const result = spawnSync(isWindows ? "git.exe" : "git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? path.resolve(result.stdout.trim()) : "";
}

// The main worktree's root when root is a linked git worktree, else "".
function mainWorktree(root) {
  const listed = gitIn(root, ["worktree", "list", "--porcelain"]);
  const first = listed.status === 0 ? /^worktree (.+)$/m.exec(listed.stdout) : null;
  const main = first ? path.resolve(first[1].trim()) : "";
  return main && path.resolve(root) !== main ? main : "";
}

// The mode a run uses: the flag, else the one the project (or, for a linked worktree, its main
// worktree) was set up with, else both agents.
function projectMode(root, manifest) {
  if (modeFlag) return modeFlag;
  const main = !manifest && root ? mainWorktree(root) : "";
  const recorded = (manifest || (root && readManifest(root)) || (main && readManifest(main)) || {}).mode;
  return ["claude", "codex"].includes(recorded) ? recorded : "dual";
}

// Files-only upgrade for a project that already uses the workflow. Silent when there is
// nothing to do, and never fails the session it runs in.
// Never writes a tracked file, never runs tools or installers, never takes a project set up
// by a newer plugin back, and writes only inside the project.
function syncProject() {
  const root = projectRoot();
  if (!root) return;
  projectDir = root;
  if (isTracked(root, MANIFEST)) {
    notices.push(`${MANIFEST} is committed to git, so it isn't trusted and the project isn't synced. Remove it from git (git rm --cached ${MANIFEST}), then run /dual-agent-workflow:setup --project-only.`);
    return;
  }
  let manifest = readManifest(root);
  if (!manifest) {
    // A linked worktree starts without the ignored workflow files; the main worktree's
    // manifest says the workflow is in use, so set this one up the same way.
    const main = mainWorktree(root);
    const mainManifest = main ? readManifest(main) : null;
    if (mainManifest && mainManifest.shared !== true) {
      setupProject(root, "", projectMode(root, mainManifest));
      return;
    }
    if (readText(path.join(root, ".codex", "autopilot.js")) !== null) {
      notices.push("this project's workflow files predate automatic updates. Run /dual-agent-workflow:setup --project-only once to upgrade them.");
    }
    return;
  }
  // The project was set up by a newer plugin; don't take it back.
  if (typeof manifest.version === "string" && compareVersions(manifest.version, pluginVersion) > 0) return;
  // The removed --shared layout lives in tracked files, which sync never writes.
  if (manifest.shared === true) {
    notices.push("this project used the shared layout, which is no longer supported. Run /dual-agent-workflow:setup --project-only to move it to local files; it will point out the old sections in tracked files for your team to remove.");
    return;
  }
  setupProject(root, "", projectMode(root, manifest));
}

function announceChanges() {
  for (const notice of new Set(notices)) console.log(`dual-agent-workflow: ${notice}`);
  const files = changed.filter((file) => file !== MANIFEST);
  if (files.length) {
    console.log(
      `dual-agent-workflow v${pluginVersion}: updated ${files.length} file(s) (${files.join(", ")}). ` +
      "Restart Claude Code and Codex so the updated workflow applies.",
    );
  }
  for (const r of results.filter((r) => r.ok === false)) console.log(`dual-agent-workflow sync: ${r.step}: ${r.note}`);
}

function leftForYou(mode) {
  const checks = `If the detected checks above are wrong or empty, add .codex/verify.json. For UI work, add its
     "ui" block (startCommand, url, viewports) so ${mode === "codex" ? "Codex" : "Claude"} can audit the app with Playwright.`;
  if (mode === "claude") {
    return [
      "Build the first graph: /graphify . in Claude Code (needs some code first).",
      checks,
      `Restart Claude Code (it loads CLAUDE.local.md, the plan and graphify hooks and the ponytail,
     taste-skill and caveman plugins) and check /mcp for playwright and playwright-headed.
Then plan a task with Claude: it implements every plan itself, checks each phase and asks you
before every commit.`,
    ];
  }
  if (mode === "codex") {
    return [
      "Open the project in Codex and trust the workflow hooks (Codex asks on first run, or use /hooks).",
      `Verify and review run read-only codex exec calls. Let those commands use the network and a long
     timeout (30 min); approve them when Codex asks to run outside the sandbox.`,
      "Build the first graph: graphify update . in a terminal (needs some code first).",
      checks,
      `Restart Codex and start a new thread (it loads .codex/workflow/CODEX.md through the SessionStart
     hook, and the ponytail, taste-skill and caveman plugins); check /mcp for playwright and playwright-headed.
Then describe a task to Codex: it plans, asks you to approve the plan, builds and checks each
phase, and asks you before every commit.`,
    ];
  }
  return [
    "Open the project in Codex and trust the workflow hooks (Codex asks on first run, or use /hooks).",
    `Codex runs the verify step (headless Claude) from its own session. Let those commands use the
     network and a long timeout (30 min); approve them when Codex asks to run outside the sandbox.`,
    "Build the first graph: /graphify . in Claude Code (needs some code first).",
    checks,
    `Restart Claude Code (it loads CLAUDE.local.md, the plan and graphify hooks and the ponytail,
     taste-skill and caveman plugins) and check /mcp for playwright and playwright-headed. In Codex,
     trust the plugin hooks (/hooks) and start a new thread.
Then keep a Codex session open in this repo and plan a task with Claude. Claude routes it by
task type; it resumes that session automatically so you see output, and requires a final Codex code audit.
With no open session it uses headless Codex. It never asks you to paste a handoff.`,
  ];
}

async function main() {
  if (sync) {
    try {
      syncProject();
      announceChanges();
    } catch (error) {
      console.log(`dual-agent-workflow sync skipped: ${error.message}`);
    }
    return;
  }
  if (["--dual", "--claude-only", "--codex-only"].filter(flag).length > 1) {
    console.error("Choose one: --dual, --claude-only or --codex-only.");
    process.exitCode = 1;
    return;
  }
  const doTools = !flag("--project-only");
  const doProject = !flag("--tools-only");
  if (dryRun) console.log("Dry run: nothing is installed or written.");

  const root = projectRoot();
  const mode = projectMode(root);
  const graphify = doTools ? await installTools(mode) : findGraphify();
  if (doProject) {
    if (!root) {
      record("project", false, "not inside a git repository; run `git init` first, or pass --root <dir>");
    } else {
      setupProject(root, graphify, mode);
    }
  }

  const failed = results.filter((r) => r.ok === false);
  console.log(`\n${failed.length ? `${failed.length} step(s) need attention:` : "All steps succeeded."}`);
  for (const r of failed) console.log(`  - ${r.step}: ${r.note}`);
  if (doProject) console.log(`\nLeft for you:\n${leftForYou(mode).map((step, i) => `  ${i + 1}. ${step}`).join("\n")}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
