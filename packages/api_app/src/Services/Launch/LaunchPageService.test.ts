import { FIELD_OFFSETS, findPoolPda, findVaultPda } from '@epoch/epoch-sdk';
import { LaunchTradeError } from '@epoch/meteora';
import { PublicKey, Transaction } from '@solana/web3.js';

import {
  BLOCKHASH,
  curveMidRaise,
  DAMM_POOL,
  DAMM_V2_POOL_AUTHORITY,
  DBC_POOL,
  DBC_POOL_AUTHORITY,
  fakeQuote,
  launchPageHarness,
  type LaunchPageHarness,
  PROGRAM_ID,
  REHEARSAL,
  rehearsalClaims,
  rehearsalCurve,
  rehearsalDamm,
  RLOC,
  storedTrade,
  TRADER,
  TREASURY,
  VALIDATOR,
} from '../../__fixtures__/LaunchFixtures';
import { type StoredProgramEvent } from '../../Lib/EventBus';
import { type LaunchStreamMessage } from '../../types/LaunchPage.types';
import { MemoryEventStore } from '../Program/ProgramEventStore';
import { BuybackFeed } from './BuybackFeed';
import { LaunchTradeIngester } from './LaunchTradeIngester';
import { type StoredLaunchFeeEvent } from './LaunchTradeStore';
import { buybackEscrowAddress, partnerTreasuryAddress, revenueTokenAddress } from './RevenueTokenSource';
import { EventTreasuryClaimsSource } from './TreasuryClaimsSource';

const IST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;
/** 19:30 IST, after the rehearsal. */
const NOW = Date.parse('2026-10-03T14:00:00Z');
const MINT = REHEARSAL.mint;
const VOTE = new PublicKey(REHEARSAL.validator.vote as string);
const ESCROW = buybackEscrowAddress(PROGRAM_ID, VOTE).toBase58();
const devnetTx = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

const feeRow = (n: number, kind: string, overrides: Partial<StoredLaunchFeeEvent> = {}): StoredLaunchFeeEvent => ({
  signature: `4${'y'.repeat(60)}${'abcdefghijk'[n]}`,
  ix: 0,
  mint: MINT,
  pool: DBC_POOL,
  kind,
  owner: TREASURY,
  slot: 3_900 + n,
  blockTime: new Date(NOW - (10 - n) * 60_000),
  solLamports: 7_283_420n,
  tokenAmount: 0n,
  ...overrides,
});

describe('LaunchPageService', () => {
  let h: LaunchPageHarness;
  const setup = (options: Parameters<typeof launchPageHarness>[0] = {}) => {
    h = launchPageHarness({ now: NOW, ...options });
    return h;
  };
  afterEach(() => h?.cleanup());

  describe('market', () => {
    it('on the curve: price, raise, market cap and the implied yield per epoch', async () => {
      setup();
      const market = await h.page.market('rREH');
      expect(market).toEqual({
        status: 'curve',
        venue: 'dbc',
        priceSol: 0.0000031,
        priceUsd: 0.000465,
        solUsd: 150,
        marketCapSol: 3.1,
        marketCapUsd: 465,
        raise: { targetSol: 0.75, raisedSol: 0.3, progressPct: 40, complete: false },
        liquiditySol: 0.3,
        // The live estimate (validator table): 1.99 SOL × 5%.
        shareRevenuePerEpochSol: 0.0995,
        // What the curve was priced at: the launch record's 10-epoch average × 5%.
        pricedAtShareRevenuePerEpochSol: 0.341036,
        impliedYieldPctPerEpoch: 3.21,
        graduation: {
          state: 'curve',
          dammPool: null,
          dammPoolUrl: null,
          meteoraUrl: null,
          graduatedEpoch: null,
          curveCompletedAt: null,
        },
        day: { volumeSol: 0, trades: 0, buys: 0, sells: 0, priceChangePct: null },
        freshness: { asOf: '2026-10-03T19:30:00+05:30', ageSeconds: 0, stale: false },
      });
    });

    it('graduated: the DAMM v2 pool prices it, with its explorer link', async () => {
      setup({ state: { curve: rehearsalCurve(), damm: rehearsalDamm() } });
      const damm = rehearsalDamm();
      const market = await h.page.market(MINT);
      expect(market).toMatchObject({
        status: 'graduated',
        venue: 'damm-v2',
        priceSol: Number(damm.priceSol.toPrecision(6)),
        liquiditySol: 0.159,
        raise: { targetSol: 0.75, raisedSol: 0.75, progressPct: 100, complete: true },
        graduation: {
          state: 'migrated',
          dammPool: DAMM_POOL,
          dammPoolUrl: `https://explorer.solana.com/address/${DAMM_POOL}?cluster=devnet`,
          meteoraUrl: null,
          curveCompletedAt: expect.stringMatching(IST),
        },
      });
      expect(market.marketCapSol).toBeCloseTo(damm.priceSol * 1_000_000, 3);
      expect(h.pageReader.dammPool).toHaveBeenCalledWith(DAMM_POOL);
    });

    it('raise complete, waiting for the migration: no venue to trade on', async () => {
      setup({
        state: {
          curve: { ...rehearsalCurve(), migrated: false, migrationProgress: 'postBondingCurve', dammPool: null },
        },
      });
      expect(await h.page.market(MINT)).toMatchObject({
        status: 'curve',
        venue: null,
        raise: { progressPct: 100, complete: true },
        graduation: { state: 'complete', dammPool: null },
      });
    });

    it('ended: the term is over, the DAMM v2 pool still trades', async () => {
      setup({ state: { curve: rehearsalCurve(), damm: rehearsalDamm() } });
      h.boardReader.epochInfo.mockResolvedValue({ epoch: 11, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 1 });
      expect(await h.page.market(MINT)).toMatchObject({
        status: 'ended',
        venue: 'damm-v2',
        graduation: { state: 'migrated' },
      });
    });

    it('upcoming: no pool, no price', async () => {
      setup();
      expect(await h.page.market('rUPC')).toMatchObject({
        status: 'upcoming',
        venue: null,
        priceSol: null,
        priceUsd: null,
        marketCapSol: null,
        impliedYieldPctPerEpoch: null,
        raise: { targetSol: 3, raisedSol: 0, progressPct: 0, complete: false },
        liquiditySol: null,
        graduation: { state: 'upcoming' },
      });
    });

    it('the last 24 hours from the trade feed', async () => {
      setup();
      await h.store.insertTrades([0, 1, 2, 3].map((n) => storedTrade(n, NOW - 30 * 60_000)));
      await h.store.insertTrades([storedTrade(20, NOW - 2 * 86_400_000)]); // older than a day
      expect((await h.page.market(MINT)).day).toEqual({
        volumeSol: 0.8,
        trades: 4,
        buys: 3,
        sells: 1,
        priceChangePct: 1.36,
      });
    });

    it('is cached, served stale (and said so) while the pool cannot be read, then unavailable', async () => {
      setup();
      await h.page.market(MINT);
      await h.page.market(MINT);
      expect(h.pageReader.launchPool).toHaveBeenCalledTimes(1);
      h.pageReader.launchPool.mockRejectedValue(new Error('429 Too Many Requests'));
      h.clock.now += 150_000;
      expect((await h.page.market(MINT)).freshness).toEqual({
        asOf: '2026-10-03T19:30:00+05:30',
        ageSeconds: 150,
        stale: true,
      });
      h.clock.now += 60_000;
      const page = await h.page.page(MINT);
      expect(page.unavailable).toContain('market');
      expect(page.market).toMatchObject({ priceSol: null, freshness: { asOf: null, stale: true } });
    });

    it('a new trade drops the cached read', async () => {
      setup();
      await h.page.market(MINT);
      h.page.onTrades(MINT, [storedTrade(1, NOW)]);
      await h.page.market(MINT);
      expect(h.pageReader.launchPool).toHaveBeenCalledTimes(2);
    });
  });

  describe('trades', () => {
    it('newest first, paged with nextCursor, mapped for the feed', async () => {
      setup();
      const start = NOW - 10 * 60_000;
      await h.store.insertTrades([0, 1, 2].map((n) => storedTrade(n, start)));
      const first = await h.page.trades('rreh', { limit: 2 });
      expect(first).toMatchObject({ schemaVersion: 1, kind: 'real', network: 'devnet', mint: MINT });
      expect(first.trades.map((trade) => trade.slot)).toEqual([3_002, 3_001]);
      const newest = storedTrade(2, start);
      expect(first.trades[0]).toEqual({
        id: `${newest.signature}:1`,
        signature: newest.signature,
        t: '2026-10-03T19:22:00+05:30',
        slot: 3_002,
        venue: 'dbc',
        side: 'sell',
        trader: TRADER,
        solAmount: 0.2,
        tokenAmount: 89_402.418317,
        priceSol: 0.00000222,
        postPriceSol: 0.00000232,
        feeSol: 0.002,
        explorerUrl: devnetTx(newest.signature),
      });
      expect(first.nextCursor).toBe(`3001:${storedTrade(1, start).signature}:1`);
      const second = await h.page.trades(MINT, { limit: 2, before: first.nextCursor });
      expect(second.trades.map((trade) => trade.slot)).toEqual([3_000]);
      expect(second.nextCursor).toBeNull();
      // No ingester in this process: the feed is not live.
      expect(first.ingest).toEqual({
        running: false,
        lastPollAt: null,
        stale: true,
        pools: [{ address: DBC_POOL, venue: 'dbc' }],
        mode: 'polling',
        lagSeconds: null,
        pollSeconds: null,
      });
    });

    it('values a fee charged in the token at the trade price', async () => {
      setup();
      await h.store.insertTrades([
        storedTrade(0, NOW, { feeInToken: true, feeAmount: 1_000_000_000n, priceSol: 0.000002 }),
      ]);
      expect((await h.page.trades(MINT, {})).trades[0].feeSol).toBe(0.002);
    });

    it('lists the DAMM v2 pool of a graduation that happened before this process started', async () => {
      setup({ state: { curve: rehearsalCurve(), damm: rehearsalDamm() } });
      expect((await h.page.trades(MINT, {})).ingest.pools).toEqual([
        { address: DBC_POOL, venue: 'dbc' },
        { address: DAMM_POOL, venue: 'damm-v2' },
      ]);
    });

    it('rejects a cursor it did not make, and an unknown launch', async () => {
      setup();
      await expect(h.page.trades(MINT, { before: 'yesterday' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(h.page.trades('rNOPE', {})).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });

    it('reports the ingester: running, last poll, both pools once graduated', async () => {
      const ingester = new LaunchTradeIngester({
        chain: { signatures: async () => [], transaction: async () => null },
        store: undefined as never,
        launches: async () => [],
        pollMs: 10_000,
        backfillLimit: 0,
        enabled: true,
        now: () => NOW,
      });
      jest.spyOn(ingester, 'lastPoll').mockReturnValue(NOW - 5_000);
      jest.spyOn(ingester, 'graduatedPool').mockReturnValue(DAMM_POOL);
      setup({ page: { ingester } });
      expect((await h.page.trades(MINT, {})).ingest).toEqual({
        running: true,
        lastPollAt: '2026-10-03T19:29:55+05:30',
        stale: false,
        pools: [
          { address: DBC_POOL, venue: 'dbc' },
          { address: DAMM_POOL, venue: 'damm-v2' },
        ],
        mode: 'polling',
        lagSeconds: null,
        pollSeconds: 10,
      });
      // With a realtime source up: its mode, the lag of the newest row, polling at the backstop pace.
      jest.spyOn(ingester, 'feedStatus').mockReturnValue({ mode: 'grpc', lagSeconds: 0.8, pollSeconds: 60 });
      expect((await h.page.trades(MINT, {})).ingest).toMatchObject({
        mode: 'grpc',
        lagSeconds: 0.8,
        pollSeconds: 60,
        stale: false,
      });
    });
  });

  describe('candles', () => {
    it('OHLC from trades, flat buckets between them, oldest first', async () => {
      setup();
      // Trades at 19:10, 19:11, 19:13 IST.
      const start = NOW - 20 * 60_000;
      await h.store.insertTrades([0, 1, 3].map((n) => storedTrade(n, start)));
      const candles = await h.page.candles(MINT, {
        interval: '1m',
        from: start / 1000 - 60,
        to: start / 1000 + 4 * 60,
      });
      expect(candles).toMatchObject({ interval: '1m', basis: 'trades', network: 'devnet', mint: MINT });
      expect(candles.candles.map((candle) => [candle.t, candle.close, candle.trades])).toEqual([
        // 19:09: nothing before it yet, so no candle.
        ['2026-10-03T19:10:00+05:30', 0.0000022, 1],
        ['2026-10-03T19:11:00+05:30', 0.00000221, 1],
        ['2026-10-03T19:12:00+05:30', 0.00000221, 0],
        ['2026-10-03T19:13:00+05:30', 0.00000223, 1],
        ['2026-10-03T19:14:00+05:30', 0.00000223, 0],
      ]);
      expect(candles.candles[0]).toMatchObject({ time: start / 1000, volumeSol: 0.2 });
    });

    it('falls back to the sampled pool price before the first trade, else says there is nothing', async () => {
      setup();
      expect(await h.page.candles(MINT, { interval: '1h' })).toMatchObject({ basis: 'none', candles: [] });
      await h.prices.insert([
        { mint: MINT, t: new Date(NOW - 2 * 3_600_000), epoch: 5, priceSol: 0.0000025 },
        { mint: MINT, t: new Date(NOW - 3_600_000), epoch: 5, priceSol: 0.0000027 },
      ]);
      const sampled = await h.page.candles(MINT, { interval: '1h' });
      expect(sampled.basis).toBe('samples');
      expect(sampled.source).toMatch(/launch_price_samples/);
      expect(sampled.candles.map((candle) => [candle.close, candle.trades])).toEqual([
        [0.0000025, 0],
        [0.0000027, 0],
        [0.0000027, 0],
      ]);
    });

    it('15-minute candles over the last day by default; rejects a range that ends before it starts', async () => {
      setup();
      await h.store.insertTrades([storedTrade(0, NOW - 3_600_000)]);
      const day = await h.page.candles(MINT, {});
      expect(day.interval).toBe('15m');
      expect(day.candles[day.candles.length - 1].time).toBe(Math.floor(NOW / 1000 / 900) * 900);
      await expect(h.page.candles(MINT, { from: NOW / 1000, to: NOW / 1000 - 60 })).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  describe('holders', () => {
    it('every holder when there are fewer than 20, labelled; buyers leave out the pools, escrow and treasury', async () => {
      setup();
      const holders = await h.page.holders(MINT);
      expect(holders.count).toEqual({ all: 4, buyers: 1 });
      expect(holders.top.map((holder) => [holder.owner, holder.label, holder.amount, holder.sharePct])).toEqual([
        [TREASURY, "Epoch's treasury", 639_263.000567, 63.9263],
        [TRADER, null, 150_000, 15],
        [DAMM_V2_POOL_AUTHORITY, 'Meteora DAMM v2 pool', 90_516.235134, 9.0516],
        [DBC_POOL_AUTHORITY, 'Meteora curve vault', 139, 0.0139],
      ]);
      const labels = h.live.topHolders.mock.calls[0][2];
      expect(labels).toMatchObject({
        [ESCROW]: 'Buyback escrow',
        [VALIDATOR]: `${REHEARSAL.validator.name} (pool creator)`,
      });
      expect(holders.freshness).toMatchObject({ asOf: '2026-10-03T19:30:00+05:30', stale: false });
    });

    it('counts from the holder scan when the largest 20 are not all of them', async () => {
      setup();
      h.live.topHolders.mockImplementation(async () =>
        Array.from({ length: 20 }, (_, i) => ({
          owner: `owner${i}`,
          tokenAccount: `account${i}`,
          amount: '1',
          uiAmount: 1,
          sharePct: 1,
          label: null,
        })),
      );
      expect((await h.page.holders(MINT)).count).toEqual({ all: 7, buyers: 4 });
    });

    it('reads the holders again after a trade or claim, at most every 5 s; otherwise keeps them 2 minutes', async () => {
      setup();
      await h.page.holders(MINT);
      expect(h.live.topHolders).toHaveBeenCalledTimes(1);
      // No trade: the list is kept.
      h.clock.now += 30_000;
      await h.page.holders(MINT);
      expect(h.live.topHolders).toHaveBeenCalledTimes(1);
      // A trade: read again on the next request.
      h.page.onTrades(MINT, [storedTrade(1, h.clock.now)]);
      const after = await h.page.holders(MINT);
      expect(h.live.topHolders).toHaveBeenCalledTimes(2);
      expect(after.freshness).toMatchObject({ ageSeconds: 0, stale: false });
      // Another trade within 5 s of that read: kept until 5 s have passed.
      h.clock.now += 2_000;
      h.page.onTrades(MINT, [storedTrade(2, h.clock.now)]);
      await h.page.holders(MINT);
      expect(h.live.topHolders).toHaveBeenCalledTimes(2);
      h.clock.now += 3_000;
      await h.page.holders(MINT);
      expect(h.live.topHolders).toHaveBeenCalledTimes(3);
      // A claim (the leftover burn, a fee claim) moves balances too; a failed re-read serves the last list.
      h.clock.now += 5_000;
      h.page.onFeeEvents(MINT, [feeRow(0, 'leftover', { blockTime: new Date(h.clock.now) })]);
      h.live.topHolders.mockRejectedValueOnce(new Error('429'));
      expect((await h.page.holders(MINT)).count).toEqual({ all: 4, buyers: 1 });
      expect(h.live.topHolders).toHaveBeenCalledTimes(4);
    });
  });

  describe('fees', () => {
    it('partner, creator, LP and leftover from the pools; what is routed to lenders; the claim history', async () => {
      setup({ state: { curve: rehearsalCurve(), damm: rehearsalDamm() } });
      await h.store.insertFeeEvents([feeRow(0, 'curveComplete', { owner: null }), feeRow(1, 'partnerTradingFee')]);
      const fees = await h.page.fees('rREH');
      expect(fees.partner).toEqual({
        address: TREASURY,
        tradingFeesSol: { accrued: 0.00728342, claimed: 0.00728342, unclaimed: 0 },
        surplusSol: 0,
        surplusWithdrawn: false,
        migrationFeeSol: 0,
        migrationFeeWithdrawn: false,
      });
      expect(fees.creator).toMatchObject({
        address: VALIDATOR,
        migrationFeeSol: 0.52500027,
        migrationFeeWithdrawn: true,
      });
      expect(fees.lp).toEqual({
        positions: [
          expect.objectContaining({
            owner: TREASURY,
            role: 'partner',
            lockedPct: 100,
            claimedSol: 0.002862904,
            unclaimedSol: 0,
          }),
        ],
        claimedSol: 0.002862904,
        unclaimedSol: 0,
      });
      expect(fees.leftover).toEqual({ receiver: TREASURY, tokens: 0, withdrawn: true, burned: false, burnedTokens: 0 });
      // The rehearsal's fee claimer is a plain wallet, not the treasury PDA: what that wallet claimed, held by it.
      expect(fees.toLenders).toMatchObject({ claimedSol: 0.010146324, pendingSol: 0, holder: TREASURY });
      expect(fees.toLenders.note).toMatch(/plain wallet/);
      expect(fees.history.map((row) => [row.kind, row.solAmount, row.t])).toEqual([
        ['partnerTradingFee', 0.00728342, '2026-10-03T19:21:00+05:30'],
        ['curveComplete', 0.00728342, '2026-10-03T19:20:00+05:30'],
      ]);
      expect(fees.history[0].explorerUrl).toBe(devnetTx(feeRow(1, 'x').signature));
      expect(h.live.claims).toHaveBeenCalledWith(DBC_POOL, REHEARSAL.dbcConfig, null);
    });

    it("the treasury PDA's claims: SOL into the lending pool, the same sum as /buybacks; the leftover burned", async () => {
      const events = new MemoryEventStore();
      setup({
        state: { curve: rehearsalCurve(), damm: rehearsalDamm() },
        page: { treasury: new EventTreasuryClaimsSource(events, PROGRAM_ID) },
      });
      const pda = partnerTreasuryAddress(PROGRAM_ID).toBase58();
      const vault = findVaultPda(PROGRAM_ID, findPoolPda(PROGRAM_ID)[0])[0].toBase58();
      // The launch names the program's treasury PDA as fee claimer and leftover receiver.
      h.live.claims.mockResolvedValue({ ...rehearsalClaims(), partner: pda, leftoverReceiver: pda });
      const claim = (n: number, kind: string, lamportsToPool: string, tokensBurned: string, mint = MINT) =>
        ({
          signature: `5treasury${n}`,
          ix: 0,
          slot: 4_000 + n,
          epoch: 2,
          blockTime: null,
          name: 'TreasuryClaimed',
          data: { kind, mint, source: DBC_POOL, position: PublicKey.default.toBase58(), lamportsToPool, tokensBurned },
        }) satisfies StoredProgramEvent;
      await events.insert([
        claim(1, 'tradingFee', '7283420', '0'),
        claim(2, 'leftover', '0', '639263000567'),
        claim(3, 'lpFee', '2862904', '1500000'),
        // Another launch's claim does not count.
        claim(4, 'tradingFee', '999', '0', TRADER),
      ]);
      const fees = await h.page.fees('rREH');
      const feed = await new BuybackFeed({
        chain: {
          network: 'devnet',
          revenueTokenByMint: async () => null,
          escrowAvailable: async () => 0n,
          decimals: async () => 6,
          epochInfo: async () => ({ epoch: 2, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 864_000 }),
          escrowAddress: () => PublicKey.default,
          treasuryAddress: () => new PublicKey(pda),
        },
        events,
      }).get(MINT);
      expect(fees.toLenders).toEqual({
        claimedSol: feed.treasury.totals.toLendersSol,
        pendingSol: 0,
        holder: vault,
        note: expect.stringContaining('claimed into the Epoch lending pool as income; tokens burned'),
      });
      expect(fees.toLenders.claimedSol).toBe(0.010146324);
      expect(fees.leftover).toEqual({
        receiver: pda,
        tokens: 0,
        withdrawn: true,
        burned: true,
        burnedTokens: 639_263.000567,
      });
      expect(fees.leftover.burnedTokens).toBe(feed.treasury.byKind.leftover.tokensBurned);
      expect(fees.source).toMatch(/TreasuryClaimed/);
    });

    it('409 before the curve exists', async () => {
      setup();
      await expect(h.page.fees('rUPC')).rejects.toMatchObject({ statusCode: 409, code: 'NOT_LAUNCHED' });
      h.live.claims.mockResolvedValue(null);
      await expect(h.page.fees(MINT)).rejects.toMatchObject({ statusCode: 409, code: 'NOT_LAUNCHED' });
    });
  });

  describe('the buy/sell ticket', () => {
    it('quotes on the curve with the default 1% slippage and the demo warning', async () => {
      setup();
      const response = await h.page.quote('rREH', { side: 'buy', amount: 0.1 });
      expect(response).toMatchObject({
        network: 'devnet',
        mint: MINT,
        quote: fakeQuote('buy', 0.1),
        validForSeconds: 15,
      });
      expect(response.warnings).toEqual(['devnet demo: no real value. Nothing here is an offer.']);
      expect(h.live.quote).toHaveBeenCalledWith(
        { dbcPool: DBC_POOL, dbcConfig: REHEARSAL.dbcConfig, dammPool: null, mint: MINT, decimals: 6 },
        'buy',
        0.1,
        100,
      );
    });

    it('routes to DAMM v2 once graduated, and warns of a high price impact', async () => {
      setup({ state: { curve: rehearsalCurve(), damm: rehearsalDamm() } });
      h.live.quote.mockImplementationOnce(async () => ({
        ...fakeQuote('sell', 50_000, 'damm-v2'),
        priceImpactPct: 7.5,
      }));
      const response = await h.page.quote(MINT, { side: 'sell', amount: 50_000, slippageBps: 300 });
      expect(response.quote.venue).toBe('damm-v2');
      expect(response.warnings).toContain('High price impact: 7.5% (a small pool).');
      expect(h.live.quote.mock.calls[0][0]).toMatchObject({ dammPool: DAMM_POOL });
      expect(h.live.quote.mock.calls[0][3]).toBe(300);
    });

    it('answers the pool’s refusals as HTTP errors the ticket can show', async () => {
      setup();
      await expect(h.page.quote(MINT, { side: 'buy', amount: 11 })).rejects.toMatchObject({
        statusCode: 400,
        code: 'AMOUNT_TOO_LARGE',
        details: { maxSol: 10 },
      });
      expect(h.live.quote).not.toHaveBeenCalled();
      h.live.quote.mockRejectedValueOnce(new LaunchTradeError('CURVE_COMPLETE', 'The raise is complete'));
      await expect(h.page.quote(MINT, { side: 'buy', amount: 1 })).rejects.toMatchObject({
        statusCode: 409,
        code: 'CURVE_COMPLETE',
      });
      h.live.quote.mockRejectedValueOnce(new LaunchTradeError('AMOUNT_TOO_SMALL', 'Too small'));
      await expect(h.page.quote(MINT, { side: 'sell', amount: 0.000001 })).rejects.toMatchObject({ statusCode: 400 });
      await expect(h.page.quote('rUPC', { side: 'buy', amount: 1 })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NOT_LAUNCHED',
      });
    });

    it('builds an unsigned transaction for the wallet only with consent', async () => {
      setup();
      const request = { side: 'buy' as const, amount: 0.1, owner: TRADER, minimumOut: 31_000, consent: true };
      await expect(h.page.build(MINT, { ...request, consent: false })).rejects.toMatchObject({
        statusCode: 400,
        code: 'CONSENT_REQUIRED',
      });
      await expect(h.page.build(MINT, { ...request, owner: 'not-a-key' })).rejects.toMatchObject({ statusCode: 400 });
      expect(h.live.build).not.toHaveBeenCalled();

      const built = await h.page.build(MINT, request);
      expect(built).toMatchObject({
        feePayer: TRADER,
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 4_200,
        explorerCluster: 'devnet',
        validForSeconds: 60,
        quote: { minimumOut: 31_000, venue: 'dbc' },
      });
      const tx = Transaction.from(Buffer.from(built.transaction, 'base64'));
      expect(tx.feePayer?.toBase58()).toBe(TRADER);
      expect(tx.signatures.every((entry) => entry.signature === null)).toBe(true);
      expect(h.live.build).toHaveBeenCalledWith(
        expect.objectContaining({ mint: MINT }),
        'buy',
        0.1,
        100,
        TRADER,
        31_000,
      );
    });
  });

  describe('the first-paint bundle', () => {
    it('every block in one response, with the links and the stream channel', async () => {
      setup();
      await h.store.insertTrades([0, 1].map((n) => storedTrade(n, NOW - 5 * 60_000)));
      const page = await h.page.page('rREH');
      expect(page).toMatchObject({
        schemaVersion: 1,
        network: 'devnet',
        launch: { mint: MINT, symbol: 'rREH', status: 'curve' },
        market: { venue: 'dbc', priceSol: 0.0000031 },
        candles: { interval: '15m', basis: 'trades' },
        holders: { count: { all: 4, buyers: 1 } },
        fees: { partner: { address: TREASURY } },
        stream: { channel: `launch:${MINT}` },
        links: {
          buybacks: `/v1/launches/${MINT}/buybacks`,
          trades: `/v1/launches/${MINT}/trades`,
          candles: `/v1/launches/${MINT}/candles`,
          holders: `/v1/launches/${MINT}/holders`,
          fees: `/v1/launches/${MINT}/fees`,
        },
        unavailable: [],
      });
      expect(page.trades).toHaveLength(2);
      expect(page.detail).toMatchObject({ curve: { dbcPool: DBC_POOL }, token: { supply: 1_000_000 } });
      expect(page.detail).not.toHaveProperty('schemaVersion');
      expect(page.holders).not.toHaveProperty('schemaVersion');
      expect(page.holders).not.toHaveProperty('mint');
      expect(page.fees).not.toHaveProperty('asOf');
      // The revenue-token record: rREH is not registered with the program, so the launch record's terms, with the
      // program's PDAs; the program's own fields stay null until it is.
      expect(page.revenueToken).toEqual({
        source: 'registry',
        address: revenueTokenAddress(PROGRAM_ID, VOTE).toBase58(),
        buybackEscrow: ESCROW,
        treasury: partnerTreasuryAddress(PROGRAM_ID).toBase58(),
        registeredOnChain: false,
        shareBps: 500,
        termEpochs: 10,
        startEpoch: 1,
        endEpoch: 10,
        registeredEpoch: null,
        status: null,
        dammPool: null,
        operator: null,
        commissionFloorBps: null,
        escrow: null,
        buybacks: null,
        totals: null,
        note: "Not registered with the program yet: the terms are the launch record's.",
      });
      // The program was read once for the page: the RevenueToken and escrow PDAs on the program's cluster.
      expect(h.revenueChain.accounts).toHaveBeenCalledWith([
        revenueTokenAddress(PROGRAM_ID, VOTE),
        new PublicKey(ESCROW),
      ]);
    });

    it("a registered token: the program's terms and escrow balance on the page", async () => {
      setup();
      const token = revenueTokenAddress(PROGRAM_ID, VOTE);
      const escrow = new PublicKey(ESCROW);
      // A RevenueToken as the program wrote it (rLOC's bytes from the local stand-in), re-pointed at rREH's mint.
      const data = Buffer.from(RLOC.data, 'base64');
      new PublicKey(MINT).toBuffer().copy(data, FIELD_OFFSETS.RevenueToken.mint);
      h.revenueChain.accounts.mockImplementation(async (addresses: readonly PublicKey[]) =>
        addresses.map((address) => {
          if (address.equals(token)) return { data, lamports: RLOC.lamports };
          if (address.equals(escrow)) return { data: new Uint8Array(0), lamports: 890_880 + 250_000_000 };
          return null;
        }),
      );
      const page = await h.page.page(MINT);
      expect(page.revenueToken).toMatchObject({
        source: 'program',
        address: token.toBase58(),
        buybackEscrow: ESCROW,
        treasury: partnerTreasuryAddress(PROGRAM_ID).toBase58(),
        registeredOnChain: true,
        shareBps: 500,
        termEpochs: 10,
        startEpoch: 1,
        endEpoch: 10,
        registeredEpoch: 0,
        escrow: { balanceSol: 0.25, asOf: expect.stringMatching(IST) },
        buybacks: { slicesPerEpoch: 12, paused: false, redeemOpen: false },
        totals: { escrowedSol: 0, buybacks: 0 },
        note: null,
      });
    });

    it('lists the blocks it could not read, and shows them as unavailable rather than empty', async () => {
      setup();
      h.live.topHolders.mockRejectedValue(new Error('429 Too Many Requests'));
      const page = await h.page.page(MINT);
      expect(page.unavailable).toEqual(['holders']);
      expect(page.holders).toBeNull();
      expect(page.note).toContain('Not available right now: holders.');
    });

    it('an upcoming launch: no fees block, an upcoming market', async () => {
      setup();
      const page = await h.page.page('rUPC');
      expect(page.fees).toBeNull();
      expect(page.market.graduation.state).toBe('upcoming');
      expect(page.ingest.pools).toEqual([]);
    });
  });

  describe('the stream and the ingester wiring', () => {
    it('pushes new trades in chain order, then the market; fee events as they come', async () => {
      setup();
      const sent: [string, LaunchStreamMessage][] = [];
      h.page.setPublisher((mint, message) => sent.push([mint, message]));
      h.page.onTrades(MINT, [storedTrade(2, NOW), storedTrade(1, NOW)]);
      for (let i = 0; i < 50 && sent.length < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(sent.map(([mint, message]) => [mint, message.type])).toEqual([
        [MINT, 'trade'],
        [MINT, 'trade'],
        [MINT, 'market'],
      ]);
      expect(sent.map(([, message]) => (message.type === 'trade' ? message.trade.slot : null))).toEqual([
        3_001,
        3_002,
        null,
      ]);
      h.page.onFeeEvents(MINT, [feeRow(2, 'lpFee', { pool: DAMM_POOL, solLamports: 2_862_904n })]);
      expect(sent[3]).toEqual([
        MINT,
        { type: 'fee', event: expect.objectContaining({ kind: 'lpFee', solAmount: 0.002862904 }) },
      ]);
    });

    it('a snapshot for a new subscriber, channels by mint or symbol', async () => {
      setup();
      await h.store.insertTrades([storedTrade(0, NOW)]);
      const snapshot = await h.page.snapshot(MINT);
      expect(snapshot).toMatchObject({ type: 'snapshot', market: { venue: 'dbc' }, trades: [{ slot: 3_000 }] });
      expect(h.page.isLaunch('rreh')).toBe(true);
      expect(h.page.isLaunch(MINT)).toBe(true);
      expect(h.page.isLaunch('rNOPE')).toBe(false);
      expect(h.page.mintOf('rREH')).toBe(MINT);
    });

    it('gives the ingester each launch’s pools, the DAMM v2 pool once graduated', async () => {
      setup();
      expect(await h.page.ingestLaunches()).toEqual([
        {
          mint: MINT,
          symbol: 'rREH',
          pools: [{ address: DBC_POOL, info: { venue: 'dbc', baseDecimals: 6, collectFeeMode: 0 } }],
        },
      ]);
      h.state.curve = rehearsalCurve();
      h.state.damm = rehearsalDamm();
      h.clock.now += 61_000;
      h.page.onTrades(MINT, []);
      const [launch] = await h.page.ingestLaunches();
      expect(launch.pools.map((pool) => [pool.address, pool.info.venue])).toEqual([
        [DBC_POOL, 'dbc'],
        [DAMM_POOL, 'damm-v2'],
      ]);
    });
  });

  it('builds explorer links for a local validator stand-in', async () => {
    setup({ page: { explorer: { cluster: 'devnet', customRpc: 'http://127.0.0.1:38899' } } });
    await h.store.insertTrades([storedTrade(0, NOW)]);
    const [trade] = (await h.page.trades(MINT, {})).trades;
    expect(trade.explorerUrl).toBe(
      `https://explorer.solana.com/tx/${trade.signature}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A38899`,
    );
    expect(curveMidRaise().dbcPool).toBe(DBC_POOL);
  });
});
