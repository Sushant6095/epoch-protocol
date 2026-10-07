/**
 * What every command shares: the cluster (connected, genesis-checked), the key folder, the state folder and the
 * priority fee. Parsed from the common options of `pnpm devnet <command>`.
 */
import path from 'node:path';

import { type Cluster, connect, resolveCluster } from './cluster';
import { KitError } from './errors';
import { assertOutsideRepo, KeyFolder } from './keys';

export interface CommonOptions {
  url?: string;
  ws?: string;
  keys?: string;
  'state-dir'?: string;
  'priority-fee'?: string;
  yes?: boolean;
}

export const COMMON_OPTIONS = {
  url: { type: 'string' },
  ws: { type: 'string' },
  keys: { type: 'string' },
  'state-dir': { type: 'string' },
  'priority-fee': { type: 'string' },
  yes: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

export interface Context {
  cluster: Cluster;
  /** null when the command needs no keys (budget, status) and none were given. */
  keys: KeyFolder | null;
  stateDir: string | null;
  /** Micro-lamports per compute unit. */
  priorityFee: bigint;
  yes: boolean;
}

/** Default priority fee: none on a local validator, a small one on public clusters (≈ 200 lamports per 200k CU). */
export function defaultPriorityFee(cluster: Cluster['name']): bigint {
  return cluster === 'localnet' ? 0n : 1_000n;
}

export function parsePriorityFee(value: string | undefined, cluster: Cluster['name']): bigint {
  if (value === undefined) return defaultPriorityFee(cluster);
  if (!/^\d+$/.test(value))
    throw new KitError('BAD_ARGS', `--priority-fee must be micro-lamports per CU, got ${value}`);
  return BigInt(value);
}

export async function openContext(opts: CommonOptions, needKeys: boolean): Promise<Context> {
  if (!opts.url) throw new KitError('BAD_ARGS', '--url is required (devnet, testnet, localnet or an http(s) URL)');
  const cluster = await connect(resolveCluster(opts.url, opts.ws));
  const keysDir = opts.keys ?? process.env.EPOCH_DEVNET_KEYS;
  if (needKeys && !keysDir) {
    throw new KitError('BAD_ARGS', '--keys <folder outside the repo> (or EPOCH_DEVNET_KEYS) is required');
  }
  const keys = keysDir ? new KeyFolder(keysDir) : null;
  const stateDir = opts['state-dir'] ?? (keys ? path.join(keys.dir, 'state') : null);
  if (stateDir) assertOutsideRepo(stateDir, 'state folder');
  return {
    cluster,
    keys,
    stateDir,
    priorityFee: parsePriorityFee(opts['priority-fee'], cluster.name),
    yes: opts.yes === true,
  };
}
