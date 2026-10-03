/**
 * Binary layouts we read straight from accounts: the StakeHistory sysvar and the delegated part of a
 * stake account (StakeStateV2::Stake, 200 bytes).
 */

export const STAKE_PROGRAM_ID = 'Stake11111111111111111111111111111111111111';
export const STAKE_HISTORY_SYSVAR = 'SysvarStakeHistory1111111111111111111111111';
export const STAKE_ACCOUNT_SIZE = 200;
export const U64_MAX = 18_446_744_073_709_551_615n;

export interface StakeHistoryEntry {
  epoch: number;
  effectiveLamports: bigint;
  activatingLamports: bigint;
  deactivatingLamports: bigint;
}

/** `Vec<(Epoch, StakeHistoryEntry)>`, newest first: u64 length, then 32-byte entries. */
export function parseStakeHistory(data: Buffer): StakeHistoryEntry[] {
  if (data.length < 8) return [];
  const count = Number(data.readBigUInt64LE(0));
  const entries: StakeHistoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 32;
    if (at + 32 > data.length) break;
    entries.push({
      epoch: Number(data.readBigUInt64LE(at)),
      effectiveLamports: data.readBigUInt64LE(at + 8),
      activatingLamports: data.readBigUInt64LE(at + 16),
      deactivatingLamports: data.readBigUInt64LE(at + 24),
    });
  }
  return entries;
}

/**
 * StakeStateV2::Stake offsets: tag 0..4 · rent_exempt_reserve 4..12 · staker 12..44 · withdrawer 44..76 ·
 * lockup 76..124 · voter 124..156 · stake 156..164 · activation_epoch 164..172 · deactivation_epoch 172..180.
 * We fetch one slice, 44..180, so a scan moves 136 bytes per account instead of 200.
 */
export const STAKE_SLICE = { offset: 44, length: 136 } as const;
export const VOTER_OFFSET = 124;

export interface DelegatedStake {
  /** Withdraw authority (the owner), base64 of its 32 bytes: cheap to compare and intern. */
  withdrawerKey: string;
  stakeLamports: bigint;
  activationEpoch: bigint;
  deactivationEpoch: bigint;
}

export function parseStakeSlice(slice: Buffer): DelegatedStake | undefined {
  if (slice.length < STAKE_SLICE.length) return undefined;
  return {
    withdrawerKey: slice.subarray(0, 32).toString('base64'),
    stakeLamports: slice.readBigUInt64LE(112),
    activationEpoch: slice.readBigUInt64LE(120),
    deactivationEpoch: slice.readBigUInt64LE(128),
  };
}

/** Delegated and not on its way out: counts toward a validator's delegators. */
export const isDelegated = (stake: DelegatedStake): boolean => stake.deactivationEpoch === U64_MAX;
