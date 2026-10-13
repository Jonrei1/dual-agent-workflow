"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lib = require("../skills/claude-codex-workflow/templates/codex/hooks/workflow-lib");

// A NUL byte in an argument makes spawn throw synchronously, before any timer exists. That path
// used to reach clearTimeout(timer) inside the temporal dead zone and reject the promise.
test("runClaudeAsync resolves with the error when spawn throws synchronously", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-lib-"));
  const result = await lib.runClaudeAsync(repo, { name: "alignment", task: "t", prompt: "a\0b", model: "sonnet", effort: "low", allowed: ["Read"], timeout: 1000 });
  assert.ok(result.error, "the spawn error is returned");
  assert.strictEqual(result.status, null);
  assert.match(fs.readFileSync(path.join(repo, ".codex", "verify", "usage.jsonl"), "utf8"), /"name":"alignment".*"ok":false/);
});

test("runShellAsync resolves { ok: false } when spawn throws synchronously", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-lib-"));
  const result = await lib.runShellAsync(repo, "echo a\0b", { timeout: 1000 });
  assert.strictEqual(result.ok, false);
  assert.ok(result.status);
});
