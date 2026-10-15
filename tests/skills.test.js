"use strict";

const assert = require("node:assert/strict");
const { setupSkills, SKILLS } = require("../skills/claude-codex-workflow/scripts/skills");

// Fakes the claude and codex plugin CLIs. `installed` lists "<client>:<plugin id>" entries.
function fixture(options = {}) {
  const calls = [];
  const records = [];
  const prompts = [];
  const installed = new Set(options.installed || []);
  const env = {
    dryRun: Boolean(options.dryRun),
    has: (command) => !(options.missingClients || []).includes(command),
    confirm: async (question) => {
      prompts.push(question);
      return options.approved !== false;
    },
    record: (step, ok, note) => records.push({ step, ok, note }),
    run: (command, args) => {
      calls.push({ command, args });
      const line = `${command} ${args.join(" ")}`;
      if (command === "claude" && args[1] === "list") {
        return { status: 0, stdout: JSON.stringify([...installed].filter((id) => id.startsWith("claude:")).map((id) => ({ id: id.slice(7), scope: "user" }))) };
      }
      if (command === "codex" && args[1] === "list") {
        return { status: 0, stdout: `PLUGIN  STATUS  VERSION  SOURCE\n${[...installed].filter((id) => id.startsWith("codex:")).map((id) => `${id.slice(6)}  installed, enabled  1.0.0  x`).join("\n")}\n` };
      }
      if (args.includes("marketplace")) return options.marketplaceFails ? { status: 1, stderr: "network down" } : { status: 0, stdout: "" };
      if (line.startsWith("claude plugin install") || line.startsWith("codex plugin add")) {
        if (options.installFails === command) return { status: 1, stderr: "boom\nmore" };
        installed.add(`${command}:${args.find((arg) => arg.includes("@"))}`);
        return { status: 0, stdout: "" };
      }
      throw new Error(`Unexpected command: ${line}`);
    },
  };
  return { env, calls, records, prompts, installed };
}

const writes = (f) => f.calls.filter((call) => !["list"].includes(call.args[1]));

test("the plugins are ponytail and taste-skill from their own marketplaces", () => {
  assert.deepEqual(SKILLS.map((skill) => [skill.id, skill.repo]), [["ponytail@ponytail", "DietrichGebert/ponytail"], ["taste-skill@taste-skill", "Leonxlnx/taste-skill"]]);
});

test("a first run adds both marketplaces and installs both plugins for Claude and Codex, after one question", async () => {
  const f = fixture();
  await setupSkills(f.env);
  const lines = writes(f).map((call) => `${call.command} ${call.args.join(" ")}`);
  assert.deepEqual(lines, [
    "claude plugin marketplace add DietrichGebert/ponytail",
    "claude plugin install ponytail@ponytail --scope user",
    "claude plugin marketplace add Leonxlnx/taste-skill",
    "claude plugin install taste-skill@taste-skill --scope user",
    "codex plugin marketplace add DietrichGebert/ponytail",
    "codex plugin add ponytail@ponytail",
    "codex plugin marketplace add Leonxlnx/taste-skill",
    "codex plugin add taste-skill@taste-skill",
  ]);
  assert.equal(f.prompts.length, 1);
  assert.ok(f.records.every((record) => record.ok === true));
  assert.match(f.records.find((record) => record.step === "ponytail (codex)").note, /trust its hooks/);
});

test("existing plugins are kept: nothing is asked or installed on a repeat run", async () => {
  const f = fixture();
  await setupSkills(f.env);
  f.calls.length = 0;
  f.prompts.length = 0;
  f.records.length = 0;
  await setupSkills(f.env);
  assert.equal(writes(f).length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.records.filter((record) => record.note === "already installed").length, 4);
});

test("only the missing plugin of a client is installed", async () => {
  const f = fixture({ installed: ["claude:ponytail@ponytail", "claude:taste-skill@taste-skill", "codex:ponytail@ponytail"] });
  await setupSkills(f.env);
  const lines = writes(f).map((call) => `${call.command} ${call.args.join(" ")}`);
  assert.deepEqual(lines, ["codex plugin marketplace add Leonxlnx/taste-skill", "codex plugin add taste-skill@taste-skill"]);
});

test("dry run performs no installs and no prompts", async () => {
  const f = fixture({ dryRun: true });
  await setupSkills(f.env);
  assert.equal(writes(f).length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.records.at(-1).ok, null);
  assert.match(f.records.at(-1).note, /ponytail@ponytail and taste-skill@taste-skill/);
});

test("declined setup reports what is missing and changes nothing", async () => {
  const f = fixture({ approved: false });
  await setupSkills(f.env);
  assert.equal(writes(f).length, 0);
  assert.ok(f.records.some((record) => record.ok === false && /--skip-skills/.test(record.note)));
});

test("a missing client is reported while the other one still gets the plugins", async () => {
  const f = fixture({ missingClients: ["codex"] });
  await setupSkills(f.env);
  assert.ok(f.calls.every((call) => call.command === "claude"));
  assert.ok(f.records.some((record) => record.step === "Skills (codex)" && record.ok === false));
  assert.ok(f.records.some((record) => record.step === "ponytail (claude)" && record.ok === true));
});

test("an install failure is reported with its first line and doesn't stop the other plugins", async () => {
  const f = fixture({ installFails: "claude" });
  await setupSkills(f.env);
  assert.ok(f.records.some((record) => record.step === "ponytail (claude)" && record.ok === false && /install failed: boom$/.test(record.note)));
  assert.ok(f.records.some((record) => record.step === "taste-skill (codex)" && record.ok === true));
});

test("a failed marketplace add is reported unless it was already added", async () => {
  const f = fixture({ marketplaceFails: true });
  await setupSkills(f.env);
  assert.ok(f.records.filter((record) => record.step.endsWith("(claude)")).every((record) => record.ok === false && /adding .* failed: network down/.test(record.note)));
  const g = fixture();
  const run = g.env.run;
  g.env.run = (command, args) => (args.includes("marketplace") ? { status: 1, stderr: "marketplace already added" } : run(command, args));
  await setupSkills(g.env);
  assert.ok(g.records.every((record) => record.ok === true));
});
