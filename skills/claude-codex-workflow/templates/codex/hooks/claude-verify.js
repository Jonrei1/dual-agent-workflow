/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Explicit verification runner: --run requires --plan and --phase. All its state and reports
// live in .codex/verify/<task>/, so tasks (and developers' worktrees) never overwrite each other.

const fs = require("node:fs");
const path = require("node:path");
const lib = require("./workflow-lib");

function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : "";
}

const repoRoot = flagValue("--root") ? path.resolve(flagValue("--root")) : path.resolve(__dirname, "..", "..");
const task = flagValue("--plan") ? path.basename(flagValue("--plan"), ".md") : "";
const stateDir = lib.taskVerifyDir(repoRoot, task);
const statePath = path.join(stateDir, "state.json");
const logPath = path.join(stateDir, "last.log");
const alignmentPath = path.join(stateDir, "alignment.md");
const diffPath = path.join(stateDir, "phase.diff");
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const alignmentDefaults = { model: "sonnet", effort: "medium", riskModel: "opus", riskPaths: [] };

function readText(name) {
  try {
    return fs.readFileSync(path.join(repoRoot, name), "utf8");
  } catch {
    return "";
  }
}

function readJson(name) {
  try {
    return JSON.parse(readText(name));
  } catch {
    return null;
  }
}

function detectChecks() {
  return lib.detectChecks(repoRoot);
}

function alignmentConfig() {
  const override = readJson(path.join(".codex", "verify.json"));
  const config = { ...alignmentDefaults, ...((override && override.alignment) || {}) };
  config.riskPaths = Array.isArray(config.riskPaths) ? config.riskPaths : [];
  return config;
}

// Minimal glob support for riskPaths: `**` (any depth), `*` and `?` (within a segment).
function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function readState() {
  try {
    return JSON.parse(readFile(statePath)) || {};
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function planInfo(rel, phase) {
  const text = readText(rel);
  return { rel, phase, text, meta: lib.frontmatter(text) };
}

function activePlan() {
  return flagValue("--plan") ? planInfo(flagValue("--plan"), flagValue("--phase")) : null;
}

// Where the change under review starts: --base, else the last verified snapshot while
// HEAD hasn't moved since, else HEAD's tree (a user commit accepts what it contains).
function resolveBase(state, head) {
  const override = flagValue("--base");
  if (override && lib.treeExists(repoRoot, override)) return { tree: override, from: "autopilot phase start" };
  if (state.verifiedTree && state.verifiedHead === head && lib.treeExists(repoRoot, state.verifiedTree)) {
    return { tree: state.verifiedTree, from: "last verified snapshot" };
  }
  return { tree: lib.headTree(repoRoot) || emptyTree, from: head ? "HEAD" : "empty repo" };
}

function context() {
  const head = lib.gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const state = readState();
  const base = resolveBase(state, head);
  const current = lib.snapshot(repoRoot);
  const files = lib.changedFiles(repoRoot, base.tree, current);
  const plan = activePlan();
  const config = alignmentConfig();
  let risk = "";
  if (plan && plan.meta.risk === "high") {
    risk = `${plan.rel} has risk: high`;
  } else {
    const patterns = config.riskPaths.map((glob) => ({ glob, re: globToRegExp(glob) }));
    for (const file of files) {
      const hit = patterns.find(({ re }) => re.test(file));
      if (hit) {
        risk = `${file} matches risk path ${hit.glob}`;
        break;
      }
    }
  }
  return { head, state, base, current, files, plan, config, risk };
}

const alignmentTools = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)"];
const alignmentDenied = ["Edit", "Write", "NotebookEdit", "PowerShell"];
const itemSchema = { anyOf: [{ type: "string" }, { type: "object", properties: { item: { type: "string" }, evidence: { type: "string" } }, required: ["item", "evidence"], additionalProperties: false }] };
const sections = { done: "DONE", partial: "PARTIAL", missing: "MISSING", outOfScope: "OUT OF SCOPE", handsOff: "HANDS OFF", must: "MUST FIX", unneeded: "COULD BE CUT", risks: "RISKS" };
const alignmentSchema = {
  type: "object",
  properties: { ...Object.fromEntries(Object.keys(sections).map((key) => [key, { type: "array", items: itemSchema }])), verdict: { type: "string", enum: ["PASS", "NEEDS REWORK"] } },
  required: [...Object.keys(sections), "verdict"], additionalProperties: false,
};

function alignmentPrompt(ctx, gateNote, diff) {
  const change = Buffer.byteLength(diff, "utf8") <= 60 * 1024 ? `Phase diff:\n${diff}` : `Read the complete phase diff in ${path.relative(repoRoot, diffPath).split(path.sep).join("/")}.`;
  return `You are reviewing a Codex implementation against its plan. Do NOT edit any file.
Judge the diff and source files, not Codex's summary. For this phase, report DONE, PARTIAL,
MISSING, OUT OF SCOPE, HANDS OFF, MUST FIX, COULD BE CUT and RISKS with file:line evidence.
Check Done when, Covers and the interfaces the next phase relies on. Review like a senior
developer and QA engineer who prefers the smallest change that solves the task:
- MUST FIX: a concrete failing case (input, state, wrong result) in code this phase touched:
  broken logic, unsafe input handling, lost data, an untested risky path. Only real defects.
- OUT OF SCOPE also covers a new dependency, config option or abstraction the phase's Steps
  didn't call for, and ANY change to frontend files (pages, components, views, styles,
  templates): those belong to Claude, never to a Codex phase.
- COULD BE CUT: code that duplicates something existing or serves no listed step. Report only.
- Style, naming and taste are not findings. Return the structured fields requested.
The gates and project checks already ran; do not run checks or browser audits.
Nothing is committed. The diff includes new files and excludes local workflow state.
End text with VERDICT: PASS | NEEDS REWORK for clients that need a text verdict.

Plan: ${ctx.plan.rel}
Phase: ${ctx.plan.phase}
Gate/check result: ${gateNote || "not supplied"}
${change}`;
}

function renderAlignment(structured) {
  return [...Object.entries(sections).flatMap(([key, title]) => [`## ${title}`, "", ...(structured[key] || []).map((item) => typeof item === "string" ? `- ${item}` : `- ${item.item}: ${item.evidence}`), ""]), `VERDICT: ${structured.verdict}`].join("\n");
}

async function runVerification() {
  fs.mkdirSync(stateDir, { recursive: true });
  const ctx = context();
  const taskDir = stateDir;
  const tag = `phase-${ctx.plan.phase}`;
  const diff = lib.diffText(repoRoot, ctx.base.tree, ctx.current) || "(no changes outside workflow paths)\n";
  fs.writeFileSync(diffPath, diff);
  fs.copyFileSync(diffPath, path.join(taskDir, `${tag}.diff`));
  const model = ctx.risk ? ctx.config.riskModel : ctx.config.model;
  fs.writeFileSync(logPath, `Alignment started ${new Date().toISOString()} | ${planLabel(ctx)} | ${model}/${ctx.config.effort}\n`);
  const result = await lib.runClaudeAsync(repoRoot, {
    name: "alignment", task, prompt: alignmentPrompt(ctx, flagValue("--gate"), diff),
    model, effort: ctx.config.effort, allowed: alignmentTools, denied: alignmentDenied,
    jsonSchema: alignmentSchema, maxTurns: 40, timeout: 30 * 60 * 1000,
  });
  const started = !result.error && result.status === 0;
  const structured = result.structured;
  const text = result.text || result.error?.message || result.stderr;
  const verdicts = [...text.matchAll(/^[\s*_`>]*VERDICT:\s*(PASS|NEEDS REWORK)/gim)];
  const alignment = ["PASS", "NEEDS REWORK"].includes(structured?.verdict) ? structured.verdict : verdicts.at(-1)?.[1].toUpperCase() || "NEEDS REWORK";
  const unchanged = lib.snapshot(repoRoot) === ctx.current;
  const mustFix = (structured?.must || []).length > 0;
  const verdict = !started ? "NOT RUN" : alignment === "PASS" && unchanged && !mustFix ? "PASS" : "NEEDS REWORK";
  const report = structured?.verdict ? renderAlignment(structured) : text;
  const header = `# Verification\n\n- Plan: ${planLabel(ctx)}\n- Verdict: ${verdict}\n- Checks: ${flagValue("--gate") || "not supplied"}\n\n${unchanged ? "" : "Working tree changed during review; verify again.\n\n"}${report}\n`;
  fs.writeFileSync(alignmentPath, header);
  fs.copyFileSync(alignmentPath, path.join(taskDir, `${tag}.alignment.md`));
  writeState({
    verifiedTree: verdict === "PASS" ? ctx.current : ctx.base.tree, verifiedHead: ctx.head,
    lastVerdict: verdict, lastAlignment: alignment, lastChecks: "pass",
    lastReports: path.relative(repoRoot, taskDir).split(path.sep).join("/")
  });
  fs.appendFileSync(logPath, `Finished ${new Date().toISOString()} | Verdict: ${verdict}\n`);
}

function planLabel(ctx) { return ctx.plan ? `${ctx.plan.rel} (phase ${ctx.plan.phase})` : "(none)"; }

if (process.argv.includes("--print-checks")) {
  const checks = detectChecks();
  console.log(checks.length ? checks.join("\n") : "(no checks detected; add .codex/verify.json)");
  const config = alignmentConfig();
  console.log(`Alignment: ${config.model}/${config.effort}, risk model ${config.riskModel}`);
} else if (process.argv.includes("--run")) {
  if (!flagValue("--plan") || !flagValue("--phase")) {
    console.error("--run requires --plan and --phase");
    process.exit(1);
  }
  runVerification().catch((error) => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(logPath, `\nVerification crashed: ${error.stack || error}\n`);
    writeState({ ...readState(), lastVerdict: "NOT RUN" });
    process.exitCode = 1;
  });
} else {
  console.error("usage: claude-verify.js --run --plan PLAN --phase N | --print-checks");
  process.exitCode = 1;
}
