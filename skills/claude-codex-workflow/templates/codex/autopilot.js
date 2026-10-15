/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Autopilot: run an approved plan end to end, handed to Codex automatically.
//
// Claude saves the plan to .codex/plans/<slug>.md, runs `check`, then `handoff`, which posts
// `Execute .codex/plans/<slug>.md ...` into the Codex session open in this repo (found through
// the Codex app-server; it waits for one, else prints the line to paste). Claude then runs
// `wait` in the background and reviews the result when the run ends. Codex (following
// .codex/workflow/CODEX.md "Full plan execution") calls the other steps from its own session:
//
//   node .codex/autopilot.js check   .codex/plans/<slug>.md      planning checklist (exit 1 if not runnable)
//   node .codex/autopilot.js handoff .codex/plans/<slug>.md      send the plan to Codex [--phase N] [--continue]
//                                                                 [--thread <id>] [--wait <s>] [--print]
//   node .codex/autopilot.js wait    .codex/plans/<slug>.md      block until the run is done, stuck or failed
//   node .codex/autopilot.js begin   .codex/plans/<slug>.md      start snapshot, status "running"
//   node .codex/autopilot.js review  .codex/plans/<slug>.md      read-only Codex plan review before handoff
//   node .codex/autopilot.js phase   .codex/plans/<slug>.md <N>  snapshot the phase's starting tree
//   node .codex/autopilot.js verify  .codex/plans/<slug>.md <N>  gate, then claude-verify.js --run
//   node .codex/autopilot.js stop    .codex/plans/<slug>.md      Codex can't go on: --reason "<why>" (state stuck)
//   node .codex/autopilot.js close   .codex/plans/<slug>.md      graphify update, then done
//
// Exit codes: 0 ok / PASS, 1 failed, 2 gate failed (fix and verify again),
// 3 NEEDS REWORK (read .codex/verify/<slug>/alignment.md, fix, verify again), 4 stuck (stop),
// 5 handoff couldn't reach Codex (paste the printed line), 6 wait timed out.
//
// `begin` records a baseline: every gate and check run on the untouched starting tree. A gate
// or check that later fails only with errors from that baseline doesn't block the run.
// `wait` watches the Codex session the plan went to: if Codex's turn ends (or the session
// closes) while the run is still going, it marks the run stuck instead of waiting forever.
//
// Nothing is committed, staged or pushed: every change is left in the working tree for
// the user to review and commit. Phases are tracked with snapshots (workflow-lib.js).
// Progress: .codex/autopilot/status.json and .codex/autopilot/<slug>.log.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lib = require("./hooks/workflow-lib");

const valueFlags = new Set(["--thread", "--phase", "--since", "--timeout", "--wait", "--reason"]);
const args = process.argv.slice(2);
const flags = new Set();
const flagValues = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const [name, inline] = arg.split(/=(.*)/s);
  flags.add(name);
  if (inline !== undefined) flagValues[name] = inline;
  else if (valueFlags.has(name) && args[i + 1] !== undefined) flagValues[name] = args[++i];
}
const flagValue = (name) => flagValues[name] || "";
const commands = ["check", "review", "handoff", "wait", "begin", "phase", "verify", "stop", "close"];
const command = commands.includes(positional[0]) ? positional.shift() : flags.has("--dry-run") ? "check" : "";
const [planArg, phaseArg] = positional;
const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const runDir = path.join(repoRoot, ".codex", "autopilot");
const statusPath = path.join(runDir, "status.json");
const handoffPath = path.join(runDir, "handoff.json");
const verifyScript = path.join(repoRoot, ".codex", "hooks", "claude-verify.js");
const callTimeoutMs = 30 * 60 * 1000;
const activeTimeoutMs = 6 * 60 * 60 * 1000;
const maxReworks = 2;
const maxGateFailures = 3;
const exitCodes = { failed: 1, gate: 2, rework: 3, stuck: 4, manual: 5, timeout: 6 };
const childEnv = process.env;

// A deliberate stop: state is "stuck" (needs a human decision) or "failed" (broken step).
class Stop extends Error {
  constructor(state, reason) {
    super(reason);
    this.state = state;
  }
}

// A wrong call (bad phase, step out of order). It doesn't change the run's state.
class Usage extends Error {}

let slug = "";
let planRel = "";
let logPath = "";
let status = {};

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFile(file));
  } catch {
    return null;
  }
}

function tail(text, max) {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  if (logPath) fs.appendFileSync(logPath, stamped + "\n");
}

function setStatus(fields) {
  status = { ...status, ...fields, updated: new Date().toISOString() };
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n");
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: callTimeoutMs,
    env: childEnv,
    ...options,
  });
}

// Windows starts codex through a .cmd shim, which needs a shell. Arguments are quoted, and
// the messages this script sends contain no shell metacharacters.
function quoteArg(arg) {
  return /[\s()]/.test(arg) ? `"${arg}"` : arg;
}

function runCodex(commandArgs, options = {}) {
  if (!isWindows) return run("codex", commandArgs, options);
  return run(["codex", ...commandArgs].map(quoteArg).join(" "), [], { shell: true, ...options });
}

function snapshot() {
  return lib.snapshot(repoRoot);
}

function saveOutput(name, result) {
  const file = path.join(runDir, `${slug}.${name}.out.log`);
  fs.writeFileSync(file, `${result.stdout || ""}\n${result.stderr || ""}`);
  return path.relative(repoRoot, file);
}

// This task's reports: .codex/verify/<slug>/ (verify state, log, alignment, diffs).
function taskFile(name) {
  return path.join(lib.taskVerifyDir(repoRoot, slug), name);
}

function taskFileRel(name) {
  return path.relative(repoRoot, taskFile(name)).split(path.sep).join("/");
}

// Who runs this: the git identity plus the OS user and machine, so a second developer who
// hits the run lock can see whose run it is.
function currentOwner() {
  const email = lib.gitOut(repoRoot, ["config", "user.email"]);
  return `${email || "unknown git user"} (${os.userInfo().username}@${os.hostname()})`;
}

function readPlan() {
  const text = readFile(path.join(repoRoot, planRel));
  return { text, meta: lib.frontmatter(text), phases: lib.parsePhases(text) };
}

function assertPlanValid(plan) {
  const problems = lib.planProblems(repoRoot, slug, plan.text);
  if (problems.length) throw new Stop("failed", `${planRel} isn't runnable:\n  - ${problems.join("\n  - ")}`);
}

// A gate passes when it exits 0, or when it fails only with errors that were already there
// before the task started (the baseline `begin` recorded). Result: { ok, preexisting } or
// { ok: false, gate, output, newLines, summary }.
async function runGates(phase) {
  const baseline = lib.readBaseline(repoRoot, slug);
  const preexisting = [];
  const commands = [...new Set([...phase.gates, ...lib.detectChecks(repoRoot)].map((cmd) => cmd.trim().replace(/^npm (?:run|run-script) test$/, "npm test")))];
  for (const cmd of commands) log(`gate/check: ${cmd}`);
  const results = await lib.runCommandsAsync(repoRoot, commands, { timeout: callTimeoutMs, env: childEnv });
  const reportDir = lib.taskVerifyDir(repoRoot, slug);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, `phase-${phase.id}.checks.log`), results.map((r) => `$ ${r.cmd} (${r.status})\n${r.output}`).join("\n\n"));
  for (const result of results) {
    if (result.ok) continue;
    const failure = lib.classifyFailure(baseline, result.cmd, result.output);
    if (failure.preexisting) {
      log(`gate: ${result.cmd} fails only with errors that were there before the task started; not blocking`);
      preexisting.push(result.cmd);
      continue;
    }
    const output = tail(result.output, 3000);
    const newPart = failure.known && failure.newLines.length ? `New since the task started:\n${failure.newLines.slice(0, 60).join("\n")}\n\nFull output:\n` : "";
    return { ok: false, gate: result.cmd, output, newLines: failure.newLines, summary: `${newPart}${output}` };
  }
  return { ok: true, preexisting };
}

function gateNoteFor(phase, preexisting = []) {
  const note = `gates and project checks passed (run by autopilot): ${phase.gates.join(" && ")}`;
  return preexisting.length
    ? `${note}. Except: ${preexisting.map((gate) => `\`${gate}\``).join(", ")} still fail, but only with errors that were already in the repo before the task started (not caused by this phase; don't flag them)`
    : note;
}

// Green gates and checks are followed by one read-only alignment review.
function verify(phase, phaseBase, preexisting = []) {
  log(`verify: phase ${phase.id} (alignment after green gates and checks)`);
  const gateNote = gateNoteFor(phase, preexisting);
  const result = run(process.execPath, [verifyScript, "--run", "--base", phaseBase, "--plan", planRel, "--phase", phase.id, "--gate", gateNote], {
    timeout: 2 * callTimeoutMs,
  });
  if (result.error || result.status !== 0) throw new Stop("failed", `verification didn't run: ${result.error?.message || `exit ${result.status}`}`);
  const state = readJson(taskFile("state.json")) || {};
  const verdict = state.lastVerdict || "none";
  if (verdict === "NOT RUN") throw new Stop("failed", `the Claude verification didn't start; see ${taskFileRel("last.log")}`);
  log(`verdict: ${verdict} (alignment ${state.lastAlignment || "?"}, checks ${state.lastChecks || "?"}; see ${taskFileRel("alignment.md")})`);
  const phases = { ...(status.phases || {}) };
  phases[phase.id] = { verdict, alignment: state.lastAlignment, checks: state.lastChecks, preexisting, reports: `${state.lastReports || ""}/phase-${phase.id}.*` };
  setStatus({ phases });
  return verdict === "PASS";
}

function needsPlanReview(plan) {
  return plan.meta.review === "codex" || plan.meta.risk === "high";
}

const reviewSchema = {
  type: "object", properties: {
    findings: { type: "array", items: { type: "object", properties: Object.fromEntries(["phase", "problem", "evidence", "proposedFix"].map((key) => [key, { type: "string" }])), required: ["phase", "problem", "evidence", "proposedFix"], additionalProperties: false } },
    verdict: { type: "string", enum: ["APPROVE", "CHANGES NEEDED"] },
  }, required: ["findings", "verdict"], additionalProperties: false,
};

function cmdReview() {
  const plan = readPlan();
  assertPlanValid(plan);
  const schemaFile = path.join(runDir, `${slug}.review-schema.json`);
  const outFile = path.join(runDir, `${slug}.review-output.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(reviewSchema, null, 2));
  fs.rmSync(outFile, { force: true });
  const prompt = `Review this plan against the codebase. Do not edit the plan or any source file.
Check files that do not exist, missed dependents (use graphify query when available), missing
test gates, unclear acceptance criteria, Hands off interfaces the next phase cannot rely on,
and risky ordering. For each finding, name its phase, problem, file or graph evidence and
proposed fix. Propose an intermediate phase when a prerequisite is missing; do not renumber
phases. Return the findings and APPROVE or CHANGES NEEDED using the supplied schema.
Never commit, stage, stash or push.

Plan: ${planRel}
${plan.text}`;
  log("codex: read-only plan review");
  const result = runCodex(["exec", "--sandbox", "read-only", "--ephemeral", "--output-schema", schemaFile, "-o", outFile, "-"], { input: prompt });
  const output = saveOutput("codex.review", result);
  if (result.error || result.status !== 0) throw new Usage(`plan review failed: ${result.error?.message || `exit ${result.status}`}; see ${output}`);
  const reviewed = readJson(outFile);
  if (!["APPROVE", "CHANGES NEEDED"].includes(reviewed?.verdict) || !Array.isArray(reviewed.findings) || reviewed.findings.some((item) => !item || ["phase", "problem", "evidence", "proposedFix"].some((key) => typeof item[key] !== "string"))) {
    throw new Usage(`plan review returned invalid findings; see ${path.relative(repoRoot, outFile)}`);
  }
  const reportDir = lib.taskVerifyDir(repoRoot, slug);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "plan-review.json"), JSON.stringify(reviewed, null, 2) + "\n");
  for (const finding of reviewed.findings) console.log(`\nPhase ${finding.phase}: ${finding.problem}\nEvidence: ${finding.evidence}\nProposed fix: ${finding.proposedFix}`);
  console.log(`\nPLAN REVIEW: ${reviewed.verdict}`);
}

// Codex builds the backend only. Claude builds the frontend after the run and audits it itself
// with Playwright (headless or headed, as the plan's `- Browser:` says), so close has no UI
// step: it only refreshes the graph.
async function close() {
  setStatus({ phase: "", step: "close" });
  const graph = await lib.runShellAsync(repoRoot, "graphify update .", { timeout: callTimeoutMs, env: childEnv });
  log(graph.ok ? "graphify update . done" : `graphify update . failed; update the graph after fixing it: ${tail(graph.output, 1000)}`);
  return 0;
}

function printChecklist(plan) {
  const items = lib.planChecklist(repoRoot, slug, plan.text);
  console.log(`Plan: ${planRel} (risk: ${plan.meta.risk || "?"}, review: ${plan.meta.review || "none"}, ui: ${plan.meta.ui || "?"})\n`);
  for (const item of items) console.log(`  [${item.ok ? "x" : " "}] ${item.item}${item.ok || !item.detail ? "" : ` -- ${item.detail}`}`);
  for (const phase of plan.phases) {
    console.log(`\nPhase ${phase.id}: ${phase.title}\n  covers: ${(phase.covers || []).join(", ") || "(none)"}\n  gate: ${phase.gates.join(" && ") || "(none)"}`);
  }
  const failed = items.filter((item) => !item.ok);
  console.log(`\nPlan review: ${needsPlanReview(plan) ? "run autopilot.js review" : "no"}`);
  console.log(failed.length ? `\nNot runnable: ${failed.length} item(s) to fix.` : "\nRunnable.");
  return failed.length;
}

function usage() {
  console.error(`usage:
  node .codex/autopilot.js check|review|begin|close .codex/plans/<slug>.md
  node .codex/autopilot.js handoff .codex/plans/<slug>.md [--phase N | --continue] [--thread <id>] [--wait <seconds>] [--print]
  node .codex/autopilot.js wait .codex/plans/<slug>.md [--since <iso>] [--timeout <seconds>]
  node .codex/autopilot.js phase|verify .codex/plans/<slug>.md <N>
  node .codex/autopilot.js stop .codex/plans/<slug>.md --reason "<why>"`);
  process.exit(exitCodes.failed);
}

function findPhase(id) {
  const phase = readPlan().phases.find((candidate) => candidate.id === id);
  if (!phase) throw new Usage(`${planRel} has no phase ${id}`);
  return phase;
}

// Codex-driven steps are separate processes that share .codex/autopilot/status.json.
function requireActive() {
  if (status.slug !== slug || !["running", "paused", "stuck", "failed"].includes(status.state)) {
    throw new Usage(`no active run for ${planRel}; run \`node .codex/autopilot.js begin ${planRel}\` first`);
  }
  const changed = Object.entries(gateInputs()).filter(([name, hash]) => status.inputs && status.inputs[name] !== hash).map(([name]) => name);
  if (changed.length) {
    throw new Stop("failed", `${changed.join(" and ")} changed after the run began. Gates and checks must not be loosened mid-run. If the change was deliberate, run \`node .codex/autopilot.js begin ${planRel}\` again to restart from the new version.`);
  }
  setStatus({ state: "running", reason: "" });
}

// Hashes of what decides whether a gate passes: the plan and .codex/verify.json. They're
// recorded at `begin`, and a later change stops the run.
function gateInputs() {
  return { "the plan": lib.fileHash(path.join(repoRoot, planRel)), "verify.json": lib.fileHash(path.join(repoRoot, ".codex", "verify.json")) };
}

// ---- handoff: send the plan to Codex ----

// No quotes, semicolons or other shell metacharacters: the message goes through cmd.exe,
// Windows and POSIX shells unchanged.
function handoffMessage() {
  if (flags.has("--continue")) {
    return `Continue ${planRel}: read .codex/autopilot/status.json and re-run the step that stopped, then carry on. Follow ${lib.codexRulesRel}, section Full plan execution.`;
  }
  const phase = flagValue("--phase");
  return phase
    ? `Execute phase ${phase} of ${planRel}. Follow ${lib.codexRulesRel}, section Single-phase handoff. Use phase and verify on the full-execution protocol.`
    : `Execute ${planRel}. Follow ${lib.codexRulesRel}, section Full plan execution.`;
}

function recordHandoff(via, thread, message, session = {}) {
  const record = { phase: flagValue("--phase"), slug, plan: planRel, via, thread: thread || "", source: session.source || "", cwd: session.cwd || "", message, at: new Date().toISOString() };
  fs.writeFileSync(handoffPath, JSON.stringify(record, null, 2) + "\n");
}

// Polls the Codex app-server until a session is open in this repo or the time runs out.
// Returns the last lookup: { session, others } or { session: null, error }.
async function waitForSession(seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const found = await lib.findCodexSession(repoRoot);
    if (found.session || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, Math.max(0, deadline - Date.now()))));
  }
}

function describeSession(session) {
  const details = [session.source, session.status].filter(Boolean).join(", ");
  return `${session.id}${details ? ` (${details})` : ""}${session.cwd ? ` in ${session.cwd}` : ""}`;
}

function queueInto(thread, message, session = { id: thread }) {
  const result = runCodex(["queue", "--thread", thread, "--message", message], { timeout: 60 * 1000, env: process.env });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (!result.error && result.status === 0 && !/^Error:/m.test(output)) {
    recordHandoff("codex queue", thread, message, session);
    console.log(`\nSent to Codex session ${describeSession(session)}:\n  ${message}`);
    return true;
  }
  console.log(`\ncodex queue to ${thread} failed${output ? `: ${tail(output, 500)}` : ""}.`);
  return false;
}

async function cmdHandoff() {
  const plan = readPlan();
  if (!flags.has("--continue") && printChecklist(plan)) {
    console.log("\nNot handed off: fix the plan until `check` is clean.");
    return exitCodes.failed;
  }
  const message = handoffMessage();
  const paste = () => {
    recordHandoff("print", "", message);
    console.log(`\nPaste this into Codex:\n\n${message}\n`);
    return exitCodes.manual;
  };
  if (flags.has("--print")) return paste();

  const config = lib.verifyConfig(repoRoot).handoff || {};
  const pinned = flagValue("--thread") || config.thread || "";
  if (pinned) return queueInto(pinned, message) ? 0 : paste();

  // Ask the Codex app-server which sessions are open in this repo. It sees a session as soon
  // as Codex starts, before its first message.
  let found = await lib.findCodexSession(repoRoot);
  if (!found.session) {
    const seconds = Number(flagValue("--wait") || (config.waitSeconds ?? 90)) || 0;
    if (seconds > 0) {
      console.log(`\nNo Codex session is open in this repo. Start Codex in a terminal here (your IDE's terminal is fine) and the plan will be sent to it. Waiting up to ${seconds}s...`);
      found = await waitForSession(seconds);
    }
  }
  if (!found.session) {
    console.log(found.error ? `\nCouldn't ask the Codex app-server for open sessions: ${found.error}` : "\nNo Codex session is open in this repo.");
    return paste();
  }
  if (found.others.length) {
    console.log(`\n${found.others.length + 1} Codex sessions are open in this repo; using the most recent. Others:\n${found.others.map((other) => `  ${describeSession(other)}`).join("\n")}\nPin one with --thread <id> or handoff.thread in .codex/verify.json.`);
  }
  return queueInto(found.session.id, message, found.session) ? 0 : paste();
}

// ---- wait: block until the run ends, then print what Claude needs to review ----

function waitSummary(current, codexMessage = "") {
  const lines = [`\nRun ${slug}: ${current.state.toUpperCase()}${current.reason ? ` -- ${current.reason}` : ""}`];
  const phases = current.phases || {};
  for (const phase of readPlan().phases) {
    const result = phases[phase.id];
    const carried = result && result.preexisting && result.preexisting.length ? `; pre-existing failures carried over: ${result.preexisting.join(", ")}` : "";
    lines.push(`  Phase ${phase.id} (${phase.title}): ${result ? `${result.verdict} (alignment ${result.alignment || "?"}, checks ${result.checks || "?"}${carried})` : "not verified"}`);
  }
  const baseline = lib.readBaseline(repoRoot, slug);
  const failingBefore = baseline ? Object.entries(baseline.commands || {}).filter(([, result]) => !result.ok).map(([cmd]) => cmd) : [];
  if (failingBefore.length) lines.push(`Already failing before the task (baseline, not caused by it): ${failingBefore.join(", ")}`);
  lines.push(`Reports: .codex/verify/${slug}/  (alignment.md and last.log hold the latest verify)`);
  lines.push(`Log: .codex/autopilot/${slug}.log`);
  if (current.startTree && lib.treeExists(repoRoot, current.startTree)) {
    const files = lib.changedFiles(repoRoot, current.startTree, snapshot(), lib.workflowPaths);
    lines.push(`Changed files (${files.length}):${files.length ? `\n  ${files.join("\n  ")}` : " none"}`);
  }
  if (codexMessage) lines.push(`\nCodex's last message:\n${tail(codexMessage.trim(), 1500).replace(/^/gm, "  ")}`);
  const plan = readPlan();
  if (current.state === "paused") {
    lines.push(`\nNext phase: node .codex/autopilot.js handoff ${planRel} --phase ${current.nextPhase}`);
  } else if (current.state === "done") {
    lines.push(`\nNext (Claude): read the reports and spot-check the diff${plan.meta.ui === "yes" ? ", then build the frontend (## Frontend (Claude)) and audit it with Playwright" : ""}, run the QA pass, then write the task summary and report to the user.`);
  } else {
    lines.push(`\nNext (Claude): explain why it stopped. After a fix, send it back with: node .codex/autopilot.js handoff ${planRel} --continue`);
  }
  return lines.join("\n");
}

// How long Codex may sit idle (or be gone) before `wait` treats the run as stopped.
// Environment overrides exist for tests.
const waitTiming = {
  pollMs: Number(process.env.CCW_WAIT_POLL_MS) || 5000,
  checkMs: Number(process.env.CCW_WAIT_CHECK_MS) || 30 * 1000,
  quietMs: Number(process.env.CCW_WAIT_QUIET_MS) || 60 * 1000,
  graceMs: Number(process.env.CCW_WAIT_GRACE_MS) || 2 * 60 * 1000,
};

const stopReasons = {
  idle: "Codex stopped without finishing the run",
  notLoaded: "the Codex session was closed before the run finished",
  missing: "the Codex session was closed before the run finished",
  systemError: "Codex reported a system error",
};

async function cmdWait() {
  const handoff = readJson(handoffPath) || {};
  const sinceText = flagValue("--since") || (handoff.slug === slug ? handoff.at : "") || new Date().toISOString();
  const since = Date.parse(sinceText);
  const timeoutMs = Number(flagValue("--timeout") || 6 * 60 * 60) * 1000;
  // Watch the Codex session the plan went to, when the handoff knows it.
  const thread = handoff.slug === slug && handoff.via === "codex queue" ? handoff.thread : "";
  const started = Date.now();
  let last = "";
  let lastCheck = 0;
  let strikes = 0;
  let notice = "";
  console.log(`Waiting for ${planRel} (since ${sinceText})${thread ? `, watching Codex session ${thread}` : ""}...`);
  for (;;) {
    const current = readJson(statusPath) || {};
    const mine = current.slug === slug && Date.parse(current.updated || 0) >= since;
    if (mine) {
      const line = `${current.state} | phase ${current.phase || "-"} | ${current.step || "-"}`;
      if (line !== last) console.log(`[${new Date().toISOString()}] ${line}`);
      last = line;
      if (["done", "paused", "stuck", "failed"].includes(current.state)) {
        const message = current.state === "done" || !thread ? "" : ((await lib.codexThreadState(thread)).lastMessage || "");
        console.log(waitSummary(current, message));
        return { done: 0, paused: 0, stuck: exitCodes.stuck, failed: exitCodes.failed }[current.state];
      }
    }

    if (thread && Date.now() - lastCheck >= waitTiming.checkMs && Date.now() - since >= waitTiming.graceMs) {
      lastCheck = Date.now();
      const state = await lib.codexThreadState(thread);
      if (!state.error) {
        const quietSince = mine ? Date.parse(current.updated) : since;
        const quiet = Date.now() - quietSince >= waitTiming.quietMs;
        if (state.status === "active") {
          strikes = 0;
          const waiting = state.flags.includes("waitingOnApproval") ? "approval" : state.flags.includes("waitingOnUserInput") ? "input" : "";
          const text = waiting ? `Codex is waiting for your ${waiting} in its panel (session ${thread}).` : "";
          if (text && text !== notice) console.log(`[${new Date().toISOString()}] ${text}`);
          notice = text;
        } else if (stopReasons[state.status] && quiet) {
          strikes += 1;
        } else {
          strikes = 0;
        }
        if (strikes >= 2 || (state.status === "systemError" && quiet)) {
          return codexStopped(state, mine ? current : null);
        }
      }
    }

    if (Date.now() - started > timeoutMs) {
      console.log(`\nStopped waiting after ${Math.round(timeoutMs / 60000)} min. ${mine ? `Last state: ${last}` : "Codex hasn't started the run yet (no `begin`)."}`);
      return exitCodes.timeout;
    }
    await new Promise((resolve) => setTimeout(resolve, waitTiming.pollMs));
  }
}

// Codex's turn ended (or its session went away) while the run was still going. Mark the run
// stuck so a `handoff --continue` can resume it, and give Claude Codex's last words.
function codexStopped(state, current) {
  const reason = stopReasons[state.status] || `Codex session is ${state.status}`;
  if (!current) {
    console.log(`\nRun ${slug}: NOT STARTED -- ${reason}, and it never ran \`begin\`.`);
    if (state.lastMessage) console.log(`\nCodex's last message:\n${tail(state.lastMessage.trim(), 1500).replace(/^/gm, "  ")}`);
    console.log(`\nNext (Claude): tell the user what Codex said, then hand the plan off again: node .codex/autopilot.js handoff ${planRel}`);
    return exitCodes.stuck;
  }
  status = current;
  logPath = path.join(runDir, `${slug}.log`);
  setStatus({ state: "stuck", reason: `${reason} (last step: ${current.step || "-"}, phase ${current.phase || "-"})` });
  log(`=== stuck: ${status.reason}`);
  console.log(waitSummary(status, state.lastMessage));
  return exitCodes.stuck;
}

// ---- Codex-driven steps ----

// Runs every gate and check once on the untouched starting tree, so later failures that
// were already there don't block the run. "baseline": false in .codex/verify.json skips it.
async function recordBaseline(plan, tree) {
  if (lib.verifyConfig(repoRoot).baseline === false) {
    fs.rmSync(lib.baselinePath(repoRoot, slug), { force: true });
    log("baseline: off (verify.json)");
    return;
  }
  const commands = [...new Set([...plan.phases.flatMap((phase) => phase.gates), ...lib.detectChecks(repoRoot)])];
  if (!commands.length) return;
  log(`baseline: running ${commands.length} gate/check command(s) on the starting tree`);
  const baseline = await lib.recordBaseline(repoRoot, slug, commands, { tree, timeout: callTimeoutMs, env: childEnv });
  const failing = Object.entries(baseline.commands).filter(([, result]) => !result.ok);
  if (!failing.length) {
    log("baseline: every gate and check passes on the starting tree");
    return;
  }
  for (const [cmd, result] of failing) {
    log(`baseline: "${cmd}" already fails before the task (${result.status}, ${result.lines.length} line(s)); those errors won't block the run`);
  }
}

async function cmdBegin() {
  const fresh = ["running", "paused"].includes(status.state) && Date.now() - Date.parse(status.updated || 0) < activeTimeoutMs;
  if (fresh && status.slug !== slug) {
    throw new Usage(`another run (${status.plan}, started by ${status.owner || "unknown"}) is still active in ${path.relative(repoRoot, statusPath)}; finish or stop it first. To work on two tasks at once, use a separate git worktree for each (git worktree add ../<name>).`);
  }
  const plan = readPlan();
  assertPlanValid(plan);
  const start = snapshot();
  status = {};
  setStatus({ slug, plan: planRel, owner: currentOwner(), state: "running", reason: "", phase: "", step: "begin", attempt: 0, startTree: start, phases: {}, inputs: gateInputs() });
  log(`=== autopilot start (Codex-driven): ${planRel}`);
  if (lib.changedFiles(repoRoot, lib.headTree(repoRoot) || start, start).length) {
    log("note: the working tree already had uncommitted changes; they're part of the starting snapshot and won't be reviewed");
  }
  await recordBaseline(plan, start);
  setStatus({ step: "begun" });
  console.log(`\nPhases, in order: ${plan.phases.map((phase) => phase.id).join(", ")}`);
  console.log(`Next: node .codex/autopilot.js phase ${planRel} ${plan.phases[0].id}`);
}


async function cmdPhase() {
  if (status.slug !== slug || !["running", "paused", "stuck", "failed"].includes(status.state)) await cmdBegin();
  requireActive();
  const phase = findPhase(phaseArg);
  const phaseBase = snapshot();
  setStatus({ phase: phase.id, step: "implement", attempt: 0, gateFailures: 0, phaseBase });
  log(`--- phase ${phase.id}: ${phase.title} (starting snapshot ${phaseBase.slice(0, 7)})`);
  console.log(`Implement phase ${phase.id}, then run: node .codex/autopilot.js verify ${planRel} ${phase.id}`);
  console.log(`If you can't finish it within its scope, run: node .codex/autopilot.js stop ${planRel} --reason "<what blocks it>"`);
}

async function cmdVerify() {
  requireActive();
  const phase = findPhase(phaseArg);
  if (status.phase !== phase.id || !lib.treeExists(repoRoot, status.phaseBase)) {
    throw new Usage(`phase ${phase.id} wasn't started; run \`node .codex/autopilot.js phase ${planRel} ${phase.id}\` first`);
  }
  const gate = await runGates(phase);
  if (!gate.ok) {
    const failures = (status.gateFailures || 0) + 1;
    if (failures >= maxGateFailures) {
      throw new Stop("stuck", `phase ${phase.id}: gate "${gate.gate}" still fails after ${failures} tries:\n${tail(gate.summary, 2000)}`);
    }
    setStatus({ step: "gate-failed", gateFailures: failures });
    console.log(`\nGATE FAILED (try ${failures} of ${maxGateFailures}): ${gate.gate}\n${gate.summary}`);
    console.log(`\nFix the new failures within the phase's scope, then run verify again.`);
    console.log(`If that needs files outside the phase, a dependency install or anything else you can't do here, don't end your turn without saying so. Run:\n  node .codex/autopilot.js stop ${planRel} --reason "<what blocks it>"`);
    return exitCodes.gate;
  }
  setStatus({ step: "verify", gateFailures: 0 });
  if (verify(phase, status.phaseBase, gate.preexisting)) {
    setStatus({ step: "verified" });
    const phases = readPlan().phases;
    const next = phases[phases.findIndex((candidate) => candidate.id === phase.id) + 1];
    const handoff = readJson(handoffPath) || {};
    if (next && handoff.plan === planRel && handoff.phase === phase.id) {
      setStatus({ state: "paused", nextPhase: next.id });
      console.log(`\nVERDICT: PASS\nPAUSED\nNext: node .codex/autopilot.js handoff ${planRel} --phase ${next.id}`);
      return 0;
    }
    console.log(`\nVERDICT: PASS\nNext: node .codex/autopilot.js ${next ? `phase ${planRel} ${next.id}` : `close ${planRel}`}`);
    return 0;
  }
  const attempt = (status.attempt || 0) + 1;
  if (attempt > maxReworks) {
    throw new Stop("stuck", `phase ${phase.id} still needs rework after ${maxReworks} attempts; see ${taskFileRel("alignment.md")}`);
  }
  setStatus({ step: "rework", attempt });
  console.log(`\nVERDICT: NEEDS REWORK (rework attempt ${attempt} of ${maxReworks})\n`);
  console.log(readFile(taskFile("alignment.md")));
  console.log("\nFix every MISSING, PARTIAL and MUST FIX item and every failing check, and undo every OUT OF SCOPE change, within the phase's scope. Then run verify again.");
  return exitCodes.rework;
}

// Codex runs this whenever it has to stop before `close`, so Claude's `wait` hears about it.
function cmdStop() {
  if (status.slug !== slug || !["running", "paused", "stuck", "failed"].includes(status.state)) {
    throw new Usage(`no active run for ${planRel}`);
  }
  const reason = flagValue("--reason") || "Codex stopped (no reason given)";
  throw new Stop("stuck", `${reason} (at phase ${status.phase || "-"}, step ${status.step || "-"})`);
}

async function cmdClose() {
  requireActive();
  const result = await close();
  if (result) return result;
  setStatus({ state: "done", step: "done", phase: "" });
  log(`=== done: ${planRel}. Nothing was committed; review the changes and commit them yourself.`);
  console.log(`\nTask ${slug} done. Claude reviews it next; then review and commit the changes.`);
}

async function main() {
  if (!command) usage();
  if (!planArg || (["phase", "verify"].includes(command) && !phaseArg)) usage();
  const planPath = path.resolve(planArg);
  planRel = path.relative(repoRoot, planPath).split(path.sep).join("/");
  if (!lib.planPattern.test(planRel) || !fs.existsSync(planPath)) {
    console.error(`not a plan file under ${lib.plansRel}/: ${planArg}`);
    process.exit(exitCodes.failed);
  }
  slug = path.basename(planRel, ".md");

  if (command === "check") {
    process.exit(printChecklist(readPlan()) ? exitCodes.failed : 0);
  }

  fs.mkdirSync(runDir, { recursive: true });
  if (command === "handoff" || command === "wait") {
    process.exitCode = command === "handoff" ? await cmdHandoff() : await cmdWait();
    return;
  }

  logPath = path.join(runDir, `${slug}.log`);
  status = readJson(statusPath) || {};
  const steps = { begin: cmdBegin, review: cmdReview, phase: cmdPhase, verify: cmdVerify, stop: cmdStop, close: cmdClose };
  try {
    process.exitCode = (await steps[command]()) || 0;
  } catch (error) {
    if (error instanceof Usage) {
      console.error(error.message);
      process.exitCode = exitCodes.failed;
      return;
    }
    const stop = error instanceof Stop ? error : new Stop("failed", error.stack || String(error));
    setStatus({ state: stop.state, reason: stop.message });
    log(`=== ${stop.state}: ${stop.message}`);
    console.error(`\n${stop.state.toUpperCase()}: ${stop.message}`);
    process.exitCode = exitCodes[stop.state] || exitCodes.failed;
  }
}

main();
