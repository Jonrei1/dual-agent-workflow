"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setupPlaywright, resolveInstallation } = require("../skills/claude-codex-workflow/scripts/playwright");

function fixture(options = {}) {
  const calls = [];
  const records = [];
  const prompts = [];
  const installation = {
    version: "test-version",
    server: "C:/Tool Folder/mcp/cli.js",
    cli: "C:/Tool Folder/mcp/node_modules/playwright/cli.js",
    browser: "C:/Browser Cache/chromium/chrome.exe",
  };
  let packageReady = Boolean(options.packageReady);
  let browserReady = Boolean(options.browserReady);
  const registered = new Set(options.registered || []);
  const env = {
    dryRun: Boolean(options.dryRun),
    has: (command) => !(options.missingClients || []).includes(command),
    exists: (file) => file === installation.browser && browserReady,
    resolve: () => {
      if (!packageReady) throw new Error("package missing");
      return installation;
    },
    confirm: async (question) => {
      prompts.push(question);
      return options.approved !== false;
    },
    record: (step, ok, note) => records.push({ step, ok, note }),
    run: (command, args, settings = {}) => {
      calls.push({ command, args, settings });
      if (args[0] === "root") return { status: options.rootFails ? 1 : 0, stdout: "C:/Tool Folder\n" };
      if (args[1] === "get") return { status: registered.has(args[2]) ? 0 : 1 };
      if (command === "npm") {
        packageReady = !options.packageFails;
        return { status: packageReady ? 0 : 1 };
      }
      if (command === process.execPath) {
        browserReady = !options.browserFails;
        return { status: browserReady ? 0 : 1 };
      }
      if (args[1] === "add") {
        if (args[4] === options.registrationFails) return { status: 1 };
        registered.add(args[4]);
        return { status: 0 };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  return { env, calls, records, prompts, installation };
}

const registrations = (f) => f.calls.filter((call) => call.command === "claude" && call.args[1] === "add");

test("only Claude gets Playwright, since Claude does the UI audits", async () => {
  const f = fixture();
  await setupPlaywright(f.env);
  const writes = f.calls.filter((call) => call.args[0] !== "root" && call.args[1] !== "get");
  assert.deepEqual(writes.map((call) => call.command), ["npm", process.execPath, "claude", "claude"]);
  assert.ok(!f.calls.some((call) => call.command === "codex"));
  assert.ok(f.records.every((record) => record.ok === true));
});

test("first setup installs the server and matching browser, then registers a headless and a headed server", async () => {
  const f = fixture();
  await setupPlaywright(f.env);
  const writes = f.calls.filter((call) => call.args[0] !== "root" && call.args[1] !== "get");
  assert.deepEqual(writes[0].args, ["install", "-g", "@playwright/mcp"]);
  assert.deepEqual(writes[1].args, [f.installation.cli, "install", "chromium"]);
  const [headless, headed] = registrations(f);
  assert.deepEqual(headless.args.slice(0, 6), ["mcp", "add", "--scope", "user", "playwright", "--"]);
  assert.deepEqual(headless.args.slice(-6), [process.execPath, f.installation.server, "--executable-path", f.installation.browser, "--headless", "--isolated"]);
  assert.deepEqual(headed.args.slice(0, 6), ["mcp", "add", "--scope", "user", "playwright-headed", "--"]);
  assert.deepEqual(headed.args.slice(-5), [process.execPath, f.installation.server, "--executable-path", f.installation.browser, "--isolated"]);
  assert.ok(!headed.args.includes("--headless"), "the headed server opens a visible window");
  assert.equal(f.prompts.length, 1);
  assert.ok(f.records.every((record) => record.ok === true));
});

test("repeat setup reuses packages and browser and preserves registrations without prompting", async () => {
  const f = fixture();
  await setupPlaywright(f.env);
  f.calls.length = 0;
  f.prompts.length = 0;
  await setupPlaywright(f.env);
  assert.deepEqual(f.calls.map((call) => call.args[0]), ["root", "mcp", "mcp"]);
  assert.deepEqual(f.calls.map((call) => call.args[2]), [undefined, "playwright", "playwright-headed"]);
  assert.equal(f.prompts.length, 0);
});

test("an existing registration is kept and only the missing server is added", async () => {
  const f = fixture({ packageReady: true, browserReady: true, registered: ["playwright"] });
  await setupPlaywright(f.env);
  assert.deepEqual(registrations(f).map((call) => call.args[4]), ["playwright-headed"]);
  assert.ok(f.records.some((record) => record.step === "Playwright (claude)" && /kept/.test(record.note)));
});

test("dry run performs no commands, prompts or configuration writes", async () => {
  const f = fixture({ dryRun: true });
  await setupPlaywright(f.env);
  assert.equal(f.calls.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.records[0].ok, null);
});

test("declined setup reports incomplete work without mutating machine configuration", async () => {
  const f = fixture({ approved: false });
  await setupPlaywright(f.env);
  assert.ok(f.calls.every((call) => call.args[0] === "root" || call.args[1] === "get"));
  assert.ok(f.records.some((record) => record.ok === false));
});

test("download failure prevents registrations that point to a missing browser", async () => {
  const f = fixture({ browserFails: true });
  await setupPlaywright(f.env);
  assert.equal(f.calls.filter((call) => call.args[1] === "add").length, 0);
  assert.ok(f.records.some((record) => record.step === "Playwright Chromium" && record.ok === false));
});

test("package failure prevents browser download and MCP registration", async () => {
  const f = fixture({ packageFails: true });
  await setupPlaywright(f.env);
  assert.equal(f.calls.filter((call) => call.command === process.execPath || call.args[1] === "add").length, 0);
  assert.ok(f.records.some((record) => record.step === "Playwright MCP" && record.ok === false));
});

test("one registration failure is reported without preventing the other server", async () => {
  const f = fixture({ registrationFails: "playwright" });
  await setupPlaywright(f.env);
  assert.ok(f.records.some((record) => record.step === "Playwright (claude)" && record.ok === false));
  assert.ok(f.records.some((record) => record.step === "Playwright headed (claude)" && record.ok === true));
});

test("a missing Claude CLI is reported and nothing is registered", async () => {
  const f = fixture({ missingClients: ["claude"] });
  await setupPlaywright(f.env);
  assert.ok(f.calls.every((call) => call.command !== "claude"));
  assert.ok(f.records.some((record) => record.step === "Playwright (claude)" && record.ok === false));
});

test("npm root failure produces an actionable failure and makes no installations", async () => {
  const f = fixture({ rootFails: true });
  await setupPlaywright(f.env);
  assert.equal(f.calls.length, 1);
  assert.equal(f.records[0].ok, false);
});

test("resolution uses the MCP dependency rather than another global Playwright version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-playwright-test-"));
  try {
    const mcp = path.join(root, "@playwright", "mcp");
    const dependency = path.join(mcp, "node_modules", "playwright");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(mcp, "package.json"), JSON.stringify({ version: "fixture", bin: { "playwright-mcp": "cli.js" } }));
    fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ main: "index.js" }));
    fs.writeFileSync(path.join(dependency, "index.js"), 'module.exports = { chromium: { executablePath: () => "matching-browser" } };');
    const installed = resolveInstallation(root);
    assert.equal(installed.cli, path.join(dependency, "cli.js"));
    assert.equal(installed.server, path.join(mcp, "cli.js"));
    assert.equal(installed.browser, "matching-browser");
  } finally {
    // Only this test's newly created directory is removed.
    fs.rmSync(root, { recursive: true, force: true });
  }
});
