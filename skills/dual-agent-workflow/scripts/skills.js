"use strict";

// Installs the agent skills the workflow's rules lean on, as per-user plugins for the agents
// the project uses (both, or only Claude or only Codex). Nothing is written to the project. A
// bare skill folder doesn't load always-on rules (they come from plugin hooks), which is why
// these are plugins.
//
//   ponytail    senior-dev and QA mode: the smallest change that solves the task, plus
//               /ponytail-review. Codex builds in it; Claude uses it for planning and review.
//   taste-skill UI/UX art direction for whichever agent builds the frontend.
//   caveman     terse replies with full technical substance: fewer output tokens per turn,
//               which matters most when one agent carries the whole task.
// `codex` overrides the marketplace repo and plugin id for Codex; a missing repo means the
// plugin comes from a marketplace Codex already has.
const SKILLS = [
  { name: "ponytail", repo: "DietrichGebert/ponytail", id: "ponytail@ponytail" },
  { name: "taste-skill", repo: "Leonxlnx/taste-skill", id: "taste-skill@taste-skill" },
  { name: "caveman", repo: "JuliusBrussee/caveman", id: "caveman@caveman", codex: { repo: "", id: "caveman@openai-curated-remote" } },
];

const forClient = (skill, client) => ({ ...skill, ...(skill[client] || {}) });

function claudeHas(run, id) {
  const listed = run("claude", ["plugin", "list", "--json"], { timeout: 60 * 1000 });
  if (listed.status !== 0) return false;
  try {
    return JSON.parse(listed.stdout).some((plugin) => plugin && plugin.id === id);
  } catch {
    return false;
  }
}

// `codex plugin list` also lists plugins it could install, marked "not installed".
function codexHas(run, id) {
  const listed = run("codex", ["plugin", "list"], { timeout: 60 * 1000 });
  if (listed.status !== 0) return false;
  return (listed.stdout || "").split(/\r?\n/).some((line) => line.trim().startsWith(`${id} `) && /installed/.test(line) && !/not installed/.test(line));
}

function output(result) {
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

// Adds the marketplace (an "already added" failure is fine) and installs the plugin.
function installOne(run, client, skill) {
  if (skill.repo) {
    const add = run(client, ["plugin", "marketplace", "add", skill.repo], { timeout: 5 * 60 * 1000 });
    if (add.status !== 0 && !/already/i.test(output(add))) return { ok: false, note: `adding ${skill.repo} failed: ${output(add).split(/\r?\n/)[0] || `exit ${add.status}`}` };
  }
  const install = client === "claude"
    ? run("claude", ["plugin", "install", skill.id, "--scope", "user"], { timeout: 5 * 60 * 1000 })
    : run("codex", ["plugin", "add", skill.id], { timeout: 5 * 60 * 1000 });
  if (install.status !== 0 && !/already/i.test(output(install))) return { ok: false, note: `install failed: ${output(install).split(/\r?\n/)[0] || `exit ${install.status}`}` };
  return { ok: true };
}

async function setupSkills({ run, has, confirm, record, dryRun, clients: wanted = ["claude", "codex"] }) {
  const clients = wanted.filter((client) => {
    if (has(client)) return true;
    record(`Skills (${client})`, false, `install ${client} first, then re-run setup`);
    return false;
  });
  if (dryRun) {
    record("Skills", null, `would install ${SKILLS.map((skill) => skill.name).join(", ")} as user plugins for ${clients.join(" and ") || "no agent"}`);
    return;
  }
  const missing = [];
  for (const client of clients) {
    for (const skill of SKILLS.map((entry) => forClient(entry, client))) {
      const present = client === "claude" ? claudeHas(run, skill.id) : codexHas(run, skill.id);
      if (present) record(`${skill.name} (${client})`, true, "already installed");
      else missing.push({ client, skill });
    }
  }
  if (!missing.length) return;
  const names = missing.map(({ client, skill }) => `${skill.name} for ${client}`).join(", ");
  if (!(await confirm(`Install ${names} as user plugins?`))) {
    record("Skills", false, `${names} missing; re-run with --yes (or --skip-skills to opt out)`);
    return;
  }
  for (const { client, skill } of missing) {
    const result = installOne(run, client, skill);
    record(`${skill.name} (${client})`, result.ok,
      result.ok ? `installed${client === "codex" ? "; trust its hooks in Codex (/hooks) and start a new thread" : "; restart Claude Code"}` : result.note);
  }
}

module.exports = { setupSkills, SKILLS };
