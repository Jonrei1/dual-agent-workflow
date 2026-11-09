"use strict";

// Stand-in for the codex CLI in handoff tests: node fake-codex.js <config.json> <codex args...>
// config: { threadsFile, argsFile, queueCode, proxyCode }.
// - `app-server proxy` answers the WebSocket upgrade and the JSON-RPC calls the handoff makes,
//   serving the threads listed in threadsFile (missing file = no threads).
// - `queue ...` records its arguments in argsFile and exits with queueCode.

const fs = require("node:fs");
const path = require("node:path");
const lib = require(path.join(__dirname, "..", "..", "skills", "dual-agent-workflow", "templates", "codex", "hooks", "workflow-lib"));

const [configFile, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));

function threads() {
  try {
    return JSON.parse(fs.readFileSync(config.threadsFile, "utf8")).map((thread) => {
      if (!config.audit) return thread;
      const base = path.join(thread.cwd, ".codex", "verify");
      for (const task of fs.existsSync(base) ? fs.readdirSync(base) : []) {
        const request = path.join(base, task, "code-audit-request.md");
        if (!fs.existsSync(request)) continue;
        const token = /AUDIT ([a-f0-9-]+)/.exec(fs.readFileSync(request, "utf8"))?.[1];
        if (token) return { ...thread, turns: [{ items: [{ type: "agentMessage", text: `AUDIT ${token}\n${JSON.stringify(config.audit)}` }] }] };
      }
      return thread;
    });
  } catch {
    return [];
  }
}

if (args[0] === "exec") {
  fs.writeFileSync(config.argsFile, JSON.stringify(args));
  const prompt = fs.readFileSync(0, "utf8");
  fs.writeFileSync(config.argsFile + ".prompt", prompt);
  if (args.includes("-o")) {
    const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
    fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(config.review || { findings: [], verdict: schema.properties.verdict.enum.includes("PASS") ? "PASS" : "APPROVE" }));
  } else if (config.execute && !config.execCode) {
    const plan = /\.codex\/plans\/[^\s.]+\.md/.exec(prompt)[0];
    const phases = lib.parsePhases(fs.readFileSync(plan, "utf8"));
    const selected = /[Ii]mplement only phase (\S+) of/.exec(prompt)?.[1];
    for (const phase of phases.filter((phase) => !selected || selected === phase.id)) {
      const target = phase.scope.trim().replace(/`/g, "");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "exports.implemented = true;\n");
    }
  }
  process.exit(config.execCode || 0);
}

if (args[0] === "queue") {
  fs.writeFileSync(config.argsFile, args.join(" "));
  process.exit(config.queueCode || 0);
}

if (args[0] === "app-server" && args[1] === "proxy") {
  if (config.proxyCode) {
    process.stderr.write("Error: failed to connect to the app-server control socket\n");
    process.exit(config.proxyCode);
  }
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const reply = (message) => process.stdout.write(lib.encodeFrame(JSON.stringify(message), { mask: false }));
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      process.stdout.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    }
    const { frames, rest } = lib.decodeFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const message = JSON.parse(frame.text);
      if (message.id === undefined) continue;
      if (message.method === "initialize") reply({ id: message.id, result: {} });
      else if (message.method === "thread/loaded/list") reply({ id: message.id, result: { data: threads().map((thread) => thread.id), nextCursor: null } });
      else if (message.method === "thread/read") {
        const thread = threads().find((candidate) => candidate.id === message.params.threadId);
        reply(thread ? { id: message.id, result: { thread } } : { id: message.id, error: { code: -32600, message: "thread not loaded" } });
      } else reply({ id: message.id, error: { code: -32601, message: "unknown method" } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  process.exit(0);
}
