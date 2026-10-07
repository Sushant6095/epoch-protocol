/**
 * Keypair files. Every key the kit reads or creates must live outside the repository (the hard rule: no keypairs in the
 * repo); new files are written 0600, and nothing here ever prints a secret key.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Keypair } from '@solana/web3.js';

import { KitError } from './errors';

/** The repository root (scripts/devnet/src/lib → four levels up). */
export const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Resolve symlinks of the longest existing prefix, so a link into the repo cannot slip past the check. */
function realish(file: string): string {
  let dir = path.resolve(file);
  const rest: string[] = [];
  while (!fs.existsSync(dir)) {
    rest.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...rest);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Throw unless `file` (a keypair or a key folder) is outside the repository. */
export function assertOutsideRepo(file: string, what = 'keypair', repoRoot = REPO_ROOT): string {
  const resolved = realish(file);
  if (isInside(resolved, realish(repoRoot))) {
    throw new KitError('KEY_IN_REPO', `${what} ${file} is inside the repository; keep keys outside it`);
  }
  return resolved;
}

export function readKeypair(file: string, repoRoot = REPO_ROOT): Keypair {
  const resolved = assertOutsideRepo(file, 'keypair', repoRoot);
  if (!fs.existsSync(resolved)) throw new KitError('KEY_MISSING', `keypair ${file} does not exist`);
  const raw: unknown = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new KitError('KEY_MISSING', `${file} is not a 64-byte keypair file`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

/** A named key in the key folder: `<dir>/<name>.json`, created (0600) on first use. */
export class KeyFolder {
  readonly dir: string;

  constructor(
    dir: string,
    private readonly repoRoot = REPO_ROOT,
  ) {
    this.dir = assertOutsideRepo(dir, 'key folder', repoRoot);
  }

  path(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new KitError('BAD_ARGS', `bad key name ${name}`);
    return path.join(this.dir, `${name}.json`);
  }

  has(name: string): boolean {
    return fs.existsSync(this.path(name));
  }

  get(name: string): Keypair {
    return readKeypair(this.path(name), this.repoRoot);
  }

  getOrCreate(name: string): Keypair {
    const file = this.path(name);
    if (fs.existsSync(file)) return this.get(name);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const kp = Keypair.generate();
    fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: 'wx' });
    return kp;
  }
}
