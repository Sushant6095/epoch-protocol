import { readFileSync, statSync } from 'fs';

import { z } from '@epoch/common/pkg/zod';
import { Logger } from '@epoch/logger';

const logger = Logger.create('LaunchRegistryFile');

/** The registry fields the fee claims need (the API validates the full entry: api_app `LaunchRegistryEntrySchema`). */
const EntrySchema = z.object({
  mint: z.string().min(32).max(44),
  symbol: z.string().min(1),
  cluster: z.enum(['devnet', 'mainnet']),
  dbcPool: z.string().min(32).max(44).nullable().optional(),
  dbcConfig: z.string().min(32).max(44).nullable().optional(),
  dammPool: z.string().min(32).max(44).nullable().optional(),
});

/** A launch the claim job works on. */
export interface ClaimLaunch {
  mint: string;
  symbol: string;
  cluster: 'devnet' | 'mainnet';
  dbcPool: string;
  dbcConfig: string | null;
  dammPool: string | null;
}

/** Parses the registry file's text; entries without a DBC pool (not launched) are left out. Throws on a bad file. */
export function parseClaimLaunches(text: string): ClaimLaunch[] {
  const parsed = z.array(EntrySchema).parse(JSON.parse(text));
  return parsed
    .filter((entry) => !!entry.dbcPool)
    .map((entry) => ({
      mint: entry.mint,
      symbol: entry.symbol,
      cluster: entry.cluster,
      dbcPool: entry.dbcPool as string,
      dbcConfig: entry.dbcConfig ?? null,
      dammPool: entry.dammPool ?? null,
    }));
}

/** The launch registry (`LAUNCHES_PATH`), re-read when it changes; a missing file is an empty registry. */
export class LaunchRegistryFile {
  private cached?: { mtimeMs: number; size: number; launches: ClaimLaunch[] };

  constructor(
    private readonly path: string,
    private readonly cluster: 'devnet' | 'mainnet',
  ) {}

  /** This cluster's launches. A file that fails to parse keeps the last good read (logged). */
  load(): ClaimLaunch[] {
    let stat;
    try {
      stat = statSync(this.path);
    } catch {
      return [];
    }
    if (!this.cached || this.cached.mtimeMs !== stat.mtimeMs || this.cached.size !== stat.size) {
      try {
        this.cached = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          launches: parseClaimLaunches(readFileSync(this.path, 'utf8')),
        };
      } catch (error) {
        logger.error('launch registry unreadable; keeping the last good read', error, { path: this.path });
        return (this.cached?.launches ?? []).filter((launch) => launch.cluster === this.cluster);
      }
    }
    return this.cached.launches.filter((launch) => launch.cluster === this.cluster);
  }
}
