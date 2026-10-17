"use strict";

const fs = require("node:fs");
// Use the MCP package's Playwright dependency so the downloaded browser matches it.
const { resolvePlaywright: resolveInstallation } = require("../templates/codex/hooks/workflow-lib");

// Claude builds every frontend and audits it itself, so Playwright is registered for Claude only, twice:
// `playwright` runs headless, `playwright-headed` opens a visible window so the user can watch.
// Claude picks one per UI plan after asking the user.
const SERVERS = [
  { name: "playwright", step: "Playwright (claude)", headless: true },
  { name: "playwright-headed", step: "Playwright headed (claude)", headless: false },
];

async function setupPlaywright({ run, has, confirm, record, dryRun, resolve = resolveInstallation, exists = fs.existsSync }) {
  if (dryRun) {
    record("Playwright MCP", null, "would install missing global @playwright/mcp, download its matching Chromium, and register missing playwright (headless) and playwright-headed servers for Claude (user scope)");
    return;
  }
  const globalRoot = run("npm", ["root", "-g"], { timeout: 60 * 1000 });
  if (globalRoot.status !== 0 || !(globalRoot.stdout || "").trim()) {
    record("Playwright MCP", false, "cannot locate global npm packages; check npm root -g");
    return;
  }
  const root = globalRoot.stdout.trim();
  let installed;
  try { installed = resolve(root); } catch { /* missing or incomplete package */ }
  const missing = [];
  if (!has("claude")) {
    record("Playwright (claude)", false, "install claude first, then re-run setup");
  } else {
    for (const server of SERVERS) {
      if (run("claude", ["mcp", "get", server.name], { timeout: 60 * 1000 }).status === 0) {
        record(server.step, true, "existing registration kept; check /mcp for connection status");
      } else {
        missing.push(server);
      }
    }
  }
  if ((!installed || !exists(installed.browser) || missing.length) &&
      !(await confirm("Set up Playwright (global @playwright/mcp, matching Chromium download, and missing user MCP registrations)?"))) {
    record("Playwright setup", false, "incomplete; re-run with --yes to install Chromium and register the MCP tools");
    return;
  }
  if (!installed) {
    const result = run("npm", ["install", "-g", "@playwright/mcp"], { inherit: true });
    if (result.status !== 0) {
      record("Playwright MCP", false, "npm install -g @playwright/mcp failed");
      return;
    }
    try { installed = resolve(root); } catch (error) {
      record("Playwright MCP", false, `cannot resolve installed package: ${error.message}`);
      return;
    }
  }
  record("Playwright MCP", true, installed.version);
  if (!exists(installed.browser)) {
    const result = run(process.execPath, [installed.cli, "install", "chromium"], { inherit: true });
    if (result.status !== 0 || !exists(installed.browser)) {
      record("Playwright Chromium", false, "browser download failed; re-run setup. Linux may also need Playwright system dependencies (see README)");
      return;
    }
  }
  record("Playwright Chromium", true, "matching browser installed");
  // Absolute Node/server/browser paths avoid npx downloads and Windows .cmd launch issues.
  for (const server of missing) {
    const serverArgs = [installed.server, "--executable-path", installed.browser, ...(server.headless ? ["--headless"] : []), "--isolated"];
    const result = run("claude", ["mcp", "add", "--scope", "user", server.name, "--", process.execPath, ...serverArgs], { inherit: true });
    record(server.step, result.status === 0,
      result.status === 0 ? "registered; restart Claude Code and check /mcp" : "registration failed; re-run setup");
  }
}

module.exports = { setupPlaywright, resolveInstallation };
