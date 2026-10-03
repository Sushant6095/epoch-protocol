import { type DelegatedStake, U64_MAX } from '../Lib/StakeLayouts';
import { DelegationAccumulator } from './DelegationAccumulator';

const key = (n: number) => Buffer.alloc(32, n).toString('base64');
const stake = (owner: number, sol: number, activation = 1000n, deactivation = U64_MAX): DelegatedStake => ({
  withdrawerKey: key(owner),
  stakeLamports: BigInt(Math.round(sol * 1e9)),
  activationEpoch: activation,
  deactivationEpoch: deactivation,
});

describe('DelegationAccumulator', () => {
  // Owner 1: a pool with 300k SOL over two validators (allocator). Owner 2: 5k SOL (mid-size).
  // Owners 3 and 4: retail. Owner 5: the Foundation. One account activates and one deactivates this epoch.
  const build = () => {
    const acc = new DelegationAccumulator(1046, new Set([key(5)]));
    acc.add('voteA', [stake(1, 200_000), stake(2, 5_000), stake(3, 10), stake(3, 5), stake(9, 7, 1046n)]);
    acc.add('voteB', [stake(1, 100_000), stake(4, 1), stake(5, 60_000), stake(6, 50, 1000n, 1046n)]);
    acc.add('voteC', []);
    return acc.finish();
  };

  it('counts distinct wallets, the biggest delegator and the Foundation share per validator', () => {
    const snap = build();
    const a = snap.perVote.get('voteA');
    expect(a?.delegators).toBe(4); // owners 1, 2, 3 (two accounts), 9
    expect(a?.biggestDelegatorSharePct).toBeCloseTo((200_000 / 205_022) * 100, 1);
    expect(a?.foundationSharePct).toBe(0);
    expect(a?.retailWallets).toBe(2); // owners 3 and 9
    const b = snap.perVote.get('voteB');
    expect(b?.delegators).toBe(3); // owner 6 is deactivating, so not counted
    expect(b?.foundationSharePct).toBeCloseTo((60_000 / 160_001) * 100, 1);
    expect(snap.perVote.get('voteC')?.delegators).toBe(0);
  });

  it('splits wallets into retail, mid-size and allocators by total stake', () => {
    const snap = build();
    expect(snap.network.wallets).toBe(6);
    expect(snap.network.retail.wallets).toBe(3); // 3, 4, 9
    expect(snap.network.midSize.wallets).toBe(2); // 2 (5k) and 5 (60k)
    expect(snap.network.allocators.holders).toBe(1); // 1 (300k)
    expect(snap.stakeAccounts).toBe(8);
  });

  it('sums activating and deactivating stake for this epoch', () => {
    const snap = build();
    expect(snap.network.activatingSol).toBe(7);
    expect(snap.network.deactivatingSol).toBe(50);
  });

  it('ranks the largest owners with how many validators they back', () => {
    const snap = build();
    expect(snap.topOwners[0]).toEqual({ key: key(1), stakeSol: 300_000, validators: 2 });
    expect(snap.topOwners[1].key).toBe(key(5));
  });

  it('leaves the Foundation share empty when no Foundation keys are configured', () => {
    const acc = new DelegationAccumulator(1046);
    acc.add('voteA', [stake(1, 10)]);
    expect(acc.finish().perVote.get('voteA')?.foundationSharePct).toBeNull();
  });
});
