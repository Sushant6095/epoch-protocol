#!/usr/bin/env node
// Shell and git guard for Epoch's frontend (runs before every Bash command Claude Code executes).
// Blocks (exit code 2; the message on stderr goes back to Claude):
//   • shell writes that resolve outside app/ into the rest of the monorepo — relative, absolute, via `cd ..`,
//     or through symlinks (rm, mv, cp/ln/rsync destinations, sed -i, tee, touch, mkdir, chmod, redirects …)
//   • git that touches files outside app/ (git -C elsewhere, git rm/checkout/restore/clean/mv with outside paths,
//     git add of outside paths except the root pnpm-lock.yaml), `git add -A/-u`, `git commit -a`
//   • pushes to main/master, force pushes, commits while on main/master
//   • npm/yarn installs (the repo is pnpm-only) and pnpm writes to the workspace root (-w)
// Reading outside app/ (cat, grep, ls, cp FROM there) stays allowed. Best-effort guard rails, not a sandbox.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}
const cmd = String((input.tool_input && input.tool_input.command) || "");
if (!cmd.trim()) process.exit(0);

const block = (why) => {
  process.stderr.write(`BLOCKED by app/.claude/hooks/git-guard.mjs: ${why}\nCommand: ${cmd}\n`);
  process.exit(2);
};

// Resolve a path through symlinks even when it does not exist yet (walk up to the nearest existing parent).
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
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const cwd0 = input.cwd || process.cwd();
const appDir = real(process.env.CLAUDE_PROJECT_DIR || cwd0);
let repoRoot = path.dirname(appDir);
try {
  repoRoot = real(execSync("git rev-parse --show-toplevel", { cwd: appDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim());
} catch {}
const lockfile = path.join(repoRoot, "pnpm-lock.yaml");

// Outside = inside the monorepo but not inside app/. Paths elsewhere (/tmp, ~/.claude) are not this guard's business.
const isOutside = (arg, base) => {
  if (!arg || arg.startsWith("-") || /^[a-z]+:\/\//i.test(arg)) return false;
  const expanded = arg.startsWith("~") ? path.join(os.homedir(), arg.slice(1)) : arg;
  const abs = real(path.resolve(base, expanded));
  return inside(abs, repoRoot) && !inside(abs, appDir);
};

// Split into simple commands, keeping quoted strings together; track `cd` so later segments resolve correctly.
const segments = cmd.split(/\n|;|&&|\|\||\|/).map((s) => s.trim()).filter(Boolean);
const tokenize = (s) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

const WRITE_ALL = new Set(["rm", "rmdir", "unlink", "touch", "mkdir", "truncate", "chmod", "chown", "tee", "mv", "shred"]);
const WRITE_DEST = new Set(["cp", "ln", "install", "rsync"]);
const GIT_READONLY = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "grep", "branch", "remote", "fetch"]);

let base = cwd0;
for (const seg of segments) {
  const words = tokenize(seg);
  if (!words.length) continue;

  // redirects: >file, > file, >>file, 2> file
  for (let i = 0; i < words.length; i++) {
    const m = words[i].match(/^\d?>{1,2}(.*)$/);
    if (!m) continue;
    const target = m[1] || words[i + 1];
    if (target && !target.startsWith("&") && isOutside(target, base)) block("a redirect writes outside app/.");
  }

  let [bin, ...args] = words;
  if (bin === "sudo") [bin, ...args] = args;
  const plain = args.filter((a) => !a.startsWith("-"));

  if (bin === "cd" || bin === "pushd") {
    const target = plain[0] ?? os.homedir();
    base = path.resolve(base, target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target);
    continue;
  }
  if (WRITE_ALL.has(bin) && plain.some((a) => isOutside(a, base))) {
    block(`\`${bin}\` would change files outside app/. Backend, program, docs and root configs belong to Sushant; put the request in handover/BACKEND-REQUESTS.md.`);
  }
  if (WRITE_DEST.has(bin) && plain.length && isOutside(plain[plain.length - 1], base)) {
    block(`\`${bin}\` would write outside app/. Copy FROM there if you need to, never INTO it.`);
  }
  if (bin === "sed" && args.some((a) => /^-i/.test(a) || a === "--in-place") && plain.slice(1).some((a) => isOutside(a, base))) {
    block("`sed -i` would edit a file outside app/.");
  }
  if ((bin === "npm" && /^(i|install|add|ci|uninstall|remove)$/.test(plain[0] ?? "")) || (bin === "yarn" && plain.length)) {
    block("this repo is pnpm-only. Use `pnpm --filter app add <pkg>` (or `pnpm add <pkg>` from app/).");
  }
  if (bin === "pnpm" && args.some((a) => a === "-w" || a === "--workspace-root") && /^(add|remove|rm|install|i|up|update)$/.test(plain[0] ?? "")) {
    block("pnpm -w changes the workspace root package.json. Add libraries to app only: `pnpm --filter app add <pkg>`.");
  }

  if (bin !== "git") continue;

  // git -C <dir> …
  let gitBase = base;
  let gitArgs = args;
  const cIdx = gitArgs.indexOf("-C");
  if (cIdx >= 0 && gitArgs[cIdx + 1]) {
    gitBase = path.resolve(base, gitArgs[cIdx + 1]);
    gitArgs = [...gitArgs.slice(0, cIdx), ...gitArgs.slice(cIdx + 2)];
  }
  const sub = gitArgs.find((a) => !a.startsWith("-"));
  const subArgs = gitArgs.slice(gitArgs.indexOf(sub) + 1);
  const gitPaths = subArgs.filter((a) => !a.startsWith("-"));
  if (cIdx >= 0 && isOutside(gitBase, base) && !GIT_READONLY.has(sub)) {
    block("git -C points outside app/. Run git from app/ on app files only.");
  }

  if (sub === "add") {
    if (subArgs.some((a) => ["-A", "--all", "-u", "--update"].includes(a))) {
      block("`git add -A/-u` stages changes across the whole monorepo. From app/: `git add .` and, when package.json changed, `git add ../pnpm-lock.yaml`.");
    }
    const bad = gitPaths.filter((a) => isOutside(a, gitBase) && real(path.resolve(gitBase, a)) !== lockfile);
    if (bad.length) block(`only app/ files and the root pnpm-lock.yaml may be staged (not ${bad.join(", ")}).`);
  }
  if (["rm", "mv", "checkout", "restore", "clean", "stash", "apply", "am"].includes(sub) && gitPaths.some((a) => isOutside(a, gitBase))) {
    block(`\`git ${sub}\` would change files outside app/.`);
  }
  if (sub === "commit" && subArgs.some((a) => a === "-a" || a === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a))) {
    block("`git commit -a` commits every modified file in the monorepo. Stage explicitly, then commit.");
  }

  const branch = (() => {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD", { cwd: appDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  })();

  if (sub === "push") {
    if (subArgs.some((a) => a === "-f" || a === "--force" || (/^-[a-zA-Z]+$/.test(a) && a.includes("f")))) {
      block("force pushes are not allowed. Use --force-with-lease on your own feature branch only if you must.");
    }
    if (gitPaths.some((a) => /(^|:)(main|master)$/.test(a))) block("never push to main. Push your feature branch and open a pull request.");
    if ((branch === "main" || branch === "master") && !gitPaths.some((a) => a.includes(":"))) {
      block(`you are on ${branch}. Create a branch first: git switch -c feat/app-<thing>`);
    }
  }
  if (sub === "commit" && (branch === "main" || branch === "master")) {
    block(`you are on ${branch}. Create a branch first: git switch -c feat/app-<thing>`);
  }
}

process.exit(0);
