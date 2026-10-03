import { SnapshotCache } from '../../Lib/SnapshotCache';
import { type InflationReward, type SolanaDataSource, type VoteAccount } from '../../Sources/SolanaDataSource';
import { InflationRewards } from '../InflationRewards';
import { type MarketData } from '../MarketData';
import { VoteRewardsWarmer } from './VoteRewardsWarmer';

const vote = (votePubkey: string, activatedStake = 1): VoteAccount =>
  ({ votePubkey, activatedStake, epochCredits: [] }) as unknown as VoteAccount;

describe('VoteRewardsWarmer', () => {
  it('reads every staked vote account for the last 10 epochs, newest first, 32 per call, once', async () => {
    const votes = Array.from({ length: 40 }, (_, i) => vote(`v${i}`));
    const market = {
      epochInfo: new SnapshotCache('epochInfo', 60_000, async () => ({ epoch: 1047 })),
      voteAccounts: new SnapshotCache('voteAccounts', 60_000, async () => ({
        current: votes,
        delinquent: [vote('unstaked', 0)],
      })),
    } as unknown as MarketData;
    const getInflationReward = jest.fn(async (addresses: string[], epoch?: number) =>
      addresses.map((): InflationReward => ({ epoch: epoch ?? 0, amount: 5, effectiveSlot: 0, postBalance: 0 })),
    );
    const rewards = new InflationRewards({ getInflationReward } as unknown as SolanaDataSource);
    const warmer = new VoteRewardsWarmer(market, rewards);

    await warmer.run();
    expect(getInflationReward).toHaveBeenCalledTimes(20);
    expect(getInflationReward.mock.calls[0]).toEqual([votes.slice(0, 32).map((v) => v.votePubkey), 1046]);
    expect(getInflationReward.mock.calls[1][0]).toHaveLength(8);
    expect(getInflationReward.mock.calls.at(-1)?.[1]).toBe(1037);
    expect(rewards.cached('v39', 1037)).toBe(5);
    expect(rewards.cached('unstaked', 1046)).toBeUndefined();

    await warmer.run();
    expect(getInflationReward).toHaveBeenCalledTimes(20);
  });
});
