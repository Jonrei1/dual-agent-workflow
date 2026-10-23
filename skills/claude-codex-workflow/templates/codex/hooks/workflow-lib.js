/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Shared by claude-verify.js, autopilot.js and claude-plan-gate.js.
//
// Everything the workflow writes is local to this clone: plans in .codex/plans/, verify logs
// in .codex/verify/<task>/, task summaries in .codex/tasks/. The installer hides them through
// .git/info/exclude, so nothing shows up in `git status` for the user or their teammates.
//
// Plans follow .codex/plans/_template.md: YAML-ish frontmatter, `## Acceptance` items with
// ids (A1, A2...), then `## Phase <N>: <title>` sections with Scope, Steps, Covers, Done when,
// Hands off and a **Gate** list of backticked commands. planChecklist() checks all of it.
//
// Phase diffs use snapshots independently of Claude's commits: the git tree of the whole
// working tree (tracked and untracked, ignore rules respected), written through a
// temporary index. A snapshot is a tree object, not a commit; it's on no branch and is
// never pushed. Diffing two snapshots shows exactly what a phase changed.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

const isWindows = process.platform === "win32";
const git = isWindows ? "git.exe" : "git";

// Workflow locations, relative to the repo root.
const plansRel = ".codex/plans";
const codexRulesRel = ".codex/workflow/CODEX.md";
const planPattern = /^\.codex\/plans\/[^/]+\.md$/;

// Changes under these paths are workflow state, not part of any phase.
const workflowPaths = [":!.codex", ":!.claude", ":!graphify-out", ":!CLAUDE.local.md"];
// Changes under these never trigger a verification run on their own.
const triggerIgnored = [...workflowPaths, ":!*.md"];

function gitRun(repoRoot, args, env) {
  return spawnSync(git, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: env || process.env,
  });
}

function gitOut(repoRoot, args, env) {
  const result = gitRun(repoRoot, args, env);
  return result.status === 0 ? result.stdout.trim() : "";
}

function treeExists(repoRoot, tree) {
  return Boolean(tree) && gitRun(repoRoot, ["cat-file", "-e", `${tree}^{tree}`]).status === 0;
}

// Tree of the current working tree, without touching the real index.
function snapshot(repoRoot) {
  const realIndex = path.resolve(repoRoot, gitOut(repoRoot, ["rev-parse", "--git-path", "index"]));
  const tempIndex = `${realIndex}.snapshot-${process.pid}-${Date.now()}`;
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tempIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    const added = gitRun(repoRoot, ["add", "-A", "--", "."], env);
    if (added.status !== 0) throw new Error(`git add (snapshot) failed: ${added.stderr.trim()}`);
    const tree = gitOut(repoRoot, ["write-tree"], env);
    if (!tree) throw new Error("git write-tree (snapshot) failed");
    return tree;
  } finally {
    fs.rmSync(tempIndex, { force: true });
  }
}

function headTree(repoRoot) {
  return gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
}

function changedFiles(repoRoot, from, to, pathspec = triggerIgnored) {
  return gitOut(repoRoot, ["diff", "--name-only", from, to, "--", ".", ...pathspec]).split("\n").filter(Boolean);
}

function diffText(repoRoot, from, to, pathspec = workflowPaths) {
  return gitOut(repoRoot, ["diff", from, to, "--", ".", ...pathspec]);
}

// Per-task verify logs and state: .codex/verify/<slug>/. Nothing is shared between tasks, so
// reports from different tasks (or worktrees) never overwrite each other.
function taskVerifyDir(repoRoot, slug) {
  return path.join(repoRoot, ".codex", "verify", slug || "_untasked");
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function verifyConfig(repoRoot) {
  return readJsonFile(path.join(repoRoot, ".codex", "verify.json")) || {};
}

// sha256 of a file's contents, or "" when it doesn't exist. A run records these for the plan
// and verify.json when it begins, so neither can be loosened mid-run to make a gate pass.
function fileHash(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

// ---- Plans -------------------------------------------------------------------------------

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(\w+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
}

function isPlaceholder(value) {
  return !value || /<[^>]*>/.test(value);
}

// The text after a bold label such as **Scope:** up to the next bold label, or null.
function labelBlock(body, label) {
  const match = new RegExp(`\\*\\*${label}[^*\\n]*\\*\\*([\\s\\S]*?)(?=\\n\\s*\\*\\*|$)`, "i").exec(body);
  return match ? match[1].trim() : null;
}

// Phases in document order: { id, title, body, gates, scope, steps, covers, doneWhen,
// handsOff }. The first backticked span on each bullet under **Gate** is a command.
function parsePhases(text) {
  const headings = [...text.matchAll(/^## Phase ([\w.]+):\s*(.+)$/gm)];
  return headings.map((heading, i) => {
    const start = heading.index + heading[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : nextH2(text, start);
    const body = text.slice(start, end);
    const gates = [];
    const gateBlock = /\*\*Gate[^\n]*\n([\s\S]*?)(?=\n\*\*|\n## |$)/.exec(body);
    if (gateBlock) {
      for (const line of gateBlock[1].split(/\r?\n/)) {
        const command = /^\s*[-*]\s*`([^`]+)`/.exec(line);
        if (command) gates.push(command[1].trim());
      }
    }
    const covers = labelBlock(body, "Covers");
    return {
      id: heading[1],
      title: heading[2].trim(),
      body,
      gates,
      scope: labelBlock(body, "Scope"),
      steps: labelBlock(body, "Steps"),
      covers: covers === null ? null : [...covers.matchAll(/\bA\d+\b/g)].map((m) => m[0]),
      doneWhen: labelBlock(body, "Done when"),
      handsOff: labelBlock(body, "Hands off"),
    };
  });
}

function nextH2(text, from) {
  const match = /^## (?!Phase )/m.exec(text.slice(from));
  return match ? from + match.index : text.length;
}

function section(text, heading) {
  const match = new RegExp(`^## ${heading}\\s*$`, "mi").exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const next = /^## /m.exec(text.slice(start));
  return text.slice(start, next ? start + next.index : text.length).trim();
}

// Acceptance items with ids: `- A1: ...`.
function acceptanceIds(text) {
  const body = section(text, "Acceptance") || "";
  return [...body.matchAll(/^\s*[-*]\s*\**(A\d+)\**\s*[:.)-]/gm)].map((m) => m[1]);
}

// The plan's `## UI audit` section: start command, URL, viewports and checks.
function uiAuditSpec(text) {
  const body = section(text, "UI audit");
  if (body === null) return null;
  const value = (name) => {
    const match = new RegExp(`^\\s*[-*]\\s*${name}:\\s*(.+)$`, "mi").exec(body);
    return match ? match[1].replace(/`/g, "").trim() : "";
  };
  const checksAt = /^\s*[-*]\s*Checks:\s*$/im.exec(body);
  const checks = checksAt
    ? body.slice(checksAt.index + checksAt[0].length).split(/\r?\n/).map((line) => /^\s+[-*]\s*(.+)$/.exec(line)).filter(Boolean).map((m) => m[1].trim())
    : [];
  const viewports = value("Viewports").split(/[,\s]+/).map(Number).filter((n) => n > 0);
  return { body, start: value("Start"), url: value("URL"), browser: value("Browser").toLowerCase().split(/\s/)[0], viewports, checks };
}

// Effective UI settings: the plan's ## UI audit section wins over .codex/verify.json "ui".
// Claude builds the frontend and runs the audit itself (the headless alternative is gone), so
// these are the spec it follows. headed: the user watches the browser. Claude asks for every
// ui: yes plan and records the answer as `- Browser: headless | headed`; verify.json
// ui.headed is the fallback.
function uiSettings(repoRoot, text) {
  const config = verifyConfig(repoRoot).ui || {};
  const spec = (text && uiAuditSpec(text)) || {};
  return {
    startCommand: (!isPlaceholder(spec.start) && spec.start) || config.startCommand || "",
    url: (!isPlaceholder(spec.url) && spec.url) || config.url || "",
    viewports: (spec.viewports && spec.viewports.length ? spec.viewports : config.viewports) || [375, 1280],
    browser: ["headless", "headed"].includes(spec.browser) ? spec.browser : typeof config.headed === "boolean" ? (config.headed ? "headed" : "headless") : "",
    headed: spec.browser === "headed" || (!["headless", "headed"].includes(spec.browser) && config.headed === true),
    checks: spec.checks || [],
  };
}

// Frontend work is Claude's, never a Codex phase: pages, components, styles, templates and the
// copy and accessibility in them. The plan lists it under `## Frontend (Claude)`.
const frontendPattern = /\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|html|hbs|ejs|pug)\b|(?:^|[\s`,(/])(?:components?|pages?|views?|screens?|styles?|frontend|ui)\//i;

function frontendSpec(text) {
  const body = section(text, "Frontend \\(Claude\\)");
  if (body === null) return null;
  const covers = labelBlock(body, "Covers");
  return { body, covers: covers === null ? [] : [...covers.matchAll(/\bA\d+\b/g)].map((m) => m[0]) };
}

const shellBuiltins = new Set(["cd", "echo", "test", "[", "true", "false", "exit", "set", "export", "env", "call", "if", "for"]);
const packageManagerCommands = new Set(["exec", "dlx", "install", "i", "add", "remove", "why", "list", "ls", "create", "x"]);

function onPath(command) {
  if (/[\\/]/.test(command)) return fs.existsSync(command);
  const exts = isWindows ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").toLowerCase().split(";")] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, command + ext))) return true;
    }
  }
  return false;
}

// Why a gate can't run here, or "" when it looks runnable. Checks each command in a chain:
// package scripts must exist in package.json, other programs must be on PATH or in
// node_modules/.bin.
function gateProblem(repoRoot, gate) {
  const pkg = readJsonFile(path.join(repoRoot, "package.json"));
  const scripts = (pkg && pkg.scripts) || {};
  const localBin = (name) => fs.existsSync(path.join(repoRoot, "node_modules", ".bin", name)) || (isWindows && fs.existsSync(path.join(repoRoot, "node_modules", ".bin", `${name}.cmd`)));
  for (const part of gate.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/).filter((word) => !/^\w+=/.test(word));
    if (!words.length) continue;
    const [program, first, second] = words;
    if (shellBuiltins.has(program)) continue;
    let script = "";
    if (["npm", "bun"].includes(program) && ["run", "run-script"].includes(first)) script = second;
    else if (program === "npm" && ["test", "t"].includes(first)) script = "test";
    else if (["pnpm", "yarn"].includes(program) && first === "run") script = second;
    else if (["pnpm", "yarn"].includes(program) && first && !first.startsWith("-") && !packageManagerCommands.has(first)) {
      if (!scripts[first] && !localBin(first)) return `\`${part.trim()}\`: no "${first}" script in package.json`;
      continue;
    }
    if (script !== "") {
      if (!script || !scripts[script]) return `\`${part.trim()}\`: no "${script || "?"}" script in package.json`;
      continue;
    }
    if (!onPath(program) && !localBin(program) && !fs.existsSync(path.join(repoRoot, program))) {
      return `\`${part.trim()}\`: \`${program}\` isn't on PATH`;
    }
  }
  return "";
}

// The planning checklist: [{ ok, item, detail }]. A plan is handed off only when every
// item is ok, so each phase ties into the next and the handoff carries everything Codex
// and the reviewers need.
function planChecklist(repoRoot, slug, text) {
  const meta = frontmatter(text);
  const phases = parsePhases(text);
  const items = [];
  const add = (ok, item, detail = "") => items.push({ ok, item, detail });

  add(Boolean(meta.task) && !isPlaceholder(meta.task) && meta.task === slug, "frontmatter task matches the file name", meta.task === slug ? "" : `task: ${meta.task || "(missing)"}, file: ${slug}`);
  add(["normal", "high"].includes(meta.risk), "frontmatter risk is normal or high", meta.risk || "(missing)");
  add(["none", "codex"].includes(meta.review || "none"), "frontmatter review is none or codex", meta.review || "");
  add(["yes", "no"].includes(meta.ui), "frontmatter ui is yes or no", meta.ui || "(missing)");
  add(phases.length > 0, "has `## Phase <N>: <title>` sections");

  const ids = acceptanceIds(text);
  add(ids.length > 0, "acceptance items have ids (`- A1: ...`)");
  const frontend = meta.ui === "yes" ? frontendSpec(text) : null;
  const covered = new Set([...phases.flatMap((phase) => phase.covers || []), ...(frontend ? frontend.covers : [])]);
  const uncovered = ids.filter((id) => !covered.has(id));
  add(uncovered.length === 0, "every acceptance item is covered by a phase", uncovered.join(", "));
  const unknown = [...covered].filter((id) => !ids.includes(id));
  add(unknown.length === 0, "every **Covers:** id exists under Acceptance", unknown.join(", "));

  phases.forEach((phase, index) => {
    const label = `Phase ${phase.id}`;
    const filled = (value) => value !== null && !isPlaceholder(value) && value.replace(/[.\s]/g, "") !== "";
    add(!isPlaceholder(phase.title), `${label}: title`);
    add(!frontendPattern.test(phase.scope || ""), `${label}: **Scope:** is backend only (frontend files are Claude's: list them under ## Frontend (Claude), not in a phase)`, (frontendPattern.exec(phase.scope || "") || [""])[0].trim());
    add(filled(phase.scope), `${label}: **Scope:**`);
    add(filled(phase.steps), `${label}: **Steps:**`);
    add(phase.covers !== null && phase.covers.length > 0, `${label}: **Covers:** acceptance ids`);
    add(filled(phase.doneWhen), `${label}: **Done when:**`);
    if (index < phases.length - 1) add(filled(phase.handsOff), `${label}: **Hands off:** (what phase ${phases[index + 1].id} relies on)`);
    add(phase.gates.length > 0, `${label}: gate command`);
    for (const gate of phase.gates) {
      if (isPlaceholder(gate)) {
        add(false, `${label}: gate is runnable`, `\`${gate}\` is a placeholder`);
      } else {
        const problem = gateProblem(repoRoot, gate);
        add(!problem, `${label}: gate is runnable`, problem);
      }
    }
  });

  if (meta.ui === "yes") {
    const spec = uiAuditSpec(text);
    const ui = uiSettings(repoRoot, text);
    add(spec !== null, "ui: yes has a `## UI audit` section");
    add(Boolean(ui.url), "UI audit URL (plan `- URL:` or verify.json ui.url)");
    add(Boolean(ui.startCommand), "UI audit start command (plan `- Start:` or verify.json ui.startCommand)");
    add(Boolean(spec && spec.checks.length), "UI audit has `- Checks:` items");
    const front = frontendSpec(text);
    add(front !== null && front.body.replace(/\*\*Covers:\*\*[^\n]*/, "").replace(/<[^>]*>/g, "").trim() !== "", "ui: yes has a `## Frontend (Claude)` section listing the pages and components Claude builds");
    add(Boolean(front && front.covers.length), "`## Frontend (Claude)` has `**Covers:**` acceptance ids");
    const last = phases[phases.length - 1];
    if (last) add(last.handsOff !== null && !isPlaceholder(last.handsOff) && last.handsOff.replace(/[.\s]/g, "") !== "", `Phase ${last.id}: **Hands off:** (the API contract Claude builds the frontend against)`);
    add(Boolean(ui.browser), "UI audit browser is headless or headed (plan `- Browser:` or verify.json ui.headed); ask the user");
  }
  return items;
}

// Problems that stop autopilot before it starts.
function planProblems(repoRoot, slug, text) {
  return planChecklist(repoRoot, slug, text)
    .filter((item) => !item.ok)
    .map((item) => (item.detail ? `${item.item}: ${item.detail}` : item.item));
}

// ---- Headless Claude calls -------------------------------------------------------------
//
// Every headless call goes through runClaudeAsync, so all of them get the same trimmed
// setup. Listing only the built-in tools a call needs (--tools) cuts its fixed input from
// about 37k to 14k tokens, and --strict-mcp-config keeps MCP tool schemas out unless the
// call passes its own --mcp-config (the UI audit's Playwright server).
//
// Optional .codex/verify.json block:
//   "headless": { "settingSources": "project,local" }
// Passes --setting-sources, which skips user-level settings, plugins and hooks. It is opt-in:
// user settings can carry authentication or proxy environment, which would stop applying.

function headlessConfig(repoRoot) {
  return verifyConfig(repoRoot).headless || {};
}

// `allowed` holds permission patterns such as `Bash(npm test:*)`; the built-in tool a call
// needs is the name before the parenthesis. MCP tools come from --mcp-config instead.
function builtinTools(allowed) {
  return [...new Set(allowed.filter((pattern) => !pattern.startsWith("mcp__")).map((pattern) => pattern.replace(/\(.*$/, "")))];
}

// On Windows an npm install puts only claude.cmd on PATH, and spawn can't start a .cmd
// without a shell (which would mangle the prompt). Find the executable the shim points to.
let claudeCommand;
function resolveClaude() {
  if (claudeCommand) return claudeCommand;
  claudeCommand = { command: "claude", prefix: [] };
  if (!isWindows) return claudeCommand;
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir, "claude.exe");
    if (fs.existsSync(exe)) return (claudeCommand = { command: exe, prefix: [] });
    const shim = path.join(dir, "claude.cmd");
    if (!fs.existsSync(shim)) continue;
    const target = /"%dp0%\\([^"]+\.(?:exe|c?js))"/i.exec(fs.readFileSync(shim, "utf8"));
    const resolved = target && path.join(dir, target[1]);
    if (resolved && fs.existsSync(resolved)) {
      return (claudeCommand = /\.exe$/i.test(resolved) ? { command: resolved, prefix: [] } : { command: process.execPath, prefix: [resolved] });
    }
  }
  return claudeCommand;
}

function claudeArgs(repoRoot, { prompt, model, effort, allowed, denied = [], mcpConfig, jsonSchema, maxTurns }) {
  const claude = resolveClaude();
  const args = [
    ...claude.prefix,
    "-p", prompt,
    "--model", model,
    "--effort", effort,
    "--output-format", "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", builtinTools(allowed).join(","),
  ];
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  const { settingSources } = headlessConfig(repoRoot);
  if (settingSources) args.push("--setting-sources", String(settingSources));
  // The variadic flags go last so they can't swallow another option.
  args.push("--allowedTools", ...allowed);
  if (denied.length) args.push("--disallowedTools", ...denied);
  return { command: claude.command, args };
}

function finishClaude(result) {
  const stdout = (result.stdout || "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  const text = parsed && typeof parsed.result === "string" ? parsed.result.trim() : stdout;
  return { status: result.status, error: result.error, structured: parsed?.structured_output, text, stderr: (result.stderr || "").trim() };
}

// Runs `claude -p` without blocking, so independent review steps can run side by side, and
// resolves { status, error, structured, text, stderr }. `text` is the model's final reply,
// taken from the JSON result; if the output isn't JSON, it falls back to raw stdout.
function runClaudeAsync(repoRoot, options) {
  const { command, args } = claudeArgs(repoRoot, options);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Declared before `done`: spawn can throw synchronously (on Windows, for example), and
    // `done` then runs before any timer exists.
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(finishClaude({ stdout, stderr, ...result }));
    };
    let child;
    try {
      child = spawn(command, args, { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(options.env ? { env: options.env } : {}) });
    } catch (error) {
      done({ status: null, error });
      return;
    }
    timer = options.timeout
      ? setTimeout(() => {
        child.kill();
        done({ status: null, error: Object.assign(new Error(`timed out after ${options.timeout} ms`), { code: "ETIMEDOUT" }) });
      }, options.timeout)
      : null;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => done({ status: null, error }));
    child.on("close", (status) => done({ status }));
  });
}

// Runs a shell command without blocking: { cmd, ok, status, output }.
function runShellAsync(repoRoot, cmd, { timeout, env } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timer = null;
    const finish = (ok, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ cmd, ok, status, output: output.trim() });
    };
    let child;
    try {
      child = spawn(cmd, { cwd: repoRoot, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    } catch (error) {
      finish(false, error.message);
      return;
    }
    timer = timeout ? setTimeout(() => { killTree(child.pid); finish(false, "timed out"); }, timeout) : null;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.on("error", (error) => finish(false, error.message));
    child.on("close", (code) => finish(code === 0, `exit ${code}`));
  });
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (isWindows) spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

// ---- Project checks and the failure baseline -----------------------------------------
//
// The checks come from .codex/verify.json "checks", else from markers at the repo root.
// An autopilot run records a baseline when it begins: every gate and check, run on the
// untouched starting tree. A failure later counts only if its output has lines the
// baseline didn't, so errors that were already in the repo don't block the run.

function nodeChecks(repoRoot) {
  const has = (name) => fs.existsSync(path.join(repoRoot, name));
  const pkg = readJsonFile(path.join(repoRoot, "package.json"));
  if (!pkg) return [];
  const scripts = pkg.scripts || {};
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
  const run = { npm: "npm run", pnpm: "pnpm", yarn: "yarn", bun: "bun run" }[pm];
  const exec = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" }[pm];

  const checks = [];
  if (scripts.typecheck) checks.push(`${run} typecheck`);
  else if (has("tsconfig.json")) checks.push(`${exec} tsc --noEmit`);
  if (scripts.lint) checks.push(`${run} lint`);
  if (scripts.build) checks.push(`${run} build`);
  const test = scripts.test || "";
  if (test && !test.includes("no test specified") && !test.includes("watch")) {
    checks.push(`${run} test`);
  }
  return checks;
}

function pythonChecks(repoRoot) {
  const has = (name) => fs.existsSync(path.join(repoRoot, name));
  const hasPython = has("pyproject.toml") || has("setup.cfg") || fs.readdirSync(repoRoot).some((file) => /^requirements.*\.txt$/.test(file));
  if (!hasPython) return [];
  let pyproject = "";
  try {
    pyproject = fs.readFileSync(path.join(repoRoot, "pyproject.toml"), "utf8");
  } catch {
    // no pyproject.toml
  }
  const checks = [];
  if (pyproject.includes("[tool.ruff") || has("ruff.toml") || has(".ruff.toml")) checks.push("ruff check .");
  if (pyproject.includes("[tool.mypy") || has("mypy.ini")) checks.push("mypy .");
  if (pyproject.includes("[tool.pytest") || has("pytest.ini") || has("tests")) checks.push("pytest -q");
  return checks;
}

function detectChecks(repoRoot) {
  const override = verifyConfig(repoRoot);
  if (Array.isArray(override.checks)) {
    return override.checks.filter((check) => typeof check === "string" && check.trim());
  }
  const has = (name) => fs.existsSync(path.join(repoRoot, name));
  return [
    ...nodeChecks(repoRoot),
    ...(has("Cargo.toml") ? ["cargo check", "cargo test"] : []),
    ...(has("go.mod") ? ["go vet ./...", "go build ./...", "go test ./..."] : []),
    ...pythonChecks(repoRoot),
  ];
}

// Runs shell commands, concurrently by default. Builds run last, on their own, since they
// often share output folders with other tools. Results come back in the input order.
async function runCommandsAsync(repoRoot, commands, { timeout, env, parallel = verifyConfig(repoRoot).parallelChecks !== false } = {}) {
  const byCmd = new Map();
  const runOne = (cmd) => runShellAsync(repoRoot, cmd, { timeout, env });
  if (!parallel) {
    for (const cmd of commands) byCmd.set(cmd, await runOne(cmd));
  } else {
    const builds = commands.filter((cmd) => /\bbuild\b/.test(cmd));
    const others = commands.filter((cmd) => !builds.includes(cmd));
    for (const result of await Promise.all(others.map(runOne))) byCmd.set(result.cmd, result);
    for (const cmd of builds) byCmd.set(cmd, await runOne(cmd));
  }
  return commands.map((cmd) => byCmd.get(cmd));
}

// Output lines with the noise taken out, so the same error compares equal across runs:
// locations (file.ts(12,5), file.ts:12:5), counts and timings become placeholders.
function diagnosticLines(output) {
  return outputLines(output).map((line) => line.normal);
}

function outputLines(output) {
  return String(output || "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const normal = raw
        .replace(/\\/g, "/")
        .replace(/\(\d+,\d+\)/g, "(L,C)")
        .replace(/:\d+:\d+/g, ":L:C")
        .replace(/\d+(?:\.\d+)?/g, "N")
        .replace(/\s+/g, " ");
      return { raw, normal: isWindows ? normal.toLowerCase() : normal };
    });
}

// Lines of output that the baseline didn't have (counting repeats), in their original form.
function newFailureLines(output, baselineLines) {
  const counts = new Map();
  for (const line of baselineLines || []) counts.set(line, (counts.get(line) || 0) + 1);
  const added = [];
  for (const { raw, normal } of outputLines(output)) {
    const left = counts.get(normal) || 0;
    if (left > 0) counts.set(normal, left - 1);
    else added.push(raw);
  }
  return added;
}

function baselinePath(repoRoot, slug) {
  return path.join(repoRoot, ".codex", "autopilot", `${slug}.baseline.json`);
}

function readBaseline(repoRoot, slug) {
  return slug ? readJsonFile(baselinePath(repoRoot, slug)) : null;
}

// Runs the commands on the current tree and saves the result as the task's baseline.
async function recordBaseline(repoRoot, slug, commands, { tree = "", timeout, env } = {}) {
  const unique = [...new Set(commands.filter(Boolean))];
  const results = await runCommandsAsync(repoRoot, unique, { timeout, env });
  const baseline = { tree, recorded: new Date().toISOString(), commands: {} };
  for (const result of results) {
    baseline.commands[result.cmd] = { ok: result.ok, status: result.status, lines: result.ok ? [] : diagnosticLines(result.output) };
  }
  fs.mkdirSync(path.dirname(baselinePath(repoRoot, slug)), { recursive: true });
  fs.writeFileSync(baselinePath(repoRoot, slug), JSON.stringify(baseline, null, 2) + "\n");
  return baseline;
}

// A failed command against the baseline: { preexisting, newLines }. preexisting is true only
// when the command already failed before the task and every line of its output did too.
function classifyFailure(baseline, cmd, output) {
  const before = baseline && baseline.commands && baseline.commands[cmd];
  if (!before) return { preexisting: false, newLines: [], known: false };
  const newLines = newFailureLines(output, before.lines);
  return { preexisting: !before.ok && newLines.length === 0, newLines, known: true };
}

// ---- Codex sessions ----------------------------------------------------------------------
//
// Every Codex TUI (terminal or IDE) runs its threads on the shared local app-server daemon,
// and `codex queue` posts into a thread through it. The daemon is also the only place that
// knows which sessions are open right now: a session gets no rollout file or state row until
// its first message. So the handoff asks the daemon, over `codex app-server proxy` (stdio
// relayed to the control socket, which speaks JSON-RPC over WebSocket), for its loaded
// threads and picks the newest one whose cwd is this repo.

// One WebSocket frame. Client frames are masked; server frames aren't.
function encodeFrame(text, { mask = true } = {}) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x81;
  if (length < 126) header[1] = length;
  else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  return Buffer.concat([header, key, Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]))]);
}

// Splits complete frames off the front of buffer: { frames: [{ opcode, text }], rest }.
function decodeFrames(buffer) {
  const frames = [];
  for (; ;) {
    if (buffer.length < 2) break;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) break;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const keyLength = masked ? 4 : 0;
    if (buffer.length < offset + keyLength + length) break;
    const key = buffer.subarray(offset, offset + keyLength);
    let payload = buffer.subarray(offset + keyLength, offset + keyLength + length);
    if (masked) payload = Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]));
    frames.push({ opcode: buffer[0] & 0x0f, text: payload.toString("utf8") });
    buffer = buffer.subarray(offset + keyLength + length);
  }
  return { frames, rest: buffer };
}

// Runs JSON-RPC calls against the app-server daemon in order. Resolves to { results } (one
// per call; a call's error lands as { error }) or { error } when the daemon can't be reached.
function codexAppServer(calls, { timeoutMs = 10000, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(isWindows ? "codex app-server proxy" : "codex", isWindows ? [] : ["app-server", "proxy"], {
        shell: isWindows,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });
    } catch (error) {
      resolve({ error: error.message });
      return;
    }
    let settled = false;
    let stderr = "";
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let nextId = 0;
    const pending = new Map();
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const reject of pending.values()) reject(new Error("closed"));
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(value);
    };
    timer = setTimeout(() => finish({ error: `no answer from the Codex app-server within ${timeoutMs / 1000}s` }), timeoutMs);
    const send = (message) => child.stdin.write(encodeFrame(JSON.stringify(message)));
    const request = (method, params) =>
      new Promise((resolveCall, rejectCall) => {
        const id = ++nextId;
        pending.set(id, rejectCall);
        pending.set(`ok:${id}`, resolveCall);
        send({ id, method, params });
      });
    const onMessage = (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id === undefined || !pending.has(`ok:${message.id}`)) return;
      const resolveCall = pending.get(`ok:${message.id}`);
      pending.delete(message.id);
      pending.delete(`ok:${message.id}`);
      resolveCall(message);
    };
    const run = async () => {
      try {
        const init = await request("initialize", { clientInfo: { name: "dual-agent-workflow", version: "1" } });
        if (init.error) return finish({ error: `initialize failed: ${init.error.message || JSON.stringify(init.error)}` });
        send({ method: "initialized" });
        const results = [];
        for (const call of calls) {
          const reply = await request(call.method, call.params || {});
          results.push(reply.error ? { error: reply.error.message || JSON.stringify(reply.error) } : reply.result);
        }
        finish({ results });
      } catch {
        finish({ error: "the Codex app-server closed the connection" });
      }
    };
    child.on("error", (error) => finish({ error: error.message }));
    child.on("close", (code) => finish({ error: `codex app-server proxy exited with ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/)[0]}` : ""}` }));
    child.stdin.on("error", () => { });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const status = buffer.subarray(0, end).toString("utf8").split("\r\n")[0];
        buffer = buffer.subarray(end + 4);
        if (!/^HTTP\/1\.1 101\b/.test(status)) return finish({ error: `the Codex app-server refused the connection (${status})` });
        upgraded = true;
        run();
      }
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) if (frame.opcode === 1) onMessage(frame.text);
    });
    const key = crypto.randomBytes(16).toString("base64");
    child.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

// Threads loaded in the daemon right now: { threads } or { error }.
async function liveCodexThreads(options = {}) {
  const list = await codexAppServer([{ method: "thread/loaded/list" }], options);
  if (list.error) return { error: list.error };
  const ids = (list.results[0] && list.results[0].data) || [];
  if (!ids.length) return { threads: [] };
  const read = await codexAppServer(ids.map((threadId) => ({ method: "thread/read", params: { threadId, includeTurns: false } })), options);
  if (read.error) return { error: read.error };
  const threads = read.results.map((result) => result && result.thread).filter(Boolean);
  return { threads };
}

function samePath(a, b) {
  const normal = (p) => path.resolve(String(p).replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "");
  return isWindows ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b);
}

// The user's own sessions in repoRoot, newest first. Skips headless `codex exec` runs,
// subagents and Codex's side threads (titles and the like are ephemeral, threadSource
// other than "user").
function pickCodexSession(threads, repoRoot) {
  const matches = (threads || [])
    .filter((thread) => thread && thread.id && thread.cwd && samePath(thread.cwd, repoRoot))
    .filter((thread) => thread.source !== "exec" && !thread.parentThreadId && !thread.ephemeral)
    .filter((thread) => !thread.threadSource || thread.threadSource === "user")
    .map((thread) => ({
      id: thread.id,
      cwd: thread.cwd,
      source: thread.source || "",
      status: (thread.status && thread.status.type) || "",
      name: thread.name || "",
      at: thread.recencyAt || thread.updatedAt || thread.createdAt || 0,
    }))
    .sort((a, b) => b.at - a.at);
  return { session: matches[0] || null, others: matches.slice(1) };
}

// One session's state: { status: "idle" | "active" | "notLoaded" | "systemError" | "missing",
// flags, lastMessage } or { error } when the daemon can't be reached. lastMessage is the
// text of Codex's latest reply (empty when the session has no saved turns yet).
async function codexThreadState(threadId, options = {}) {
  const loaded = await codexAppServer([{ method: "thread/loaded/list" }], options);
  if (loaded.error) return { error: loaded.error };
  const ids = (loaded.results[0] && loaded.results[0].data) || [];
  if (!ids.includes(threadId)) return { status: "notLoaded", flags: [], lastMessage: "" };
  const reply = await codexAppServer(
    [
      { method: "thread/read", params: { threadId, includeTurns: false } },
      { method: "thread/read", params: { threadId, includeTurns: true } },
    ],
    options,
  );
  if (reply.error) return { error: reply.error };
  const thread = reply.results[0] && reply.results[0].thread;
  if (!thread) return { status: "missing", flags: [], lastMessage: "" };
  const status = (thread.status && thread.status.type) || "idle";
  const turns = (reply.results[1] && reply.results[1].thread && reply.results[1].thread.turns) || [];
  let lastMessage = "";
  for (const turn of turns) {
    for (const item of turn.items || []) if (item && item.type === "agentMessage" && item.text) lastMessage = item.text;
  }
  return { status, flags: (thread.status && thread.status.activeFlags) || [], lastMessage };
}

// The open Codex session for repoRoot: { session, others } or { session: null, error }.
async function findCodexSession(repoRoot, options = {}) {
  const live = await liveCodexThreads(options);
  if (live.error) return { session: null, others: [], error: live.error };
  return pickCodexSession(live.threads, repoRoot);
}

// ---- Playwright --------------------------------------------------------------------------

// Use the MCP package's Playwright dependency so the downloaded browser matches it.
function resolvePlaywright(globalRoot) {
  const packageFile = path.join(globalRoot, "@playwright", "mcp", "package.json");
  const requireMcp = createRequire(packageFile);
  const pkg = requireMcp(packageFile);
  const playwright = requireMcp("playwright");
  return {
    version: pkg.version,
    server: path.join(path.dirname(packageFile), pkg.bin["playwright-mcp"]),
    cli: path.join(path.dirname(requireMcp.resolve("playwright/package.json")), "cli.js"),
    browser: playwright.chromium.executablePath(),
  };
}


module.exports = {
  plansRel,
  codexRulesRel,
  planPattern,
  runClaudeAsync,
  runShellAsync,
  killTree,
  workflowPaths,
  fileHash,
  gitOut,
  treeExists,
  snapshot,
  headTree,
  changedFiles,
  diffText,
  taskVerifyDir,
  verifyConfig,
  frontmatter,
  parsePhases,
  uiSettings,
  frontendSpec,
  gateProblem,
  planChecklist,
  planProblems,
  detectChecks,
  runCommandsAsync,
  diagnosticLines,
  newFailureLines,
  baselinePath,
  readBaseline,
  recordBaseline,
  classifyFailure,
  encodeFrame,
  decodeFrames,
  pickCodexSession,
  codexThreadState,
  findCodexSession,
  resolvePlaywright,
};
