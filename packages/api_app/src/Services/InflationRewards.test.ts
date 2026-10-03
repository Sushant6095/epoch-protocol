import { type InflationReward, type SolanaDataSource } from '../Sources/SolanaDataSource';
import { InflationRewards } from './InflationRewards';

const reward = (amount: number, epoch: number): InflationReward => ({
  epoch,
  amount,
  effectiveSlot: 0,
  postBalance: 0,
  commission: null,
});

function fakeSolana(answer: (address: string, epoch: number) => InflationReward | null) {
  const getInflationReward = jest.fn(async (addresses: string[], epoch?: number) =>
    addresses.map((address) => answer(address, epoch ?? 0)),
  );
  return { getInflationReward, solana: { getInflationReward } as unknown as SolanaDataSource };
}

describe('InflationRewards', () => {
  it('reads each (address, epoch) once and keeps finished rewards', async () => {
    const { getInflationReward, solana } = fakeSolana((address, epoch) => reward(address.length * 10, epoch));
    const rewards = new InflationRewards(solana);
    expect([...(await rewards.get(['ab', 'abc', 'ab'], 1046, 1047))]).toEqual([
      ['ab', 20],
      ['abc', 30],
    ]);
    expect(getInflationReward).toHaveBeenCalledWith(['ab', 'abc'], 1046);
    await rewards.get(['abc', 'abcd'], 1046, 1047);
    expect(getInflationReward).toHaveBeenLastCalledWith(['abcd'], 1046);
    expect(rewards.cached('abc', 1046)).toBe(30);
    expect(rewards.cached('abc', 1045)).toBeUndefined();
  });

  it("keeps 'no reward' only for epochs that are surely paid out", async () => {
    const { getInflationReward, solana } = fakeSolana(() => null);
    const rewards = new InflationRewards(solana);
    await rewards.get(['a'], 1046, 1047);
    await rewards.get(['a'], 1046, 1047);
    expect(getInflationReward).toHaveBeenCalledTimes(2);
    await rewards.get(['a'], 1045, 1047);
    await rewards.get(['a'], 1045, 1047);
    expect(getInflationReward).toHaveBeenCalledTimes(3);
    expect(rewards.cached('a', 1045)).toBeNull();
  });

  it('leaves out epochs whose read failed', async () => {
    const { solana } = fakeSolana((_address, epoch) => {
      if (epoch === 1044) throw new Error('RPC getInflationReward failed');
      return reward(1, epoch);
    });
    const byEpoch = await new InflationRewards(solana).getEpochs(['a'], [1043, 1044, 1045], 1047, 3);
    expect([...byEpoch.keys()].sort()).toEqual([1043, 1045]);
  });

  it('forgets the oldest entries beyond its capacity', async () => {
    const { solana } = fakeSolana((_address, epoch) => reward(1, epoch));
    const rewards = new InflationRewards(solana, 2);
    await rewards.get(['a', 'b', 'c'], 1040, 1047);
    expect([rewards.cached('a', 1040), rewards.cached('c', 1040)]).toEqual([undefined, 1]);
  });
});
