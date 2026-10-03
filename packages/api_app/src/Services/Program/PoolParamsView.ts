import { PROGRAM_CONSTANTS, type PoolParams } from '@epoch/epoch-sdk';

import { type VaultParam } from '../../types/Program.types';
import { bpsText, solText } from './ProgramFormat';

/**
 * The parameters the devnet Pool is meant to start with (vault.sample.json, decision 5: senior 3 bps per epoch).
 * Used only while the Pool account doesn't exist, and every payload built from them says `kind: 'sample'`.
 */
export const PLANNED_POOL_PARAMS: Readonly<PoolParams> = Object.freeze({
  seniorRateBpsPerEpoch: 3,
  protocolFeeBps: 1_000,
  advanceBpsUnhedged: 2_500,
  advanceBpsHedged: 4_000,
  bondMultiplier: 4,
  feeBps: 200,
  remitBps: 5_000,
  minScore: 6_000,
  scoreTtlEpochs: 3,
  minAdvanceLamports: 1_000_000_000n,
  maxAdvanceLamports: 500_000_000_000n,
  maxPoolAssets: 5_000_000_000_000n,
  maxUtilizationBps: 6_000,
  minJuniorBps: 2_000,
  juniorLockEpochs: 10,
  maxAdvanceEpochs: 20,
  voteReserveLamports: 1_600_000_000n,
  minCommissionBps: 0,
});

const epochs = (n: number): string => `${n} epoch${n === 1 ? '' : 's'}`;

/** Every PoolParams field as the Vault's Parameters table shows it: a name, a display string, the field and its raw value. */
export function paramRows(p: PoolParams): VaultParam[] {
  const late = PROGRAM_CONSTANTS.DEFAULT_AFTER_LATE_EPOCHS;
  return [
    {
      name: 'Senior target',
      display: `${bpsText(p.seniorRateBpsPerEpoch)}% / epoch`,
      field: 'senior_rate_bps_per_epoch',
      value: p.seniorRateBpsPerEpoch,
    },
    { name: 'Advance fee', display: `${bpsText(p.feeBps)}% flat`, field: 'fee_bps', value: p.feeBps },
    { name: 'Taken each epoch', display: `${bpsText(p.remitBps)}% of sweep`, field: 'remit_bps', value: p.remitBps },
    {
      name: 'Credit limit',
      display: `${bpsText(p.advanceBpsUnhedged)}% · ${bpsText(p.advanceBpsHedged)}% hedged`,
      field: 'advance_bps_unhedged / _hedged',
      value: null,
    },
    {
      name: 'Bond cap',
      display: p.bondMultiplier === 0 ? 'off' : `${p.bondMultiplier}× bond`,
      field: 'bond_multiplier',
      value: p.bondMultiplier,
    },
    {
      name: 'Protocol fee',
      display: `${bpsText(p.protocolFeeBps)}% of income`,
      field: 'protocol_fee_bps',
      value: p.protocolFeeBps,
    },
    {
      name: 'Most lent out',
      display: `${bpsText(p.maxUtilizationBps)}%`,
      field: 'max_utilization_bps',
      value: p.maxUtilizationBps,
    },
    {
      name: 'Junior minimum',
      display: p.minJuniorBps === 0 ? 'off' : `${bpsText(p.minJuniorBps)}% of vault`,
      field: 'min_junior_bps',
      value: p.minJuniorBps,
    },
    {
      name: 'Junior lock',
      display: epochs(p.juniorLockEpochs),
      field: 'junior_lock_epochs',
      value: p.juniorLockEpochs,
    },
    {
      name: 'Default after',
      display: `${late} late epochs or ${p.maxAdvanceEpochs} open`,
      field: 'max_advance_epochs',
      value: p.maxAdvanceEpochs,
    },
    { name: 'Minimum score', display: `${bpsText(p.minScore)} / 100`, field: 'min_score', value: p.minScore },
    {
      name: 'Score valid for',
      display: epochs(p.scoreTtlEpochs),
      field: 'score_ttl_epochs',
      value: p.scoreTtlEpochs,
    },
    {
      name: 'Smallest advance',
      display: `${solText(p.minAdvanceLamports)} SOL`,
      field: 'min_advance_lamports',
      value: Number(p.minAdvanceLamports),
    },
    {
      name: 'Largest advance',
      display: `${solText(p.maxAdvanceLamports)} SOL`,
      field: 'max_advance_lamports',
      value: Number(p.maxAdvanceLamports),
    },
    {
      name: 'Vault cap (pre-alpha)',
      display: p.maxPoolAssets === 0n ? 'uncapped' : `${solText(p.maxPoolAssets)} SOL`,
      field: 'max_pool_assets',
      value: Number(p.maxPoolAssets),
    },
    {
      name: 'Vote reserve',
      display: `${solText(p.voteReserveLamports)} SOL`,
      field: 'vote_reserve_lamports',
      value: Number(p.voteReserveLamports),
    },
    {
      name: 'Minimum commission',
      display: `${bpsText(p.minCommissionBps)}%`,
      field: 'min_commission_bps',
      value: p.minCommissionBps,
    },
  ];
}
