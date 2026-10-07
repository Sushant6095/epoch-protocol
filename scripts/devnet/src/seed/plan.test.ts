import * as sdk from '@epoch/epoch-sdk';

import { parseLaunchConfig, planLaunch } from '@epoch/meteora';
import { PublicKey } from '@solana/web3.js';

import { revenueTokenLaunchConfig } from '../commands/seed';
import { rentFromPerByte, totals } from '../lib/budget';
import { loadParams } from '../lib/params';
import { DEVNET_PLAN, quotesHeld, revenueShareLamports, revenueTokenLamports, seedLines, seedWallets } from './plan';

describe('DEVNET_PLAN', () => {
  const params = loadParams();

  it('keeps the junior tranche above its floor after the deposits', () => {
    const junior = DEVNET_PLAN.deposits.filter((d) => d.tranche === 'junior').reduce((a, d) => a + d.lamports, 0n);
    const total = DEVNET_PLAN.deposits.reduce((a, d) => a + d.lamports, 0n);
    expect((junior * 10_000n) / total).toBeGreaterThanOrEqual(BigInt(params.minJuniorBps));
  });

  it('gives every borrower a credit limit of at least its advance after MIN_REVENUE_HISTORY sweeps', () => {
    for (const v of DEVNET_PLAN.validators.filter((x) => x.advance > 0n)) {
      const history = sdk.PROGRAM_CONSTANTS.MIN_REVENUE_HISTORY;
      const limit = sdk.creditLimit({
        trailingRevenue: v.revenuePerEpoch * BigInt(history),
        historyEpochs: history,
        advanceBps: v.score.hedged ? params.advanceBpsHedged : params.advanceBpsUnhedged,
        bondLamports: v.bond,
        bondMultiplier: params.bondMultiplier,
        capLamports: params.maxAdvanceLamports,
      });
      expect(limit).toBeGreaterThanOrEqual(v.advance);
      expect(v.advance).toBeGreaterThanOrEqual(params.minAdvanceLamports);
      expect(sdk.computeScore(v.score)).toBeGreaterThanOrEqual(params.minScore);
    }
  });

  it('keeps the advances inside the utilization cap of the deposits', () => {
    const deposits = DEVNET_PLAN.deposits.reduce((a, d) => a + d.lamports, 0n);
    const lent = DEVNET_PLAN.validators.reduce((a, v) => a + v.advance, 0n);
    expect(lent * 10_000n).toBeLessThanOrEqual(deposits * BigInt(params.maxUtilizationBps));
  });

  it('lists the signing wallets once each', () => {
    expect(seedWallets(DEVNET_PLAN)).toEqual([
      'lender1',
      'lender2',
      'lender3',
      'operator1',
      'operator2',
      'maker',
      'rewards',
    ]);
  });

  it('prices the plan on devnet rent, separating recoverable working capital', () => {
    const lines = seedLines(DEVNET_PLAN, rentFromPerByte(5_080n), {
      voteAccount: 3_762,
      voteReserve: params.voteReserveLamports,
    });
    const t = totals(lines);
    // deposits 6 + bonds 0.75 + revenue float 2.3 + quote collateral 6 × 0.2 + swap collateral 0.1
    expect(t.recoverable).toBe(10_350_000_000n);
    expect(t.spent).toBeGreaterThan(0n);
    expect(t.spent).toBeLessThan(1_000_000_000n);
    expect(lines.every((l) => l.lamports > 0n)).toBe(true);
  });

  it('holds the rolling quotes plus the one the swap keeps open', () => {
    expect(quotesHeld(DEVNET_PLAN)).toBe(DEVNET_PLAN.quotes.epochsAhead + 1);
    expect(DEVNET_PLAN.swap.notional).toBeLessThanOrEqual(DEVNET_PLAN.quotes.maxNotional);
    expect(DEVNET_PLAN.swap.epochsAhead).toBeLessThanOrEqual(DEVNET_PLAN.quotes.epochsAhead);
  });

  it('puts the revenue token on a validator that never borrows, with terms the program accepts', () => {
    const token = DEVNET_PLAN.revenueToken!;
    const v = DEVNET_PLAN.validators.find((x) => x.name === token.validator)!;
    expect(v.advance).toBe(0n);
    expect(token.shareBps).toBeGreaterThanOrEqual(1);
    expect(token.shareBps).toBeLessThanOrEqual(5_000);
    expect(token.termEpochs).toBeGreaterThanOrEqual(10);
    // 10% of 0.3 SOL for MIN_REVENUE_HISTORY sweeps
    expect(revenueShareLamports(DEVNET_PLAN)).toBe(30_000_000n * BigInt(sdk.PROGRAM_CONSTANTS.MIN_REVENUE_HISTORY));
  });

  it('writes a launch config the launch CLI accepts, and a curve it can build', () => {
    const token = DEVNET_PLAN.revenueToken!;
    const v = DEVNET_PLAN.validators.find((x) => x.name === token.validator)!;
    const raw = revenueTokenLaunchConfig(token, v, PublicKey.unique(), PublicKey.unique());
    const config = parseLaunchConfig(JSON.parse(JSON.stringify(raw)));
    expect(config.avgRevenueSol).toBe(0.3);
    expect(config.initialBuySol).toBe(0.02);
    const plan = planLaunch({ config, avgRevenueSol: 0.3, startEpoch: 2 });
    expect(plan.curve.migrationThresholdSol).toBeGreaterThan(config.initialBuySol!);
    // Devnet's DBC build refuses a fixed supply with nothing left over (InvalidTokenSupply).
    expect(plan.curve.leftoverTokens).toBeGreaterThan(0);
    expect(plan.curve.migrationThresholdSol).toBeCloseTo(0.1, 6);
  });

  it("funds the token's operator for the launch CLI's payer check: launch, first buy, registration, margin", () => {
    // createConfig 1,048 + pool 424 + mint 82 + 2 vaults + metadata 679 (+ 0.01 SOL Metaplex fee) + buyer account at
    // 6,960 lamports/byte, 4 signatures, the 0.02 SOL buy; registration 503 + 0 + 165 bytes; one fee; 0.01 SOL margin.
    const rent = (n: number) => BigInt((n + 128) * 6_960);
    const expected =
      rent(1_048) +
      rent(424) +
      rent(82) +
      2n * rent(165) +
      rent(679) +
      10_000_000n +
      20_000n +
      20_000_000n +
      rent(165) +
      rent(503) +
      rent(0) +
      rent(165) +
      5_000n +
      10_000_000n;
    expect(revenueTokenLamports(DEVNET_PLAN.revenueToken!)).toBe(expected);
  });
});
