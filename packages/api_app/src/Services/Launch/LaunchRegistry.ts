import { readFileSync, statSync } from 'fs';

import { z } from '@epoch/common/pkg/zod';
import { ServiceUnavailableException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { type LaunchRegistryEntry } from '@epoch/meteora';
import { PublicKey } from '@solana/web3.js';

const logger = Logger.create('LaunchRegistry');

const isPublicKey = (value: string): boolean => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
};

const publicKey = z.string().refine(isPublicKey, { message: 'a base58 public key' });
const optionalKey = publicKey.nullable().optional();
const epoch = z.number().int().nonnegative();

/**
 * One launch in the registry (`LAUNCHES_PATH`), the stand-in for `register_revenue_token` until the program has it.
 * The launch script appends entries; `launches.example.json` shows the format.
 */
export const LaunchRegistryEntrySchema = z.object({
  mint: publicKey,
  symbol: z.string().min(1).max(10),
  name: z.string().min(1).max(32),
  /** `vote`: the validator's mainnet vote account, whose revenue the share is priced from. */
  validator: z.object({ name: z.string().min(1).max(64), vote: publicKey.nullable().default(null) }),
  shareBps: z.number().int().min(1).max(10_000),
  termEpochs: z.number().int().min(1),
  startEpoch: epoch,
  opensAtEpoch: epoch.nullable().optional(),
  dbcPool: optionalKey,
  dbcConfig: optionalKey,
  dammPool: optionalKey,
  escrow: optionalKey,
  /** Fixed supply at launch, UI units. */
  supply: z.number().positive(),
  decimals: z.number().int().min(0).max(9),
  /** Used when the mint cannot be read. */
  burned: z.number().nonnegative().optional(),
  cluster: z.enum(['devnet', 'mainnet']),
  /** The 10-epoch average revenue (SOL per epoch) the curve was priced from. */
  avgRevenueSol: z.number().positive().optional(),
  raiseTargetSol: z.number().positive().optional(),
  graduatedEpoch: epoch.nullable().optional(),
  launchedAt: z.string().optional(),
});

export const LaunchRegistrySchema = z.array(LaunchRegistryEntrySchema).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.mint)) ctx.addIssue({ code: 'custom', path: [index, 'mint'], message: 'duplicate mint' });
    seen.add(entry.mint);
  });
});

// Compile-time: what the schema accepts is what the launch script (@epoch/meteora) writes.
const _schemaMatchesMeteora = (entry: z.infer<typeof LaunchRegistryEntrySchema>): LaunchRegistryEntry => entry;
void _schemaMatchesMeteora;

/** Parses the registry file's text; 503 LAUNCH_REGISTRY_INVALID with the issues when it is not a valid registry. */
export function parseLaunchRegistry(text: string): LaunchRegistryEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ServiceUnavailableException('The launch registry is not valid JSON', 'LAUNCH_REGISTRY_INVALID', {
      error: String(error),
    });
  }
  const result = LaunchRegistrySchema.safeParse(json);
  if (!result.success) {
    throw new ServiceUnavailableException('The launch registry does not match its schema', 'LAUNCH_REGISTRY_INVALID', {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/** The registry file, re-read whenever it changes on disk. A missing file is an empty registry (no launch yet). */
export class LaunchRegistry {
  private cached?: { mtimeMs: number; size: number; entries: LaunchRegistryEntry[] };

  constructor(readonly path: string | undefined) {}

  get configured(): boolean {
    return this.path !== undefined;
  }

  load(): LaunchRegistryEntry[] {
    if (!this.path) return [];
    let stat;
    try {
      stat = statSync(this.path);
    } catch {
      if (this.cached === undefined)
        logger.warn('launch registry not found yet; serving no launches', { path: this.path });
      this.cached = { mtimeMs: -1, size: -1, entries: [] };
      return [];
    }
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size)
      return this.cached.entries;
    const entries = parseLaunchRegistry(readFileSync(this.path, 'utf8'));
    this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
    logger.info('launch registry loaded', { launches: entries.length });
    return entries;
  }
}
