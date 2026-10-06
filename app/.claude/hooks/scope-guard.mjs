#!/usr/bin/env node
// Scope guard for Epoch's frontend (runs before Edit / Write / MultiEdit / NotebookEdit).
// Claude Code is started inside the repo's app/ folder, so CLAUDE_PROJECT_DIR is .../epoch-protocol/app.
// Blocks (exit code 2; stderr goes back to Claude): any write whose REAL path (symlinks resolved, so
// node_modules/@epoch/epoch-sdk → packages/ is caught) is outside app/, env files other than .env.example,
// and keypair files. Best-effort guard rails, not a sandbox.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const real = (p) => {
  let cur = path.resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    return path.join(realpathSync(cur), ...rest);
  } catch {
    return path.resolve(p);
  }
};

const root = real(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const toolInput = input.tool_input || {};
const target = toolInput.file_path || toolInput.notebook_path || toolInput.path;
if (!target) process.exit(0);

const abs = real(path.resolve(input.cwd || root, target));
const rel = path.relative(root, abs);
const outside = rel.startsWith("..") || path.isAbsolute(rel);

const block = (why) => {
  process.stderr.write(
    `BLOCKED by app/.claude/hooks/scope-guard.mjs: ${why}\n` +
      `Target: ${abs}\n` +
      "Frontend work stays inside app/. If the backend, the program or CI needs a change, " +
      "write the request in handover/BACKEND-REQUESTS.md and tell the human.\n"
  );
  process.exit(2);
};

if (outside) block("this file is outside app/ (backend, program, tests and root configs belong to Sushant).");
if (rel.split(path.sep)[0] === "node_modules") block("never edit installed packages; change our own code instead.");

const base = path.basename(abs);
if (/^\.env(\..*)?$/.test(base) && base !== ".env.example") {
  block("env files hold secrets and are never written by Claude. Put variable NAMES in .env.example only.");
}
if (/keypair.*\.json$/i.test(base) || base === "id.json") {
  block("keypair or wallet files must never be created in the repo.");
}

process.exit(0);
