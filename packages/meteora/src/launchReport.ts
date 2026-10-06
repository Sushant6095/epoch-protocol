/**
 * The launch plan as text: every number the curve is built from and the arithmetic between them, so the operator and
 * the validator can check the pricing line by line before anything is signed (pure; the launch script prints it).
 */
import { BPS_DENOMINATOR, LAMPORTS_PER_SOL } from './constants';
import { type LaunchPlan } from './launch';
import { impliedYieldPctPerEpoch } from './math';
import { type EpochRevenue, type RevenueSummary } from './revenue';
import { toBigInt } from './units';

const n = (value: number, digits = 6): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const price = (value: number): string => (value === 0 ? '0' : value.toPrecision(6));
const cell = (value: number | null, digits = 6): string => (value === null ? '—' : n(value, digits));

/** The revenue window as a table plus its averages. */
export function revenueTableLines(rows: readonly EpochRevenue[], summary: RevenueSummary, source: string): string[] {
  const lines = [
    `Revenue source     ${source}`,
    '  epoch   inflation commission   block revenue (estimate)                    MEV commission   total',
  ];
  for (const row of rows) {
    const blocks = row.blocks
      ? `${cell(row.blockRevenueSol)} (${row.blocks.leaderSlots} slots, ${row.blocks.sampled} read, ${row.blocks.skipped} skipped)`
      : cell(row.blockRevenueSol);
    const total =
      (summary.included.inflation ? (row.inflationCommissionSol ?? 0) : 0) +
      (summary.included.blocks ? (row.blockRevenueSol ?? 0) : 0) +
      (summary.included.mev ? (row.mevCommissionSol ?? 0) : 0);
    lines.push(
      `  ${String(row.epoch).padEnd(7)} ${cell(row.inflationCommissionSol).padEnd(22)} ${blocks.padEnd(43)} ${cell(row.mevCommissionSol).padEnd(16)} ${n(total)}`,
    );
  }
  const parts = [
    summary.included.inflation ? `inflation ${n(summary.inflationCommissionSol)}` : null,
    summary.included.blocks ? `blocks ${n(summary.blockRevenueSol)}` : null,
    summary.included.mev ? `MEV ${n(summary.mevCommissionSol)}` : null,
  ].filter(Boolean);
  lines.push(`  average ${parts.join(' + ')} = ${n(summary.avgRevenueSol)} SOL an epoch`);
  return lines;
}

/** The pricing, step by step. */
export function launchPlanLines(plan: LaunchPlan): string[] {
  const { config, band, curve } = plan;
  const share = config.shareBps / BPS_DENOMINATOR;
  const curveFeeBps = Number(curve.config.poolFees.baseFee.cliffFeeNumerator.toString()) / 1e5;
  const sqrtLow = toBigInt(curve.sqrtPrices[0]);
  const sqrtHigh = toBigInt(curve.sqrtPrices[curve.sqrtPrices.length - 1]);
  const marketCapAtStart = band.bandLowSol * config.supply;
  const dammSeedTokens = band.bandHighSol > 0 ? curve.dammSeedSol / band.bandHighSol : 0;
  const yieldAtStart = impliedYieldPctPerEpoch(band.shareRevenuePerEpochSol, marketCapAtStart);
  const yieldAtGraduation = impliedYieldPctPerEpoch(band.shareRevenuePerEpochSol, band.bandHighSol * config.supply);
  return [
    `Share revenue      ${n(share * 100, 2)}% × ${n(plan.avgRevenueSol)} SOL = ${n(band.shareRevenuePerEpochSol)} SOL an epoch (the buyback per epoch)`,
    `Term               ${config.termEpochs} epochs, ${plan.startEpoch}–${plan.endEpoch}`,
    `Share value        ${n(band.shareRevenuePerEpochSol)} × ${config.termEpochs} = ${n(band.shareValueSol, 4)} SOL`,
    `Value per token    ${n(band.shareValueSol, 4)} ÷ ${n(config.supply, 0)} tokens = ${price(band.valuePerTokenSol)} SOL`,
    `Curve band         60% → ${price(band.bandLowSol)} SOL (start, pMin); 95% → ${price(band.bandHighSol)} SOL (graduation, pMax)`,
    `Sqrt prices        ${sqrtLow} → ${sqrtHigh} (Q64.64, ${curve.sqrtPrices.length} points, buildCurveWithCustomSqrtPrices)`,
    `Raise              ${n(curve.migrationThresholdSol)} SOL = DBC migrationQuoteThreshold (the whole supply on the band would raise ${n(curve.fullSupplyRaiseSol, 3)} SOL)`,
    `Supply             ${n(curve.tokensOnCurve, 2)} on the curve · ≈ ${n(dammSeedTokens, 2)} seed DAMM v2 · ${n(curve.leftoverTokens, 0)} leftover (to the leftover receiver after graduation)`,
    `Graduation         70% × ${n(curve.migrationThresholdSol)} = ${n(curve.upfrontToValidatorSol)} SOL to the pool creator (the validator, upfront); the other 30% less Meteora's 0.2% protocol migration fee = ${n(curve.dammSeedSol)} SOL seeds DAMM v2, 100% of its LP permanently locked with the partner`,
    `Fees               curve ${n(curveFeeBps, 2)} bps, all to the partner (Epoch's treasury PDA: claimed into the lending pool for lenders); DAMM v2 ${[25, 30, 100, 200, 400, 600][curve.config.migrationFeeOption] ?? '?'} bps after graduation`,
    `Market cap         ${n(marketCapAtStart, 4)} SOL at the start price → ${n(band.bandHighSol * config.supply, 4)} SOL at graduation (fully diluted)`,
    `Implied yield      ${yieldAtStart === null ? '—' : `${n(yieldAtStart, 3)}%`} per epoch at the start price → ${yieldAtGraduation === null ? '—' : `${n(yieldAtGraduation, 3)}%`} at graduation (never annualised: the cashflow ends with the term)`,
  ];
}

/** Lamports as SOL for printing. */
export const formatSol = (lamports: number | bigint): string =>
  `${(Number(lamports) / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`;
