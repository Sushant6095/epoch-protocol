/**
 * The seed plan: who deposits what, which test validators exist, what revenue they earn, the market and the revenue
 * token. Sized for devnet, where SOL comes by hand: one advance at the pool's 1 SOL minimum, small notionals, and every
 * test validator paying out to the `rewards` wallet that simulates its commission, so swept revenue flows back and the
 * float stays one epoch's worth. Also produces the plan's budget lines (rent from the cluster's own rate).
 */
import * as sdk from '@epoch/epoch-sdk';
import { estimateLaunchCost, rentExemptLamports } from '@epoch/meteora';

import { type BudgetLine, type RentFn, SIGNATURE_FEE, txFee } from '../lib/budget';

const SOL = 1_000_000_000n;
const sol = (n: number): bigint => BigInt(Math.round(n * 1e9));
const sdkSol = (lamports: bigint): string => (Number(lamports) / 1e9).toString();

export type Lender = 'lender1' | 'lender2' | 'lender3';
export type Operator = 'operator1' | 'operator2';

export interface ValidatorSeed {
  name: 'v1' | 'v2' | 'v3';
  operator: Operator;
  /** Legacy vote init on devnet (SIMD-0464 inactive): commission in whole percent. */
  commissionPercent: number;
  bond: bigint;
  /** Simulated commission per epoch, sent into the vote account before each sweep. */
  revenuePerEpoch: bigint;
  score: sdk.ScoreUpdate;
  /** Advance requested after MIN_REVENUE_HISTORY sweeps (0 = never borrows). */
  advance: bigint;
}

export interface SeedPlan {
  deposits: { lender: Lender; tranche: sdk.Tranche; lamports: bigint }[];
  /** A senior withdrawal request the crank processes later. */
  withdrawal: { lender: Lender; tranche: sdk.Tranche; lamports: bigint };
  validators: ValidatorSeed[];
  /**
   * Maker quotes for each of the next `epochsAhead` epochs, kept rolling: every seed run posts the missing ones and
   * takes back those whose epoch has begun with no open swap.
   */
  quotes: { epochsAhead: number; fixedRate: bigint; maxNotional: bigint; maxMoveBps: number };
  /** One swap against the quote `epochsAhead` epochs out (its quote stays open until the swap settles). */
  swap: { taker: Lender; side: sdk.Side; notional: bigint; epochsAhead: number };
  /**
   * A revenue token launched on Meteora's DBC by the validator's operator (payer and pool creator) through
   * `@epoch/meteora`'s launch CLI, then registered (`register_revenue_token`). Skipped on a cluster without DBC.
   */
  revenueToken: RevenueTokenSeed | null;
  /** Fee float per signing wallet (lenders, operators, maker, rewards). */
  feeFloat: bigint;
}

export interface RevenueTokenSeed {
  validator: ValidatorSeed['name'];
  symbol: string;
  name: string;
  /** Token metadata URI (not fetched: the launch runs with `--skip-uri-check`). */
  uri: string;
  shareBps: number;
  termEpochs: number;
  /** Whole tokens, fixed supply. */
  supply: number;
  decimals: number;
  /**
   * The raise that graduates the curve. Devnet's DBC build refuses a fixed-supply config with the whole supply on the
   * curve (`InvalidTokenSupply`, rehearsal 10), so the raise stays below the full-supply raise and leaves a leftover.
   */
  raiseTarget: bigint;
  /** The operator's first buy in the pool's creation transaction. */
  firstBuy: bigint;
}

const score = (
  creditsRatioBps: number,
  commissionBps: number,
  epochsActive: number,
  hedged = false,
): sdk.ScoreUpdate => ({
  creditsRatioBps,
  commissionBps,
  epochsActive,
  delinquent: false,
  superminority: false,
  hedged,
});

export const DEVNET_PLAN: SeedPlan = {
  deposits: [
    { lender: 'lender1', tranche: 'junior', lamports: sol(1) },
    { lender: 'lender2', tranche: 'junior', lamports: sol(0.5) },
    { lender: 'lender2', tranche: 'senior', lamports: sol(1.5) },
    { lender: 'lender3', tranche: 'senior', lamports: sol(3) },
  ],
  withdrawal: { lender: 'lender3', tranche: 'senior', lamports: sol(0.2) },
  validators: [
    // Borrows 1 SOL after three sweeps: limit min(4.5 × 25%, 0.3 × 4) = 1.125 SOL.
    {
      name: 'v1',
      operator: 'operator1',
      commissionPercent: 10,
      bond: sol(0.3),
      revenuePerEpoch: sol(1.5),
      score: score(9800, 1000, 45),
      advance: SOL,
    },
    {
      name: 'v2',
      operator: 'operator2',
      commissionPercent: 8,
      bond: sol(0.25),
      revenuePerEpoch: sol(0.5),
      score: score(9300, 800, 12, true),
      advance: 0n,
    },
    {
      name: 'v3',
      operator: 'operator2',
      commissionPercent: 7,
      bond: sol(0.2),
      revenuePerEpoch: sol(0.3),
      score: score(9750, 700, 20),
      advance: 0n,
    },
  ],
  quotes: { epochsAhead: 5, fixedRate: 10_000n, maxNotional: sol(1), maxMoveBps: 2000 },
  swap: { taker: 'lender1', side: 'payFixed', notional: sol(0.5), epochsAhead: 1 },
  // On v3, which never borrows: a sweep pays the share before any remittance and the credit history is recorded net of
  // it, so a token on v1 would cut its limit to 1.0125 SOL. 10% of 0.3 SOL for 10 epochs prices the curve.
  revenueToken: {
    validator: 'v3',
    symbol: 'rDEV3',
    name: 'Epoch devnet validator v3',
    uri: 'https://example.invalid/epoch-devnet-rdev3.json',
    shareBps: 1000,
    termEpochs: 10,
    supply: 1_000_000,
    decimals: 6,
    // The whole supply would raise 0.183 SOL; 0.1 leaves 453,226 tokens over (burned by the treasury after graduation).
    raiseTarget: sol(0.1),
    firstBuy: sol(0.02),
  },
  feeFloat: sol(0.02),
};

/** Signing wallets the seed funds with a fee float. */
export function seedWallets(plan: SeedPlan): string[] {
  const lenders = new Set<string>([...plan.deposits.map((d) => d.lender), plan.swap.taker]);
  const operators = new Set<string>(plan.validators.map((v) => v.operator));
  return [...lenders, ...operators, 'maker', 'rewards'];
}

/** Quote accounts the maker holds at most: the rolling window plus the one the swap keeps open until it settles. */
export function quotesHeld(plan: SeedPlan): number {
  return plan.quotes.epochsAhead + 1;
}

/** Collateral and rent of one maker quote. */
export function quoteLamports(plan: SeedPlan, rent: RentFn): bigint {
  return sdk.swapCollateral(plan.quotes.maxNotional, plan.quotes.maxMoveBps) + rent(sdk.ACCOUNT_SIZES.FeeQuote);
}

/** The taker's collateral and the swap account's rent. */
export function swapLamports(plan: SeedPlan, rent: RentFn): bigint {
  return sdk.swapCollateral(plan.swap.notional, plan.quotes.maxMoveBps) + rent(sdk.ACCOUNT_SIZES.SwapPosition);
}

/** Margin the launch CLI's payer check asks above its estimate (`checkPayerBalance`); it stays in the wallet. */
export const LAUNCH_PAYER_MARGIN = 10_000_000n;

/**
 * What the revenue token's operator must hold: the launch as the launch CLI estimates it (createConfig, then createPool
 * with the first buy: 2 transactions, 4 signatures; rent at the mainnet rate, the figure its payer check uses), the
 * registration's rent (`RevenueToken`, the buyback escrow's minimum and its token account) and fee, and the CLI's
 * payer margin. On devnet, where rent is lower, the difference stays in the operator's wallet.
 */
export function revenueTokenLamports(token: RevenueTokenSeed): bigint {
  const launch = estimateLaunchCost({
    newConfig: true,
    signatures: 4,
    transactions: 2,
    initialBuyLamports: Number(token.firstBuy),
  });
  const registration =
    rentExemptLamports(sdk.ACCOUNT_SIZES.RevenueToken) + rentExemptLamports(0) + rentExemptLamports(165);
  return BigInt(launch.totalLamports) + BigInt(registration) + SIGNATURE_FEE + LAUNCH_PAYER_MARGIN;
}

/**
 * The share a revenue token takes from its validator's simulated revenue over the sweeps the seed funds after the
 * term starts (registered in E0, the term starts in E0 + 1: MIN_REVENUE_HISTORY sweeps until the advance). It goes to
 * the buyback escrow (bought back and burned), so the rewards wallet is topped up by that much.
 */
export function revenueShareLamports(plan: SeedPlan): bigint {
  const token = plan.revenueToken;
  if (!token) return 0n;
  const v = plan.validators.find((x) => x.name === token.validator);
  if (!v) throw new RangeError(`revenue token validator ${token.validator} is not in the plan`);
  return ((v.revenuePerEpoch * BigInt(token.shareBps)) / 10_000n) * BigInt(sdk.PROGRAM_CONSTANTS.MIN_REVENUE_HISTORY);
}

/** Sizes the plan needs from the cluster (vote account size comes from the vote program on that cluster). */
export interface SeedSizes {
  voteAccount: number;
  voteReserve: bigint;
}

/** Everything the seed sends, by item; deposits, bonds, collateral and the revenue float are recoverable. */
export function seedLines(plan: SeedPlan, rent: RentFn, sizes: SeedSizes, microLamportsPerCu = 0n): BudgetLine[] {
  const fee = (sigs = 1) => txFee(sigs, microLamportsPerCu);
  const n = plan.validators.length;
  const lines: BudgetLine[] = [
    {
      stage: 'seed',
      item: `deposits (${plan.deposits.map((d) => `${d.lender} ${d.tranche}`).join(', ')})`,
      lamports: plan.deposits.reduce((a, d) => a + d.lamports, 0n),
      recoverable: true,
    },
    {
      stage: 'seed',
      item: `${plan.deposits.length} lender accounts + 1 withdrawal request (rent)`,
      lamports:
        rent(sdk.ACCOUNT_SIZES.LenderShares) * BigInt(plan.deposits.length) + rent(sdk.ACCOUNT_SIZES.WithdrawRequest),
    },
    {
      stage: 'seed',
      item: `${n} vote accounts (rent, ${sizes.voteAccount} bytes) + sweep reserve`,
      lamports: (rent(sizes.voteAccount) + sizes.voteReserve) * BigInt(n),
      note: 'the reserve stays in the vote accounts; recoverable after release_validator',
    },
    {
      stage: 'seed',
      item: `${n} positions + escrows (rent)`,
      lamports: (rent(sdk.ACCOUNT_SIZES.ValidatorPosition) + rent(0)) * BigInt(n),
    },
    { stage: 'seed', item: 'bonds', lamports: plan.validators.reduce((a, v) => a + v.bond, 0n), recoverable: true },
    {
      stage: 'seed',
      item: 'revenue float (one epoch of simulated commission; sweeps pay it back to the rewards wallet)',
      lamports: plan.validators.reduce((a, v) => a + v.revenuePerEpoch, 0n),
      recoverable: true,
    },
    {
      stage: 'seed',
      item: `maker quotes: collateral of ${quotesHeld(plan)} (the next ${plan.quotes.epochsAhead} epochs + the swap's)`,
      lamports: sdk.swapCollateral(plan.quotes.maxNotional, plan.quotes.maxMoveBps) * BigInt(quotesHeld(plan)),
      recoverable: true,
      note: 'withdraw_quote returns it once the epoch begins (the swap quote once the swap settles)',
    },
    {
      stage: 'seed',
      item: `${quotesHeld(plan)} quote accounts (rent)`,
      lamports: rent(sdk.ACCOUNT_SIZES.FeeQuote) * BigInt(quotesHeld(plan)),
    },
    {
      stage: 'seed',
      item: 'swap: taker collateral',
      lamports: sdk.swapCollateral(plan.swap.notional, plan.quotes.maxMoveBps),
      recoverable: true,
    },
    { stage: 'seed', item: 'swap account (rent)', lamports: rent(sdk.ACCOUNT_SIZES.SwapPosition) },
    {
      stage: 'seed',
      item: 'advance accounts (rent)',
      lamports: rent(sdk.ACCOUNT_SIZES.Advance) * BigInt(plan.validators.filter((v) => v.advance > 0n).length),
    },
    {
      stage: 'seed',
      item: `fee floats (${seedWallets(plan).length} signing wallets)`,
      lamports: plan.feeFloat * BigInt(seedWallets(plan).length),
      note: 'what is not spent on fees stays in the wallets',
    },
    {
      stage: 'seed',
      item: 'transactions over the first epochs (onboarding, scores, sweeps, accrual, quotes, swap, advance)',
      lamports: fee(2) * BigInt(n) + fee() * 60n,
    },
  ];
  if (plan.revenueToken) {
    lines.push(
      {
        stage: 'seed',
        item: `revenue token ${plan.revenueToken.symbol}: DBC launch with a ${sdkSol(plan.revenueToken.firstBuy)} SOL first buy, register_revenue_token, the launch CLI's payer margin`,
        lamports: revenueTokenLamports(plan.revenueToken),
        note: "priced as the launch CLI's payer check (mainnet rent); the margin and any rent difference stay in the operator's wallet",
      },
      {
        stage: 'seed',
        item: `revenue token share: ${plan.revenueToken.shareBps} bps of ${plan.revenueToken.validator}'s revenue for ${sdk.PROGRAM_CONSTANTS.MIN_REVENUE_HISTORY} sweeps (to the buyback escrow)`,
        lamports: revenueShareLamports(plan),
      },
    );
  }
  return lines;
}
