// `GET /v1/launches/:mint/buybacks`: a revenue token's buyback escrow, schedule and history (request #22, ADR 0006),
// and what Epoch's partner treasury claimed for the mint (ADR 0006 amendment, 4 Oct 2026), read from the Epoch
// program on its own cluster. Items reuse the frontend contract's `LaunchBuyback`.
import { type Meta } from './Api.types';
import { type LaunchBuyback } from './Launch.types';

export interface BuybackSchedule {
  /** The program cluster's current epoch (request #27): with `term.endEpoch`, how many epochs of the term are left. */
  currentEpoch: number;
  slicesPerEpoch: number;
  /** Slices run inside the first `windowSlots` slots of each epoch. */
  windowSlots: number;
  /** Slices that ran in the current epoch. */
  slicesDoneThisEpoch: number;
  paused: boolean;
  /**
   * The next slice that can buy: its epoch, its index, and the slots (and seconds, at 0.4 s a slot) until it is due.
   * Before the term with an empty escrow it is slice 0 of `startEpoch`; when this epoch's share is spent, slice 0 of
   * the next epoch. Null once nothing is left to buy (the term ended and the escrow is spent).
   */
  nextSlice: {
    epoch: number;
    slice: number;
    inSlots: number;
    etaSeconds: number;
    /** In the term, a slice runs only after that epoch's sweep paid the share in: the ETA is the earliest it can run. */
    waitsForSweep: boolean;
  } | null;
}

export interface LaunchBuybackFeed extends Meta {
  /** The program's cluster (devnet for now). */
  network: string;
  /** The Epoch program id on `network` (request #26: the Trade card builds redeem itself); null when unset. */
  programId: string | null;
  mint: string;
  /** The `RevenueToken` account; null when no validator registered this mint (the rest is then empty). */
  revenueToken: string | null;
  vote: string | null;
  /** Where buybacks trade now. */
  venue: 'dbc' | 'damm-v2' | null;
  term: { shareBps: number; termEpochs: number; startEpoch: number; endEpoch: number } | null;
  escrow: {
    address: string | null;
    /** Above rent: what buybacks or redemptions can still spend. */
    balanceSol: number;
    /** "redeem" once holders can burn tokens for SOL (after the term, or during it when the admin allows). */
    mode: 'buyback' | 'redeem';
  };
  schedule: BuybackSchedule | null;
  totals: {
    escrowedSol: number;
    spentSol: number;
    /** UI units of the token. */
    burned: number;
    redeemed: number;
    redeemedSol: number;
    buybacks: number;
  };
  /** Newest first. */
  buybacks: LaunchBuyback[];
  treasury: LaunchTreasuryClaims;
  /**
   * Set once the token ran its term and `close_revenue_token` closed it (the `RevenueToken` account is gone; the
   * validator may since have registered another mint): the history and totals then come from the program's events.
   */
  closed: LaunchRevenueTokenClosed | null;
}

/** `RevenueTokenClosed`: the escrow's last SOL went to the Epoch pool (or, once spent, the rent to the operator). */
export interface LaunchRevenueTokenClosed {
  epoch: number | null;
  /** ISO 8601 (IST) when known. */
  at: string | null;
  signature: string;
  /** What holders had not redeemed after the grace period, added to the lending pool as income. */
  unclaimedToPoolSol: number;
}

/** `TreasuryClaimed.kind`: what the partner treasury claimed from Meteora. */
export type TreasuryClaimKind = 'tradingFee' | 'surplus' | 'migrationFee' | 'leftover' | 'lpFee';

/** One claim of Epoch's partner treasury for the mint (a `TreasuryClaimed` event). */
export interface TreasuryClaimRow {
  kind: TreasuryClaimKind;
  /** The program cluster's epoch of the claim's slot; null when the indexer could not tell. */
  epoch: number | null;
  /** The DBC pool, or the DAMM v2 pool for LP fees. */
  source: string;
  /** The DAMM v2 position for LP fees; null otherwise. */
  position: string | null;
  /** SOL added to the lending pool as income (the next accrue pays the senior coupon first, then junior). */
  toLendersSol: number;
  /** UI units of the token burned. */
  tokensBurned: number;
  signature: string;
}

export interface TreasuryClaimTotals {
  toLendersSol: number;
  tokensBurned: number;
  claims: number;
}

/**
 * Epoch's partner treasury (`["treasury", pool]`, every launch's DBC fee claimer and leftover receiver) for this mint:
 * permissionless claims through the Epoch program put the SOL in the lending pool as income and burn the tokens.
 * Recorded for any launch naming the treasury, registered as a revenue token or not.
 */
export interface LaunchTreasuryClaims {
  /** The partner treasury PDA; null while the API has no program id. */
  address: string | null;
  totals: TreasuryClaimTotals;
  byKind: Record<TreasuryClaimKind, TreasuryClaimTotals>;
  /** Newest first. */
  claims: TreasuryClaimRow[];
  /** Still unclaimed on Meteora, by claim: the Launch page's fee breakdown (`GET /v1/launches/:mint/fees`). */
  claimable: string;
}
