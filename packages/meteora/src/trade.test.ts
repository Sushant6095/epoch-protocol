import { SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import { revenueCurveConfig } from './curve';
import { launchBand } from './math';
import { dbcClient } from './pools';
import {
  dammSwapAmounts,
  dbcSwapAmounts,
  LaunchTradeError,
  quoteTrade,
  type RawSwapAmounts,
  toTradeQuote,
} from './trade';
import { toBN } from './units';

// No request is ever sent: the connection only backs the SDK clients, and the quotes below are simulated.
const connection = new Connection('http://127.0.0.1:1');
const RKEST = launchBand({ avgRevenueSol: 20.8, shareBps: 500, termEpochs: 100, supply: 100_000 });
const curve = revenueCurveConfig({ ...RKEST, supply: 100_000, decimals: 6, raiseTargetSol: 5 });
const SOL = 1_000_000_000n;

describe('toTradeQuote', () => {
  const buy: RawSwapAmounts = {
    side: 'buy',
    venue: 'dbc',
    inputIncludingFee: 1n * SOL,
    inputExcludingFee: 990_000_000n,
    outputAmount: 1_000_000_000n, // 1,000 tokens at 6 decimals
    minimumOut: 990_000_000n,
    fee: 10_000_000n,
    feeOnInput: true,
    feeInBase: false,
    spotPriceSol: 0.00099,
    baseDecimals: 6,
    quoteDecimals: 9,
  };

  it('reports UI amounts, the fee in SOL and the price move before fees', () => {
    expect(toTradeQuote(buy)).toEqual({
      side: 'buy',
      amountIn: 1,
      amountOut: 1_000,
      minimumOut: 990,
      // 0.99 SOL for 1,000 tokens = 0.00099: no move.
      priceImpactPct: 0,
      tradingFeeSol: 0.01,
      venue: 'dbc',
    });
  });

  it('values a fee charged in the token at the spot price, and adds it back to the output', () => {
    const quote = toTradeQuote({
      ...buy,
      venue: 'damm-v2',
      inputExcludingFee: 1n * SOL,
      outputAmount: 990_000_000n,
      fee: 10_000_000n, // 10 tokens
      feeOnInput: false,
      feeInBase: true,
      spotPriceSol: 0.0009,
    });
    expect(quote.tradingFeeSol).toBeCloseTo(0.009, 12);
    expect(quote.amountOut).toBe(990);
    // 1 SOL for 1,000 tokens gross = 0.001 against a 0.0009 spot.
    expect(quote.priceImpactPct).toBeCloseTo(11.1111, 4);
  });

  it('prices a sell as SOL out per token in', () => {
    const quote = toTradeQuote({
      side: 'sell',
      venue: 'dbc',
      inputIncludingFee: 500_000_000n, // 500 tokens
      inputExcludingFee: 500_000_000n,
      outputAmount: 396_000_000n, // 0.396 SOL after a 1% fee
      minimumOut: 392_040_000n,
      fee: 4_000_000n,
      feeOnInput: false,
      feeInBase: false,
      spotPriceSol: 0.0008,
      baseDecimals: 6,
      quoteDecimals: 9,
    });
    expect(quote).toMatchObject({ side: 'sell', amountIn: 500, amountOut: 0.396, minimumOut: 0.39204 });
    expect(quote.tradingFeeSol).toBeCloseTo(0.004, 12);
    expect(quote.priceImpactPct).toBe(0);
  });
});

describe('DBC quotes (simulated on a fresh rKEST curve)', () => {
  const simulate = (sol: bigint) =>
    dbcClient(connection).pool.getQuoteFromInputAmount({
      config: curve.config,
      swapBaseForQuote: false,
      amountIn: toBN(sol),
      swapMode: SwapMode.PartialFill,
      slippageBps: 100,
    });

  it('quotes a 1 SOL buy from the band low, fee on the SOL in', () => {
    const quote = toTradeQuote(
      dbcSwapAmounts({
        side: 'buy',
        result: simulate(1n * SOL),
        collectFeeMode: 0,
        spotPriceSol: RKEST.bandLowSol,
        baseDecimals: 6,
        slippageBps: 100,
      }),
    );
    expect(quote.venue).toBe('dbc');
    expect(quote.amountIn).toBe(1);
    expect(quote.tradingFeeSol).toBeCloseTo(0.01, 9);
    // 0.99 SOL buys between 0.99 ÷ 0.000988 and 0.99 ÷ 0.000624 tokens; the price rises as it fills.
    expect(quote.amountOut).toBeGreaterThan(0.99 / RKEST.bandHighSol);
    expect(quote.amountOut).toBeLessThan(0.99 / RKEST.bandLowSol);
    expect(quote.minimumOut).toBeCloseTo(quote.amountOut * 0.99, 4);
    expect(quote.priceImpactPct).toBeGreaterThan(0);
    expect(quote.priceImpactPct).toBeLessThan(25);
  });

  it('fills a buy larger than the rest of the raise only up to the threshold (PartialFill)', () => {
    const result = simulate(10n * SOL);
    expect(result.amountLeft.gt(new BN(0))).toBe(true);
    const quote = toTradeQuote(
      dbcSwapAmounts({
        side: 'buy',
        result,
        collectFeeMode: 0,
        spotPriceSol: RKEST.bandLowSol,
        baseDecimals: 6,
        slippageBps: 100,
      }),
    );
    // The whole raise plus its 1% fee, not the 10 SOL offered.
    expect(quote.amountIn).toBeCloseTo(curve.migrationThresholdSol / 0.99, 2);
    expect(quote.amountOut).toBeCloseTo(curve.tokensOnCurve, 0);
  });
});

describe('dammSwapAmounts', () => {
  const result = {
    includedFeeInputAmount: new BN(1_000_000_000),
    excludedFeeInputAmount: new BN(1_000_000_000),
    outputAmount: new BN(460_000_000),
    claimingFee: new BN(3_000_000),
    compoundingFee: new BN(0),
    protocolFee: new BN(1_000_000),
    referralFee: new BN(0),
  };

  it('takes the fee in SOL on the way in for an only-B pool when buying the A token', () => {
    const raw = dammSwapAmounts({
      side: 'buy',
      result: { ...result, excludedFeeInputAmount: new BN(996_000_000) },
      collectFeeMode: 1,
      baseIsTokenA: true,
      spotPriceSol: 0.00215,
      baseDecimals: 6,
      quoteDecimals: 9,
      slippageBps: 100,
    });
    expect(raw).toMatchObject({ venue: 'damm-v2', feeOnInput: true, feeInBase: false, fee: 4_000_000n });
    expect(raw.minimumOut).toBe(455_400_000n);
    expect(toTradeQuote(raw).tradingFeeSol).toBeCloseTo(0.004, 12);
  });

  it('takes the fee in the token on the way out for a both-token pool when buying', () => {
    const raw = dammSwapAmounts({
      side: 'buy',
      result,
      collectFeeMode: 0,
      baseIsTokenA: true,
      spotPriceSol: 0.00215,
      baseDecimals: 6,
      quoteDecimals: 9,
      slippageBps: 50,
    });
    expect(raw).toMatchObject({ feeOnInput: false, feeInBase: true });
    // 4 tokens of fee at 0.00215 SOL.
    expect(toTradeQuote(raw).tradingFeeSol).toBeCloseTo(0.0086, 12);
  });
});

describe('quoteTrade', () => {
  const mint = new PublicKey(new Uint8Array(32).fill(1));

  it('refuses an upcoming launch with no pool before any RPC call', async () => {
    await expect(
      quoteTrade({ connection, launch: { mint, decimals: 6 }, side: 'buy', amount: 1 }),
    ).rejects.toMatchObject({ name: 'LaunchTradeError', code: 'NOT_LAUNCHED' });
  });

  it('refuses a slippage outside 0–9,999 bps', async () => {
    await expect(
      quoteTrade({ connection, launch: { mint, decimals: 6 }, side: 'buy', amount: 1, slippageBps: 10_000 }),
    ).rejects.toThrow(RangeError);
  });

  it('exposes a typed error', () => {
    const error = new LaunchTradeError('CURVE_COMPLETE', 'done');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('CURVE_COMPLETE');
  });
});
