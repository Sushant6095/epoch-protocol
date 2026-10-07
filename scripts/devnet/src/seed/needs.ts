/**
 * What each seed wallet must hold for the steps still to run: the working capital those steps move (deposits, bonds)
 * and the rent of the accounts they create, plus the plan's fee float. `seed` tops wallets up to this from the
 * deployer, so a re-run after some steps sends only what the remaining steps need, never the same capital twice.
 * The items mirror `seedLines` in plan.ts, which prices the same steps for `budget`; the maker's quotes and the
 * revenue share are topped up epoch by epoch instead.
 */
import * as sdk from '@epoch/epoch-sdk';

import { type RentFn } from '../lib/budget';
import { revenueTokenLamports, type SeedPlan, type SeedSizes, seedWallets, swapLamports } from './plan';

/** Which steps already have their effect on chain. */
export interface SeedProgress {
  /** `depositKey(lender, tranche)` of every deposit already made. */
  deposited: Set<string>;
  withdrawalRequested: boolean;
  /** Validator names whose vote account exists. */
  voteAccounts: Set<string>;
  /** Validator names with a position (onboarded, collectors set, bond posted: one transaction). */
  onboarded: Set<string>;
  /**
   * Simulated revenue still to send per validator for the next sweep (`revenueShortfall`); a validator missing from
   * the map still needs its full `revenuePerEpoch`.
   */
  revenueMissing: Map<string, bigint>;
  /** Validator names whose planned advance is open or was taken. */
  advanced: Set<string>;
  /** The taker's swap is open (or settled). */
  swapOpen: boolean;
  /** The revenue token is registered, or this cluster has no DBC to launch it on. */
  revenueTokenDone: boolean;
}

export function depositKey(lender: string, tranche: sdk.Tranche): string {
  return `${lender}:${tranche}`;
}

export function emptyProgress(): SeedProgress {
  return {
    deposited: new Set(),
    withdrawalRequested: false,
    voteAccounts: new Set(),
    onboarded: new Set(),
    revenueMissing: new Map(),
    advanced: new Set(),
    swapOpen: false,
    revenueTokenDone: false,
  };
}

/** Lamports to send into a vote account so it holds one epoch of simulated revenue above its sweep floor. */
export function revenueShortfall(balance: bigint, floor: bigint, perEpoch: bigint): bigint {
  const above = balance > floor ? balance - floor : 0n;
  return above >= perEpoch ? 0n : perEpoch - above;
}

/** Lamports each seed wallet needs for the remaining steps, fee float included. */
export function walletNeeds(
  plan: SeedPlan,
  rent: RentFn,
  sizes: SeedSizes,
  progress: SeedProgress,
): Map<string, bigint> {
  const needs = new Map<string, bigint>(seedWallets(plan).map((w) => [w, plan.feeFloat]));
  const add = (wallet: string, lamports: bigint) => needs.set(wallet, (needs.get(wallet) ?? plan.feeFloat) + lamports);
  for (const d of plan.deposits) {
    if (!progress.deposited.has(depositKey(d.lender, d.tranche))) {
      add(d.lender, d.lamports + rent(sdk.ACCOUNT_SIZES.LenderShares));
    }
  }
  if (!progress.withdrawalRequested) add(plan.withdrawal.lender, rent(sdk.ACCOUNT_SIZES.WithdrawRequest));
  for (const v of plan.validators) {
    if (!progress.voteAccounts.has(v.name)) add(v.operator, rent(sizes.voteAccount) + sizes.voteReserve);
    // The operator pays the position's rent and the escrow's rent-exempt minimum, and posts the bond.
    if (!progress.onboarded.has(v.name)) add(v.operator, rent(sdk.ACCOUNT_SIZES.ValidatorPosition) + rent(0) + v.bond);
    // The `rewards` wallet simulates commission; sweeps pay it back (it is every test validator's payout).
    add('rewards', progress.revenueMissing.get(v.name) ?? v.revenuePerEpoch);
    if (v.advance > 0n && !progress.advanced.has(v.name)) add(v.operator, rent(sdk.ACCOUNT_SIZES.Advance));
  }
  // The maker's quotes are funded epoch by epoch (they roll, and withdrawn ones pay for the next).
  if (!progress.swapOpen) add(plan.swap.taker, swapLamports(plan, rent));
  const token = plan.revenueToken;
  if (token && !progress.revenueTokenDone) {
    add(plan.validators.find((v) => v.name === token.validator)!.operator, revenueTokenLamports(token));
  }
  return needs;
}
