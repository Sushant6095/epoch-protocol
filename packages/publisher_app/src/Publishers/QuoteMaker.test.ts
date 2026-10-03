import { FakePublisherChain, feeIndex, key, pool, quote, SLOTS_PER_EPOCH, SOL } from '../__fixtures__/fakes';
import { fixedRateFor, QuoteMaker, type QuoteMakerOptions, quoteFinished } from './QuoteMaker';

const OPTIONS: QuoteMakerOptions = { maxNotional: 50n * SOL, maxMoveBps: 2_000, epochsAhead: 5, spreadBps: 0 };

/** post_quote data: discriminator, u64 epoch, u64 fixed_rate, u64 max_notional, u16 max_move_bps, u64 expiry_slot. */
function decodePostQuote(data: Buffer) {
  return {
    epoch: data.readBigUInt64LE(8),
    fixedRate: data.readBigUInt64LE(16),
    maxNotional: data.readBigUInt64LE(24),
    maxMoveBps: data.readUInt16LE(32),
    expirySlot: data.readBigUInt64LE(34),
  };
}

const finalIndex = (epoch: bigint, value: bigint) => feeIndex({ epoch, value, finalizedSlot: 7n });
const posted = (chain: FakePublisherChain) =>
  chain.calls.filter((c) => c.name === 'post_quote').map((c) => decodePostQuote(c.instruction.data));

describe('fixedRateFor', () => {
  it('applies the spread to the last final value, never returning 0', () => {
    expect(fixedRateFor(1_000n, 0)).toBe(1_000n);
    expect(fixedRateFor(1_000n, -200)).toBe(980n);
    expect(fixedRateFor(1_000n, 250)).toBe(1_025n);
    expect(fixedRateFor(1n, -5_000)).toBe(1n);
  });
});

describe('QuoteMaker', () => {
  let chain: FakePublisherChain;
  beforeEach(() => {
    chain = new FakePublisherChain();
    chain.epoch = 100n;
    chain.slot = 100n * SLOTS_PER_EPOCH + 5_000n;
    chain.feeIndexAccount = finalIndex(99n, 1_284n);
  });

  it('quotes each of the next five program epochs at the last final value, expiring at the epoch start', async () => {
    await new QuoteMaker(chain, OPTIONS).tick();
    expect(posted(chain)).toEqual(
      [101n, 102n, 103n, 104n, 105n].map((epoch) => ({
        epoch,
        fixedRate: 1_284n,
        maxNotional: 50n * SOL,
        maxMoveBps: 2_000,
        expirySlot: epoch * SLOTS_PER_EPOCH,
      })),
    );
    expect(chain.calls.every((c) => c.role === 'maker')).toBe(true);
  });

  it('skips epochs it already quotes and epochs not after the last final index epoch', async () => {
    chain.quoteAccounts = [quote({ maker: key(6), epoch: 101n }), quote({ maker: key(9), epoch: 102n })];
    chain.feeIndexAccount = finalIndex(102n, 1_000n); // e.g. a program epoch posted ahead under an offset
    await new QuoteMaker(chain, OPTIONS).tick();
    expect(posted(chain).map((q) => q.epoch)).toEqual([103n, 104n, 105n]);
  });

  it('withdraws its finished quotes once no swap is open against them', async () => {
    chain.quoteAccounts = [
      quote({ maker: key(6), epoch: 99n, openSwaps: 0 }), // epoch started: withdraw
      quote({ maker: key(6), epoch: 100n, openSwaps: 2 }), // started, swaps open: wait for settlement
      quote({ maker: key(6), epoch: 103n, expirySlot: 100n * SLOTS_PER_EPOCH }), // expired early: withdraw
      quote({ maker: key(6), epoch: 104n }), // open: keep
    ];
    await new QuoteMaker(chain, OPTIONS).tick();
    const withdrawn = chain.calls.filter((c) => c.name === 'withdraw_quote').map((c) => c.label);
    expect(withdrawn).toEqual(['withdraw_quote 99', 'withdraw_quote 103']);
    expect(posted(chain).map((q) => q.epoch)).toEqual([101n, 102n, 105n]);
  });

  it('posts nothing before the first final value or while the pool is paused, but still withdraws', async () => {
    chain.quoteAccounts = [quote({ maker: key(6), epoch: 99n })];
    chain.feeIndexAccount = feeIndex();
    await new QuoteMaker(chain, OPTIONS).tick();
    chain.feeIndexAccount = finalIndex(99n, 1_284n);
    chain.poolAccount = pool({ paused: true });
    await new QuoteMaker(chain, OPTIONS).tick();
    expect(chain.calls.map((c) => c.name)).toEqual(['withdraw_quote', 'withdraw_quote']);
  });

  it('stops when the maker cannot fund the next quote’s collateral', async () => {
    // 10 SOL collateral per quote (50 SOL × 20%) plus rent and fees: 25 SOL covers two quotes.
    chain.makerBalance = 25n * SOL;
    await new QuoteMaker(chain, OPTIONS).tick();
    expect(posted(chain).map((q) => q.epoch)).toEqual([101n, 102n]);
  });

  it('does nothing without a maker key', async () => {
    chain.maker = undefined;
    await new QuoteMaker(chain, OPTIONS).tick();
    expect(chain.calls).toEqual([]);
  });

  it('knows when a quote is finished', () => {
    const q = quote({ epoch: 101n, expirySlot: 101n * SLOTS_PER_EPOCH });
    expect(quoteFinished(q, { epoch: 100n, slot: 100n * SLOTS_PER_EPOCH })).toBe(false);
    expect(quoteFinished(q, { epoch: 101n, slot: 101n * SLOTS_PER_EPOCH })).toBe(true);
    expect(quoteFinished({ ...q, expirySlot: 5n }, { epoch: 100n, slot: 5n })).toBe(true);
  });
});
