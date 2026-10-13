"use strict";

// Every test file gets its own empty Codex home, so the installer (and the Impeccable plugin
// repair in particular) can never touch the developer's real ~/.codex while tests run.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-codex-home-"));
