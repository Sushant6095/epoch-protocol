import {
  type BuybackVenueState,
  dbcBuy,
  findBuybackEscrowPda,
  findRevenueTokenPda,
  METEORA,
  minOutFloor,
  REVENUE_TOKEN_FLAGS,
  type RevenueTokenAccount,
} from '@epoch/epoch-sdk';
import { type PublicKey } from '@solana/web3.js';

import {
  type BuybackMarket,
  type BuybackVenueSnapshot,
  type Graduation,
  type SliceQuote,
} from '../Chain/BuybackMarket';
import { key, PROGRAM_ID, revenueToken, SOL } from '../__fixtures__/accounts';
import { atAddress, FakeChain, programFailure, transientFailure } from '../__fixtures__/FakeChain';
import { BuybackJob } from './BuybackJob';

const Q64 = 1n << 64n;
const L = 1_000_000_000n << 65n;
/** A two-segment curve at √P = 1: 100 bps of impact allows 9,999,999 lamports (see the SDK's math tests). */
const dbcState: BuybackVenueState = {
  kind: 'dbc',
  sqrtPrice: Q64,
  quoteReserve: 0n,
  isMigrated: false,
  migrationSqrtPrice: 4n * Q64,
  migrationQuoteThreshold: 10n * SOL,
  curve: [
    { sqrtPrice: 2n * Q64, liquidity: L },
    { sqrtPrice: 4n * Q64, liquidity: 2n * L },
  ],
};
const IMPACT_CAPPED = 9_999_999n;
const FEE_FREE = dbcBuy(dbcState.curve, Q64, 4n * Q64, IMPACT_CAPPED).output;
const FLOOR = minOutFloor(FEE_FREE, 300);

/** A market that quotes the fee-free output less a 1% pool fee, like Epoch's pools. */
class FakeMarket implements BuybackMarket {
  state: BuybackVenueState = dbcState;
  graduated: Graduation | null = null;
  feeBps = 100n;
  quotes: { lamportsIn: bigint; slippageBps: number }[] = [];
  venues: RevenueTokenAccount[] = [];

  async venue(token: RevenueTokenAccount): Promise<BuybackVenueSnapshot | null> {
    this.venues.push(token);
    return {
      kind: token.dammPool ? 'dammV2' : 'dbc',
      pool: token.dammPool ?? token.dbcPool,
      state: this.state,
      quote: async (lamportsIn: bigint, slippageBps: number): Promise<SliceQuote> => {
        this.quotes.push({ lamportsIn, slippageBps });
        const amountOut = (FEE_FREE * (10_000n - this.feeBps)) / 10_000n;
        return { lamportsIn, amountOut, minimumOut: (amountOut * BigInt(10_000 - slippageBps)) / 10_000n };
      },
    };
  }

  async graduation(): Promise<Graduation | null> {
    return this.graduated;
  }
}

const RENT0 = BigInt(128 * 6_960);
const escrowOf = (vote: PublicKey) => findBuybackEscrowPda(PROGRAM_ID, vote)[0];
const sliceOf = (data: Buffer) => data[8];
const minOutOf = (data: Buffer) => data.readBigUInt64LE(9);

describe('BuybackJob', () => {
  let chain: FakeChain;
  let market: FakeMarket;
  const job = () => new BuybackJob(chain, market, { slippageBps: 100, maxAttempts: 3, computeUnitLimit: 300_000 });

  beforeEach(() => {
    chain = new FakeChain();
    chain.epoch = 100n;
    chain.slotIndex = 800n; // slices 0 and 1 of 12 over 9,000 slots are due
    chain.revenueTokenAccounts = [atAddress(revenueToken(), 130)];
    chain.balances.set(escrowOf(key(20)).toBase58(), 12n * SOL + RENT0);
    market = new FakeMarket();
  });

  it('runs the earliest due slice: the planned amount, a min-out from a fresh quote, the buyback compute budget', async () => {
    await expect(job().run(100n)).resolves.toBe('done');
    expect(chain.executed()).toEqual(['execute_buyback']);
    const [call] = chain.calls;
    const ix = call.instructions[0];
    expect(sliceOf(ix.data)).toBe(0);
    // 12 SOL over 12 slices is 1 SOL, but the 100 bps impact cap binds.
    expect(market.quotes).toEqual([{ lamportsIn: IMPACT_CAPPED, slippageBps: 100 }]);
    const amountOut = (FEE_FREE * 9_900n) / 10_000n;
    expect(minOutOf(ix.data)).toBe((amountOut * 9_900n) / 10_000n);
    expect(minOutOf(ix.data) >= FLOOR).toBe(true);
    expect(call.options).toEqual({ computeUnitLimit: 300_000 });
    // Accounts: cranker, revenue token, escrow, … venue pool at 8, venue program at 13.
    expect(ix.keys[1].pubkey.equals(findRevenueTokenPda(PROGRAM_ID, key(20))[0])).toBe(true);
    expect(ix.keys[8].pubkey.equals(key(101))).toBe(true);
    expect(ix.keys[13].pubkey.equals(METEORA.DBC_PROGRAM_ID)).toBe(true);
  });

  it('is idempotent per (epoch, slice): slices done on chain or sent this epoch are not sent again', async () => {
    chain.slotIndex = 100n; // only slice 0 is due
    const runner = job();
    await runner.run(100n);
    await runner.run(100n); // the chain has not caught up yet: still not re-sent
    expect(chain.executed()).toEqual(['execute_buyback']);

    chain.slotIndex = 800n; // slices 0 and 1 are due, 2 is due at slot 1,500
    chain.revenueTokenAccounts = [atAddress(revenueToken({ buybackEpoch: 100n, slicesDone: 0b11 }), 130)];
    await job().run(100n);
    expect(chain.executed()).toEqual(['execute_buyback']);

    // Slice 0 ran this epoch: the budget was fixed then.
    const ranSlice0 = { buybackEpoch: 100n, slicesDone: 0b1, epochBudget: 12n * SOL, epochSpent: IMPACT_CAPPED };
    chain.revenueTokenAccounts = [atAddress(revenueToken(ranSlice0), 130)];
    await job().run(100n);
    expect(sliceOf(chain.calls[1].instructions[0].data)).toBe(1);
    // A bitmap from an earlier epoch does not count: the program resets it.
    chain.revenueTokenAccounts = [atAddress(revenueToken({ buybackEpoch: 99n, slicesDone: 0b11 }), 130)];
    await job().run(100n);
    expect(sliceOf(chain.calls[2].instructions[0].data)).toBe(0);
  });

  it('waits for this epoch’s sweep during the term, but not after it', async () => {
    chain.revenueTokenAccounts = [atAddress(revenueToken({ lastShareEpoch: 99n }), 130)];
    await job().run(100n);
    expect(chain.calls).toEqual([]);

    chain.epoch = 150n;
    chain.revenueTokenAccounts = [atAddress(revenueToken({ lastShareEpoch: 99n }), 130)];
    await job().run(150n);
    expect(chain.executed()).toEqual(['execute_buyback']);
  });

  it('never sends a min-out below the program floor, and gives a slice up after maxAttempts', async () => {
    chain.slotIndex = 100n; // only slice 0 is due
    market.feeBps = 500n; // a 5% fee: the quote's min-out falls below the 3% floor
    const runner = job();
    for (let i = 0; i < 5; i++) await runner.run(100n);
    expect(chain.calls).toEqual([]);
    expect(market.quotes).toHaveLength(3);
  });

  it('retries a failed send up to maxAttempts; a slice the program says is over is not retried', async () => {
    chain.slotIndex = 100n; // only slice 0 is due
    chain.onExecute = () => programFailure('BuybackOutputTooLow', 6077);
    let runner = job();
    for (let i = 0; i < 5; i++) await runner.run(100n);
    expect(chain.executed()).toHaveLength(3);

    chain.calls.length = 0;
    chain.onExecute = () => transientFailure();
    runner = job();
    for (let i = 0; i < 2; i++) await runner.run(100n);
    expect(chain.executed()).toHaveLength(2);

    chain.calls.length = 0;
    chain.slotIndex = 800n; // slices 0 and 1 are due
    chain.onExecute = () => programFailure('SliceAlreadyExecuted', 6071);
    runner = job();
    await runner.run(100n);
    await runner.run(100n); // slice 0 is over: slice 1 is next
    expect(chain.calls.map((c) => sliceOf(c.instructions[0].data))).toEqual([0, 1]);
  });

  it('does not spend attempts on "not yet" errors', async () => {
    chain.onExecute = () => programFailure('SweepPending', 6073);
    const runner = job();
    for (let i = 0; i < 5; i++) await runner.run(100n);
    expect(chain.executed()).toHaveLength(5);
  });

  it('syncs the DAMM v2 pool once the curve migrated, then buys there', async () => {
    market.graduated = { dammConfig: key(103), dammPool: key(104) };
    await job().run(100n);
    expect(chain.executed()).toEqual(['sync_revenue_token_pool']);
    const keys = chain.calls[0].instructions[0].keys.map((k) => k.pubkey.toBase58());
    expect(keys.slice(2)).toEqual([key(101), key(103), key(104)].map((k) => k.toBase58()));

    market.graduated = null;
    market.state = {
      kind: 'dammV2',
      sqrtPrice: Q64,
      liquidity: L,
      sqrtMaxPrice: 1n << 127n,
      collectFeeMode: 1,
      tokenAAmount: 0n,
      tokenBAmount: 0n,
      poolStatus: 0,
    };
    chain.revenueTokenAccounts = [atAddress(revenueToken({ dammPool: key(104), status: 'graduated' }), 130)];
    await job().run(100n);
    const ix = chain.calls[1].instructions[0];
    expect(ix.keys[8].pubkey.equals(key(104))).toBe(true);
    expect(ix.keys[13].pubkey.equals(METEORA.CP_AMM_PROGRAM_ID)).toBe(true);
  });

  it('skips a curve that waits for migration and a paused token', async () => {
    market.state = { ...dbcState, quoteReserve: 10n * SOL } as BuybackVenueState;
    await job().run(100n);
    chain.revenueTokenAccounts = [atAddress(revenueToken({ flags: REVENUE_TOKEN_FLAGS.buybacksPaused }), 130)];
    await job().run(100n);
    expect(chain.calls).toEqual([]);
  });

  it('closes a token after its term once the escrow is spent, once', async () => {
    chain.epoch = 142n;
    chain.balances.set(escrowOf(key(20)).toBase58(), RENT0 + 5_000n);
    const runner = job();
    await runner.run(142n);
    await runner.run(142n);
    expect(chain.executed()).toEqual(['close_revenue_token']);
    const keys = chain.calls[0].instructions[0].keys;
    expect(keys[1].pubkey.equals(key(22))).toBe(true); // the operator gets the rent
  });

  it('only simulates under DRY_RUN', async () => {
    chain.dryRun = true;
    await job().run(100n);
    expect(chain.calls.map((c) => c.kind)).toEqual(['simulate']);
  });

  it('does nothing without revenue tokens', async () => {
    chain.revenueTokenAccounts = [];
    await expect(job().run(100n)).resolves.toBe('done');
    expect(chain.calls).toEqual([]);
    expect(market.venues).toEqual([]);
  });
});
