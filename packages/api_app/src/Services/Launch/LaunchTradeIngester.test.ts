import {
  DAMM_POOL,
  DBC_POOL,
  REHEARSAL,
  REHEARSAL_TXS,
  rehearsalTx,
  TREASURY,
  VALIDATOR,
} from '../../__fixtures__/LaunchFixtures';
import { type LaunchLiveChain, type PoolSignature } from './LaunchLiveChain';
import { cursorName, type IngestLaunch, LaunchTradeIngester } from './LaunchTradeIngester';
import { MemoryLaunchTradeStore, type StoredLaunchFeeEvent, type StoredLaunchTrade } from './LaunchTradeStore';

/**
 * getSignaturesForAddress and getTransaction over the rehearsal's recorded transactions: `visible` is what the chain
 * has so far, `missing` what the node lists but cannot return yet, `failed` what failed on chain.
 */
class FakeChain implements Pick<LaunchLiveChain, 'signatures' | 'transaction'> {
  visible = new Set(REHEARSAL_TXS.map((tx) => tx.name));
  missing = new Set<string>();
  failed = new Set<string>();
  error: Error | null = null;
  readonly fetched: string[] = [];
  signatureCalls = 0;

  async signatures(
    address: string,
    options: { until?: string; before?: string; limit: number },
  ): Promise<PoolSignature[]> {
    this.signatureCalls++;
    if (this.error) throw this.error;
    const list = REHEARSAL_TXS.filter((tx) => this.visible.has(tx.name) && tx.accounts.includes(address)).sort(
      (a, b) => b.slot - a.slot,
    );
    const start = options.before ? list.findIndex((tx) => tx.signature === options.before) + 1 : 0;
    const until = options.until ? list.findIndex((tx) => tx.signature === options.until) : -1;
    return list
      .slice(start, until >= 0 ? until : list.length)
      .slice(0, options.limit)
      .map((tx) => ({
        signature: tx.signature,
        slot: tx.slot,
        err: this.failed.has(tx.name) ? { InstructionError: [2, { Custom: 6001 }] } : null,
        blockTime: tx.blockTime,
      }));
  }

  async transaction(signature: string): Promise<unknown | null> {
    const tx = REHEARSAL_TXS.find((candidate) => candidate.signature === signature);
    if (!tx || this.missing.has(tx.name)) return null;
    this.fetched.push(tx.name);
    return tx.raw;
  }
}

/** The registry knows only the curve: the DAMM v2 pool is learned from the graduation. */
const CURVE_ONLY: IngestLaunch = {
  mint: REHEARSAL.mint,
  symbol: REHEARSAL.symbol,
  pools: [{ address: DBC_POOL, info: { venue: 'dbc', baseDecimals: 6 } }],
};

describe('LaunchTradeIngester (the rehearsal transactions)', () => {
  let chain: FakeChain;
  let store: MemoryLaunchTradeStore;
  let clock: number;
  let pushed: { trades: StoredLaunchTrade[][]; fees: StoredLaunchFeeEvent[][] };

  const ingester = (options: { backfillLimit?: number; launches?: IngestLaunch[] } = {}) =>
    new LaunchTradeIngester({
      chain,
      store,
      launches: async () => options.launches ?? [CURVE_ONLY],
      pollMs: 10_000,
      backfillLimit: options.backfillLimit ?? 1_000,
      enabled: true,
      onTrades: (mint, rows) => {
        expect(mint).toBe(REHEARSAL.mint);
        pushed.trades.push(rows);
      },
      onFeeEvents: (_mint, rows) => pushed.fees.push(rows),
      now: () => clock,
    });

  beforeEach(() => {
    chain = new FakeChain();
    store = new MemoryLaunchTradeStore();
    clock = Date.parse('2026-10-03T13:30:00Z');
    pushed = { trades: [], fees: [] };
  });

  it('backfills the curve, learns the graduation, then reads the DAMM v2 pool too', async () => {
    const ingest = ingester();
    expect(await ingest.pollOnce()).toEqual({ trades: 4, feeEvents: 5 });
    expect(ingest.graduatedPool(REHEARSAL.mint)).toBe(DAMM_POOL);
    expect(ingest.lastPoll(REHEARSAL.mint)).toBe(clock);
    // Oldest first, as they happened.
    expect(chain.fetched).toEqual([
      'launch-create-pool-first-buy',
      'dbc-buy',
      'dbc-sell',
      'dbc-buy-completes-curve',
      'migrate-damm-v2',
      'claim-partner-trading-fee',
      'claim-creator-migration-fee',
      'withdraw-leftover',
    ]);
    const curveTrades = await store.trades(REHEARSAL.mint, { limit: 10 });
    expect(curveTrades.map((row) => [row.venue, row.side, row.solLamports])).toEqual([
      ['dbc', 'buy', 464_385_772n],
      ['dbc', 'sell', 75_281_111n],
      ['dbc', 'buy', 200_000_000n],
      ['dbc', 'buy', 20_000_000n],
    ]);
    expect(curveTrades[2]).toMatchObject({
      signature: rehearsalTx('dbc-buy').signature,
      mint: REHEARSAL.mint,
      pool: DBC_POOL,
      trader: '6MTBgCMiLQLbXrMXmWa172Hv2hE2q1wANkfPZD2QMTA5',
      slot: 3_443,
      blockTime: new Date(1_791_034_674_000),
      tokenAmount: 89_402_418_317n,
      feeAmount: 2_000_000n,
      feeInToken: false,
    });
    expect((await store.feeEvents(REHEARSAL.mint, 10)).map((row) => [row.kind, row.owner, row.solLamports])).toEqual([
      ['leftover', TREASURY, 0n],
      ['creatorMigrationFee', VALIDATOR, 525_000_270n],
      ['partnerTradingFee', TREASURY, 7_283_420n],
      ['dammPoolCreated', expect.any(String), 224_550_116n],
      ['curveComplete', null, 750_000_387n],
    ]);
    expect(await store.cursor(cursorName(DBC_POOL))).toEqual({
      slot: 3_916,
      signature: rehearsalTx('withdraw-leftover').signature,
    });

    // Next poll: the DAMM v2 pool's history. The migration is read again through it and stored once.
    expect(await ingest.pollOnce()).toEqual({ trades: 2, feeEvents: 1 });
    expect(chain.fetched.slice(8)).toEqual(['migrate-damm-v2', 'damm-buy', 'damm-sell', 'claim-lp-fee']);
    expect((await store.trades(REHEARSAL.mint, { limit: 2 })).map((row) => [row.venue, row.side])).toEqual([
      ['damm-v2', 'sell'],
      ['damm-v2', 'buy'],
    ]);
    expect((await store.feeEvents(REHEARSAL.mint, 1))[0]).toMatchObject({
      kind: 'lpFee',
      pool: DAMM_POOL,
      solLamports: 2_862_904n,
    });

    // Nothing new: no transaction is fetched again.
    expect(await ingest.pollOnce()).toEqual({ trades: 0, feeEvents: 0 });
    expect(chain.fetched).toHaveLength(12);
    expect(pushed.trades.flat()).toHaveLength(6);
    expect(pushed.fees.flat()).toHaveLength(6);
  });

  it('reads only what is after the cursor, oldest first', async () => {
    chain.visible = new Set(['launch-create-pool-first-buy', 'dbc-buy']);
    const ingest = ingester();
    expect(await ingest.pollOnce()).toEqual({ trades: 2, feeEvents: 0 });
    chain.visible.add('dbc-sell');
    chain.visible.add('dbc-buy-completes-curve');
    expect(await ingest.pollOnce()).toEqual({ trades: 2, feeEvents: 1 });
    expect(chain.fetched).toEqual(['launch-create-pool-first-buy', 'dbc-buy', 'dbc-sell', 'dbc-buy-completes-curve']);
    expect(pushed.trades[1].map((row) => row.side)).toEqual(['sell', 'buy']);
  });

  it('starts from the newest signature when backfill is off', async () => {
    chain.visible = new Set(['launch-create-pool-first-buy', 'dbc-buy']);
    const ingest = ingester({ backfillLimit: 0 });
    expect(await ingest.pollOnce()).toEqual({ trades: 0, feeEvents: 0 });
    expect(await store.cursor(cursorName(DBC_POOL))).toMatchObject({ signature: rehearsalTx('dbc-buy').signature });
    chain.visible.add('dbc-sell');
    expect(await ingest.pollOnce()).toEqual({ trades: 1, feeEvents: 0 });
    expect(chain.fetched).toEqual(['dbc-sell']);
  });

  it('holds the cursor on a transaction the node cannot return yet, and skips it after three polls', async () => {
    chain.visible = new Set(['launch-create-pool-first-buy', 'dbc-buy', 'dbc-sell']);
    chain.missing.add('dbc-buy');
    const ingest = ingester();
    expect(await ingest.pollOnce()).toEqual({ trades: 1, feeEvents: 0 });
    expect(await store.cursor(cursorName(DBC_POOL))).toMatchObject({
      signature: rehearsalTx('launch-create-pool-first-buy').signature,
    });
    expect(await ingest.pollOnce()).toEqual({ trades: 0, feeEvents: 0 });
    expect(await ingest.pollOnce()).toEqual({ trades: 1, feeEvents: 0 });
    expect((await store.trades(REHEARSAL.mint, { limit: 5 })).map((row) => row.side)).toEqual(['sell', 'buy']);
    expect(await store.cursor(cursorName(DBC_POOL))).toMatchObject({ signature: rehearsalTx('dbc-sell').signature });
  });

  it('reads a late transaction once the node returns it', async () => {
    chain.visible = new Set(['launch-create-pool-first-buy', 'dbc-buy']);
    chain.missing.add('dbc-buy');
    const ingest = ingester();
    expect(await ingest.pollOnce()).toEqual({ trades: 1, feeEvents: 0 });
    chain.missing.clear();
    expect(await ingest.pollOnce()).toEqual({ trades: 1, feeEvents: 0 });
  });

  it('skips failed transactions without fetching them', async () => {
    chain.visible = new Set(['launch-create-pool-first-buy', 'dbc-buy', 'dbc-sell']);
    chain.failed.add('dbc-buy');
    expect(await ingester().pollOnce()).toEqual({ trades: 2, feeEvents: 0 });
    expect(chain.fetched).toEqual(['launch-create-pool-first-buy', 'dbc-sell']);
  });

  it('backs off on 429, doubling up to a minute', async () => {
    const ingest = ingester();
    chain.error = new Error('429 Too Many Requests');
    expect(await ingest.pollOnce()).toEqual({ trades: 0, feeEvents: 0 });
    expect(chain.signatureCalls).toBe(1);
    clock += 1_000;
    await ingest.pollOnce(); // still backing off (2 s)
    expect(chain.signatureCalls).toBe(1);
    clock += 1_500;
    await ingest.pollOnce(); // 429 again: 4 s now
    expect(chain.signatureCalls).toBe(2);
    clock += 3_000;
    await ingest.pollOnce();
    expect(chain.signatureCalls).toBe(2);
    chain.error = null;
    clock += 1_500;
    expect(await ingest.pollOnce()).toEqual({ trades: 4, feeEvents: 5 });
    expect(ingest.lastPoll(REHEARSAL.mint)).toBe(clock);
  });

  it('keeps the last good poll time when a pool read fails', async () => {
    const ingest = ingester();
    chain.error = new Error('fetch failed');
    await ingest.pollOnce();
    expect(ingest.lastPoll(REHEARSAL.mint)).toBeNull();
    // Not a rate limit: no back-off, the next poll tries again.
    chain.error = null;
    expect(await ingest.pollOnce()).toEqual({ trades: 4, feeEvents: 5 });
  });

  it('reads a launch whose registry entry already names the DAMM v2 pool', async () => {
    const ingest = ingester({
      launches: [
        {
          ...CURVE_ONLY,
          pools: [
            ...CURVE_ONLY.pools,
            { address: DAMM_POOL, info: { venue: 'damm-v2', baseDecimals: 6, baseIsTokenA: true } },
          ],
        },
      ],
    });
    expect(await ingest.pollOnce()).toEqual({ trades: 6, feeEvents: 6 });
    expect(await ingest.pollOnce()).toEqual({ trades: 0, feeEvents: 0 });
  });
});
