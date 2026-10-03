import { type Connection, PublicKey } from '@solana/web3.js';

import { type ConnectionManager } from './ConnectionManager';
import { decodeEpochRewards, EPOCH_REWARDS_SIZE, EPOCH_REWARDS_SYSVAR_ID, isEpochRewardsActive } from './EpochRewards';

/** The 81-byte bincode layout of `solana_epoch_rewards::EpochRewards`. */
function sysvar(active: number): Uint8Array {
  const data = new Uint8Array(EPOCH_REWARDS_SIZE);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 300_000_000n, true); // distribution_starting_block_height
  view.setBigUint64(8, 2n, true); // num_partitions
  data.fill(7, 16, 48); // parent_blockhash
  view.setBigUint64(48, 5n, true); // total_points (u128, low half)
  view.setBigUint64(56, 1n, true); // total_points (u128, high half)
  view.setBigUint64(64, 1_000_000n, true); // total_rewards
  view.setBigUint64(72, 400_000n, true); // distributed_rewards
  data[80] = active;
  return data;
}

const connectionsReturning = (data: Uint8Array | null) => {
  const getAccountInfo = jest.fn(async () => (data ? { data: Buffer.from(data) } : null));
  const connections = {
    withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn({ getAccountInfo } as unknown as Connection),
  } as unknown as ConnectionManager;
  return { connections, getAccountInfo };
};

describe('EpochRewards sysvar', () => {
  it('decodes every field', () => {
    expect(decodeEpochRewards(sysvar(1))).toEqual({
      distributionStartingBlockHeight: 300_000_000n,
      numPartitions: 2n,
      parentBlockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
      totalPoints: (1n << 64n) + 5n,
      totalRewards: 1_000_000n,
      distributedRewards: 400_000n,
      active: true,
    });
    expect(decodeEpochRewards(sysvar(0)).active).toBe(false);
  });

  it('rejects short data and a bool that is not 0 or 1', () => {
    expect(() => decodeEpochRewards(new Uint8Array(80))).toThrow('expected 81');
    expect(() => decodeEpochRewards(sysvar(2))).toThrow('expected 0 or 1');
  });

  it('reads the sysvar account; a cluster without it counts as not active', async () => {
    const active = connectionsReturning(sysvar(1));
    await expect(isEpochRewardsActive(active.connections)).resolves.toBe(true);
    expect(active.getAccountInfo).toHaveBeenCalledWith(EPOCH_REWARDS_SYSVAR_ID, 'confirmed');
    await expect(isEpochRewardsActive(connectionsReturning(sysvar(0)).connections)).resolves.toBe(false);
    await expect(isEpochRewardsActive(connectionsReturning(null).connections)).resolves.toBe(false);
  });

  it('uses the runtime sysvar address', () => {
    expect(EPOCH_REWARDS_SYSVAR_ID.toBase58()).toBe('SysvarEpochRewards1111111111111111111111111');
  });
});
