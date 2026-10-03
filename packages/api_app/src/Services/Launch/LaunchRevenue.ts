import { type ValidatorRow } from '../../types/Api.types';
import { type ValidatorTableData } from '../ValidatorTable';

/** A validator's revenue per epoch as the launch API knows it, or null with the reason. */
export interface RevenueEstimate {
  avgRevenueSol: number | null;
  note: string | null;
}

/** Revenue for a launch's validator (its mainnet vote account, or null). */
export type LaunchRevenueSource = (vote: string | null) => Promise<RevenueEstimate>;

/**
 * Commission revenue per epoch on mainnet, in SOL: inflation commission plus MEV commission, with the validator table's
 * formulas (`ValidatorTable.build`; block fees and vote costs left out). It stands in for the 10-epoch average of swept
 * revenue until launches are registered on-chain.
 */
export function estimateRevenuePerEpochSol(
  row: Pick<ValidatorRow, 'stakeSol' | 'commissionPct' | 'tipsApyPct' | 'mevCommissionPct'>,
  table: Pick<ValidatorTableData, 'grossYieldPerEpoch' | 'epochsPerYear'>,
): number {
  const inflationCommission = row.stakeSol * table.grossYieldPerEpoch * (row.commissionPct / 100);
  const mevBps = row.mevCommissionPct === null ? null : row.mevCommissionPct * 100;
  const tipsToStakers =
    table.epochsPerYear > 0 ? (row.stakeSol * ((row.tipsApyPct ?? 0) / 100)) / table.epochsPerYear : 0;
  const mevCommission = mevBps !== null && mevBps < 10_000 ? (tipsToStakers * mevBps) / (10_000 - mevBps) : 0;
  return inflationCommission + mevCommission;
}

/** Revenue from the mainnet validator table (`getServices().validators`), one lookup per vote account. */
export function validatorTableRevenue(table: () => Promise<ValidatorTableData>): LaunchRevenueSource {
  const indexes = new WeakMap<ValidatorTableData, Map<string, ValidatorRow>>();
  return async (vote) => {
    if (!vote) return { avgRevenueSol: null, note: 'no mainnet vote account in the registry' };
    let data: ValidatorTableData;
    try {
      data = await table();
    } catch {
      return { avgRevenueSol: null, note: 'the mainnet validator table is unavailable' };
    }
    let index = indexes.get(data);
    if (!index) {
      index = new Map(data.rows.map((row) => [row.vote, row]));
      indexes.set(data, index);
    }
    const row = index.get(vote);
    if (!row) return { avgRevenueSol: null, note: 'its vote account is not a mainnet validator with stake' };
    return { avgRevenueSol: estimateRevenuePerEpochSol(row, data), note: null };
  };
}
