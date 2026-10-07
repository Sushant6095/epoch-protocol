/**
 * Child processes (the Solana CLI, cargo-build-sbf, scripts/set-program-id.sh) and the confirmation prompt. Arguments
 * carry key *paths* only, never key material.
 */
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';

import { KitError } from './errors';

export interface RunOptions {
  label: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stream output to the terminal (long builds) instead of capturing it. */
  inherit?: boolean;
}

/** Run a command; returns stdout (empty when inherited). Throws `COMMAND_FAILED` with the tail of stderr. */
export function run(cmd: string, args: string[], opts: RunOptions): string {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new KitError('COMMAND_FAILED', `${opts.label}: ${res.error.message}`);
  if (res.status !== 0) {
    const tail = `${res.stderr ?? ''}${res.stdout ?? ''}`.trim().split('\n').slice(-15).join('\n');
    throw new KitError('COMMAND_FAILED', `${opts.label} exited with ${res.status}${tail ? `:\n${tail}` : ''}`);
  }
  return res.stdout ?? '';
}

/** Parse the last JSON object a CLI printed with `--output json` (it may print progress lines before it). */
export function lastJson<T>(stdout: string): T {
  const start = stdout.lastIndexOf('\n{');
  const text = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new KitError('COMMAND_FAILED', `expected JSON output, got: ${stdout.slice(-300)}`);
  }
}

/** Ask before spending; `--yes` skips it, and a non-interactive run without `--yes` refuses. */
export async function confirm(question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) throw new KitError('BAD_ARGS', `${question} (not a terminal: pass --yes to proceed)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new KitError('BAD_ARGS', 'cancelled');
}
