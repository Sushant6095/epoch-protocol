/**
 * Revenue-token math from the Launch spec (handover `pages/launch.md`, `contracts/epoch-data.ts`):
 *
 * - value per token = 10-epoch average revenue × share × term ÷ supply; the curve runs from 60% to 95% of it;
 * - market cap is fully diluted: price × (supply − burned);
 * - implied yield = share revenue per epoch ÷ market cap, per epoch and never annualised (the cashflow stops at the
 *   end of the term);
 * - backing = share revenue per epoch × epochs left ÷ market cap.
 *
 * Plain numbers in SOL; nothing here touches the chain.
 */
import {
  BAND_HIGH_PCT,
  BAND_LOW_PCT,
  BPS_DENOMINATOR,
  CREATOR_MIGRATION_FEE_SHARE_PCT,
  LAMPORTS_PER_SOL,
  MIGRATION_FEE_PCT,
} from './constants';

/** What a validator sells: a share of its commission for a number of epochs, priced off its average revenue. */
export interface ShareTerms {
  /** 10-epoch average revenue per epoch, SOL. */
  avgRevenueSol: number;
  /** Share of the commission sold, bps. */
  shareBps: number;
  termEpochs: number;
}

/** 10-epoch average revenue × share: what the buyback gets each epoch, SOL. */
export const shareRevenuePerEpochSol = (avgRevenueSol: number, shareBps: number): number =>
  (avgRevenueSol * shareBps) / BPS_DENOMINATOR;

/** Share revenue per epoch × term: the share's value at registration, SOL. */
export const shareValueSol = ({ avgRevenueSol, shareBps, termEpochs }: ShareTerms): number =>
  shareRevenuePerEpochSol(avgRevenueSol, shareBps) * termEpochs;

export interface CurveBand {
  valuePerTokenSol: number;
  /** 60% of the value per token: where the curve starts. */
  bandLowSol: number;
  /** 95% of the value per token: where the curve ends and the token graduates. */
  bandHighSol: number;
}

export const curveBand = (valuePerTokenSol: number): CurveBand => ({
  valuePerTokenSol,
  bandLowSol: (valuePerTokenSol * BAND_LOW_PCT) / 100,
  bandHighSol: (valuePerTokenSol * BAND_HIGH_PCT) / 100,
});

export interface LaunchBand extends CurveBand {
  shareRevenuePerEpochSol: number;
  shareValueSol: number;
}

/** The share's value and the curve's band for a launch of `supply` tokens. */
export function launchBand(input: ShareTerms & { supply: number }): LaunchBand {
  if (!(input.supply > 0)) throw new RangeError(`supply must be positive, got ${input.supply}`);
  const value = shareValueSol(input);
  return {
    shareRevenuePerEpochSol: shareRevenuePerEpochSol(input.avgRevenueSol, input.shareBps),
    shareValueSol: value,
    ...curveBand(value / input.supply),
  };
}

/** The last epoch whose revenue share is bought back. */
export const endEpochOf = (startEpoch: number, termEpochs: number): number => startEpoch + termEpochs - 1;

/** Epochs of buybacks still ahead, the current one included: end − current + 1, clamped to 0…term. */
export function epochsLeft(input: { startEpoch: number; termEpochs: number; currentEpoch: number }): number {
  const left = endEpochOf(input.startEpoch, input.termEpochs) - input.currentEpoch + 1;
  return Math.max(0, Math.min(input.termEpochs, left));
}

/** Fully diluted market cap: price × (supply − burned). null while there is no price (upcoming). */
export function marketCapSol(priceSol: number | null, supply: number, burned: number): number | null {
  if (priceSol === null) return null;
  return priceSol * Math.max(0, supply - burned);
}

/** Share revenue per epoch ÷ market cap, % PER EPOCH. Never annualise it: the cashflow stops at the end of the term. */
export function impliedYieldPctPerEpoch(shareRevenuePerEpoch: number, marketCap: number | null): number | null {
  if (marketCap === null || !(marketCap > 0)) return null;
  return (shareRevenuePerEpoch / marketCap) * 100;
}

/** Expected buybacks left in the term (share revenue × epochs left) ÷ market cap. */
export function backingRatio(
  shareRevenuePerEpoch: number,
  epochsRemaining: number,
  marketCap: number | null,
): number | null {
  if (marketCap === null || !(marketCap > 0)) return null;
  return (shareRevenuePerEpoch * epochsRemaining) / marketCap;
}

/** SOL the validator (the pool creator) gets at graduation: raise × migration fee % × creator share %. */
export const upfrontToValidatorSol = (
  raiseSol: number,
  migrationFeePct = MIGRATION_FEE_PCT,
  creatorSharePct = CREATOR_MIGRATION_FEE_SHARE_PCT,
): number => (raiseSol * migrationFeePct * creatorSharePct) / 10_000;

/** SOL that seeds the DAMM v2 pool at graduation: the raise less the migration fee. */
export const dammSeedSol = (raiseSol: number, migrationFeePct = MIGRATION_FEE_PCT): number =>
  (raiseSol * (100 - migrationFeePct)) / 100;

/**
 * The average of per-epoch revenue in lamports (e.g. `getInflationReward` amounts for a vote account), in SOL. A
 * missing epoch (`null`: nothing earned) counts as 0.
 */
export function averageRevenueSol(lamportsPerEpoch: readonly (number | bigint | null)[]): number {
  if (lamportsPerEpoch.length === 0) return 0;
  const total = lamportsPerEpoch.reduce<number>((sum, value) => sum + Number(value ?? 0), 0);
  return total / lamportsPerEpoch.length / LAMPORTS_PER_SOL;
}
