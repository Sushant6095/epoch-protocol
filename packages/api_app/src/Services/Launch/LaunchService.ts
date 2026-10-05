import { NotFoundException } from '@epoch/exceptions';
import { type LaunchRegistryEntry, type TokenHolders } from '@epoch/meteora';

import { SnapshotCache } from '../../Lib/SnapshotCache';
import { isoIst } from '../../Lib/Stats';
import { type LaunchDetail, type LaunchList, type LaunchNetwork } from '../../types/Launch.types';
import { type HolderExclusions, type LaunchChainReader, type LaunchEpochInfo, readLaunchChain } from './LaunchChain';
import { buildLaunchItem, type LaunchItem } from './LaunchMapper';
import { type LaunchPriceSample, type LaunchPriceStore, MAX_SERIES_POINTS } from './LaunchPriceStore';
import { type LaunchRegistry } from './LaunchRegistry';
import { type LaunchRevenueSource } from './LaunchRevenue';

/** Parallel launch reads per refresh (the public RPC rate-limits). */
const READ_CONCURRENCY = 3;

const BUYBACK_NOTE = "Buybacks: GET /v1/launches/:mint/buybacks (the program's escrow, schedule and burns).";
const REGISTRY_NOTE =
  "Launches come from the launch registry; a registered token's terms are the program's (revenueToken on GET /v1/launches/:mint/page).";
const REVENUE_NOTE =
  "Share revenue is a mainnet estimate (inflation and MEV commission per epoch, from the validator table) until the program's swept revenue replaces it.";

export interface LaunchServiceOptions {
  registry: LaunchRegistry;
  reader: LaunchChainReader;
  revenue: LaunchRevenueSource;
  /** Null without Postgres: the price series is then empty. */
  prices: LaunchPriceStore | null;
  network: LaunchNetwork;
  cacheMs: number;
  holdersCacheMs: number;
  now?: () => number;
}

/** One read of every launch on the network. */
interface LaunchBoard {
  readAt: Date;
  epoch: LaunchEpochInfo | null;
  items: LaunchItem[];
  /** The registry has launches on this network. */
  registered: boolean;
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const unique = (lines: readonly string[]): string[] => [...new Set(lines)];

/**
 * `GET /v1/launches` and `GET /v1/launches/:mint`: the registry's launches with their DBC and DAMM v2 pools, mint,
 * holders and escrow read on the launch cluster (one read of every launch, cached for `cacheMs`; holders for
 * `holdersCacheMs`), share revenue from the mainnet validator table, and prices from launch_price_samples.
 */
export class LaunchService {
  private readonly board: SnapshotCache<LaunchBoard>;
  private readonly holders = new Map<string, SnapshotCache<TokenHolders>>();
  /** The latest pool vaults and owners to leave out of each token's buyers (they change at graduation). */
  private readonly exclusions = new Map<string, { tokenProgram: string; exclude: HolderExclusions }>();
  private readonly series = new Map<string, SnapshotCache<LaunchPriceSample[]>>();
  private readonly now: () => number;

  constructor(private readonly options: LaunchServiceOptions) {
    this.now = options.now ?? Date.now;
    this.board = new SnapshotCache('launches', options.cacheMs, () => this.read(), options.cacheMs * 10, this.now);
  }

  get network(): LaunchNetwork {
    return this.options.network;
  }

  /** GET /v1/launches */
  async list(): Promise<LaunchList> {
    const board = await this.board.get();
    return {
      schemaVersion: 1,
      kind: board.registered && board.items.every((item) => item.real) ? 'real' : 'sample',
      asOf: isoIst(board.readAt),
      source: this.source(),
      note: this.noteFor(board, board.items).join(' '),
      network: this.options.network,
      launches: board.items.map((item) => item.summary),
    };
  }

  /** GET /v1/launches/:mint — by mint, or by symbol (`rKEST`, case-insensitive). 404 for an unknown token. */
  async detail(key: string): Promise<LaunchDetail> {
    const board = await this.board.get();
    const item =
      board.items.find((candidate) => candidate.entry.mint === key) ??
      board.items.find((candidate) => candidate.entry.symbol.toLowerCase() === key.toLowerCase());
    if (!item) throw new NotFoundException('No launch with this mint', { mint: key });
    const notes = this.noteFor(board, [item]);
    const samples = await this.priceSeries(item.entry.mint);
    if (!this.options.prices) notes.push('The price series needs Postgres (DATABASE_URL).');
    return {
      schemaVersion: 1,
      kind: item.real ? 'real' : 'sample',
      asOf: isoIst(board.readAt),
      source: this.source(),
      note: unique(notes).join(' '),
      network: this.options.network,
      launch: item.summary,
      ...item.detail,
      priceSeries: samples.map((sample) => ({
        t: isoIst(sample.t),
        epoch: sample.epoch,
        priceSol: sample.priceSol,
      })),
    };
  }

  /**
   * One launch from the cached board, by mint or symbol, with when the board was read: the Launch page's services
   * build on it. 404 for an unknown token.
   */
  async find(key: string): Promise<{ item: LaunchItem; readAt: Date; epoch: LaunchEpochInfo | null }> {
    const board = await this.board.get();
    const item =
      board.items.find((candidate) => candidate.entry.mint === key) ??
      board.items.find((candidate) => candidate.entry.symbol.toLowerCase() === key.toLowerCase());
    if (!item) throw new NotFoundException('No launch with this mint', { mint: key });
    return { item, readAt: board.readAt, epoch: board.epoch };
  }

  /** The registry's launches on this network (no chain reads). */
  entries(): LaunchRegistryEntry[] {
    return this.options.registry.load().filter((entry) => entry.cluster === this.options.network);
  }

  /** For the sampler: every priced launch at the time of a fresh read (re-read when the cached one is old). */
  async priceSamples(): Promise<LaunchPriceSample[]> {
    const fresh = this.now() - this.board.loadedAtMs < this.options.cacheMs;
    const board = fresh ? await this.board.get() : await this.board.refresh();
    if (!board.epoch) return [];
    const epoch = board.epoch.epoch;
    return board.items
      .filter((item) => item.summary.priceSol !== null)
      .map((item) => ({ mint: item.entry.mint, t: board.readAt, epoch, priceSol: item.summary.priceSol as number }));
  }

  private source(): string {
    return `Meteora DBC and DAMM v2 pools on ${this.options.network}, the launch registry (LAUNCHES_PATH), the mainnet validator table`;
  }

  private noteFor(board: LaunchBoard, items: readonly LaunchItem[]): string[] {
    if (!this.options.registry.configured) {
      return ['No launches yet: set LAUNCHES_PATH to the launch registry (the launch script writes it).'];
    }
    if (!board.registered) return [`No launches on ${this.options.network} in the registry yet.`, REGISTRY_NOTE];
    const notes = [REGISTRY_NOTE, BUYBACK_NOTE];
    if (items.some((item) => item.summary.shareRevenuePerEpochSol > 0)) notes.push(REVENUE_NOTE);
    if (!board.epoch) notes.push(`Could not read the ${this.options.network} epoch.`);
    return unique([...notes, ...items.flatMap((item) => item.notes)]);
  }

  private async read(): Promise<LaunchBoard> {
    const readAt = new Date(this.now());
    const entries = this.options.registry.load().filter((entry) => entry.cluster === this.options.network);
    if (entries.length === 0) return { readAt, epoch: null, items: [], registered: false };
    const epoch = await this.options.reader.epochInfo().catch(() => null);
    const items = await mapConcurrent(entries, READ_CONCURRENCY, async (entry) => {
      const [chain, revenue] = await Promise.all([
        readLaunchChain(entry, this.options.reader, (mint, program, exclude) => this.holdersOf(mint, program, exclude)),
        this.options.revenue(entry.validator.vote),
      ]);
      return buildLaunchItem({ entry, chain, epoch, revenue, network: this.options.network, now: readAt });
    });
    return { readAt, epoch, items, registered: true };
  }

  private holdersOf(mint: string, tokenProgram: string, exclude: HolderExclusions): Promise<TokenHolders> {
    this.exclusions.set(mint, { tokenProgram, exclude });
    let cache = this.holders.get(mint);
    if (!cache) {
      cache = new SnapshotCache(
        `launch.holders.${mint}`,
        this.options.holdersCacheMs,
        () => {
          const latest = this.exclusions.get(mint) ?? { tokenProgram, exclude };
          return this.options.reader.holders(mint, latest.tokenProgram, latest.exclude);
        },
        this.options.holdersCacheMs * 3,
        this.now,
      );
      this.holders.set(mint, cache);
    }
    return cache.get();
  }

  private async priceSeries(mint: string): Promise<LaunchPriceSample[]> {
    const store = this.options.prices;
    if (!store) return [];
    let cache = this.series.get(mint);
    if (!cache) {
      cache = new SnapshotCache(
        `launch.series.${mint}`,
        this.options.cacheMs,
        () => store.series(mint, MAX_SERIES_POINTS),
        this.options.cacheMs * 10,
        this.now,
      );
      this.series.set(mint, cache);
    }
    return cache.get().catch(() => []);
  }
}
