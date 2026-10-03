import { PublicKey } from '@solana/web3.js';

import { type ConnectionManager } from './ConnectionManager';
import { bytesToAddress } from './pubkeys';

/** The EpochRewards sysvar (SIMD-0118 partitioned rewards). */
export const EPOCH_REWARDS_SYSVAR_ID = new PublicKey('SysvarEpochRewards1111111111111111111111111');

/** `solana_epoch_rewards::EpochRewards`, bincode: u64, u64, [u8;32], u128, u64, u64, bool = 81 bytes. */
export interface EpochRewardsSysvar {
  distributionStartingBlockHeight: bigint;
  numPartitions: bigint;
  parentBlockhash: string;
  totalPoints: bigint;
  totalRewards: bigint;
  distributedRewards: bigint;
  /** True while this epoch's stake rewards are still being calculated or paid out. */
  active: boolean;
}

export const EPOCH_REWARDS_SIZE = 81;

export function decodeEpochRewards(data: Uint8Array): EpochRewardsSysvar {
  if (data.length < EPOCH_REWARDS_SIZE) {
    throw new RangeError(`EpochRewards sysvar is ${data.length} bytes, expected ${EPOCH_REWARDS_SIZE}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const active = data[80];
  if (active > 1) throw new RangeError(`EpochRewards.active is ${active}, expected 0 or 1`);
  return {
    distributionStartingBlockHeight: view.getBigUint64(0, true),
    numPartitions: view.getBigUint64(8, true),
    parentBlockhash: bytesToAddress(data.subarray(16, 48)),
    totalPoints: view.getBigUint64(48, true) | (view.getBigUint64(56, true) << 64n),
    totalRewards: view.getBigUint64(64, true),
    distributedRewards: view.getBigUint64(72, true),
    active: active === 1,
  };
}

/**
 * Whether stake rewards are still being distributed on the cluster. The Epoch program's `sweep` refuses to run while
 * they are (`RewardsInProgress`); like the program, a cluster without the sysvar counts as "not active".
 */
export async function isEpochRewardsActive(connections: ConnectionManager): Promise<boolean> {
  const info = await connections.withFailover((c) => c.getAccountInfo(EPOCH_REWARDS_SYSVAR_ID, 'confirmed'));
  if (!info) return false;
  return decodeEpochRewards(info.data).active;
}
