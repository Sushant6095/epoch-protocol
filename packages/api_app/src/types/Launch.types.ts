// Revenue-token launches, `/launch` and `/launch/[mint]` (request #22). They mirror the frontend contract's Launch types
// (handover contracts/epoch-data.ts). Validator revenue tokens: a fixed share of a validator's commission for a fixed
// term on a Meteora Dynamic Bonding Curve (Epoch is the partner), graduating to a DAMM v2 pool, bought back every epoch
// and burned (ADR 0006, plan F13). Devnet for now (decision 6). Not an offer of anything (decision 22).
import { type Meta } from './Api.types';

export type LaunchStatus = 'upcoming' | 'curve' | 'graduated' | 'ended';
export type LaunchNetwork = 'devnet' | 'mainnet';

export interface LaunchSummary {
  /** The token mint; the page route is /launch/[mint]. */
  mint: string | null;
  symbol: string;
  name: string;
  validator: { name: string; vote: string | null };
  /** Share of the validator's commission sold, bps. Immutable once registered. */
  shareBps: number;
  termEpochs: number;
  startEpoch: number;
  /** Last epoch whose revenue share is bought back. */
  endEpoch: number;
  status: LaunchStatus;
  /** upcoming: the epoch the curve opens. */
  opensAtEpoch: number | null;
  /** The raise on the curve: graduation happens at `targetSol` (DBC migrationQuoteThreshold). */
  raise: { targetSol: number; raisedSol: number; progressPct: number; buyers: number };
  /** null while upcoming. */
  priceSol: number | null;
  /** The curve's price band per token: 60% and 95% of the share's value. */
  bandLowSol: number;
  bandHighSol: number;
  /** Fully diluted: price × (supply − burned). null while upcoming. */
  marketCapSol: number | null;
  /** 10-epoch average of swept revenue × share: what the buyback gets each epoch, SOL. */
  shareRevenuePerEpochSol: number;
  /** shareRevenuePerEpochSol ÷ marketCapSol, % PER EPOCH. Never annualised. */
  impliedYieldPctPerEpoch: number | null;
  /** Expected buybacks left in the term (share revenue × epochs left) ÷ market cap. */
  backingRatio: number | null;
}

export interface LaunchList extends Meta {
  network: LaunchNetwork;
  launches: LaunchSummary[];
}

export interface LaunchBuyback {
  epoch: number;
  slice: number;
  slices: number;
  solIn: number;
  tokensBurned: number;
  priceSol: number;
  venue: 'dbc' | 'damm-v2';
  signature: string | null;
}

export interface LaunchPricePoint {
  /** ISO 8601, IST. */
  t: string;
  epoch: number;
  priceSol: number;
}

export interface LaunchDetail extends Meta {
  network: LaunchNetwork;
  launch: LaunchSummary;
  token: {
    supply: number;
    /** Supply − the mint's current supply; null when the mint could not be read (request #32: never a guess). */
    burned: number | null;
    /** Wallets holding the token; null when the holders could not be read (never "0 holders" as a fact). */
    holders: number | null;
    decimals: number;
    /** Fixed supply: no mint authority (plan F13). */
    mintAuthority: null;
    /** The curve pool's token update authority is immutable; null when the pool could not be read (or is not live). */
    metadataImmutable: boolean | null;
  };
  curve: {
    dbcPool: string | null;
    config: string | null;
    bandLowSol: number;
    bandHighSol: number;
    valuePerTokenSol: number;
    migrationThresholdSol: number;
    /** 70: at graduation the validator gets 70% of the raise as SOL; the rest seeds DAMM v2 with LP locked forever. */
    creatorMigrationFeePct: number;
    lockedLiquidityPct: number;
    dammPool: string | null;
    graduatedEpoch: number | null;
  };
  escrow: {
    address: string | null;
    balanceSol: number;
    /** 12 slices across the first hour of each epoch. */
    slicesPerEpoch: number;
    mode: 'buyback' | 'redeem';
  };
  /** DBC partner trading fees for Epoch's treasury (the Senior tranche). */
  partnerFeesToSeniorSol: number;
  /** 70% of the raise, paid at graduation; null before. */
  upfrontToValidatorSol: number | null;
  /** Oldest first, at most 500 points. */
  priceSeries: LaunchPricePoint[];
  /** Newest first. */
  buybacks: LaunchBuyback[];
  risks: string[];
}
