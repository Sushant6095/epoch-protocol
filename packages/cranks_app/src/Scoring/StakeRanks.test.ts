import { stakeRanks, unrankedStake } from './StakeRanks';

describe('stakeRanks', () => {
  const stakes = [
    { vote: 'C', activatedStake: 10n },
    { vote: 'A', activatedStake: 40n },
    { vote: 'B', activatedStake: 40n },
    { vote: 'D', activatedStake: 10n },
    { vote: 'E', activatedStake: 0n },
  ];

  it('ranks by stake, ties by address, 1 = largest', () => {
    const ranks = stakeRanks(stakes);
    expect([...ranks].map(([vote, r]) => [vote, r.rank])).toEqual([
      ['A', 1],
      ['B', 2],
      ['C', 3],
      ['D', 4],
      ['E', 5],
    ]);
  });

  it('marks the smallest set of the largest stakes holding more than a third', () => {
    // total 100: A (40) alone already holds more than a third.
    const ranks = stakeRanks(stakes);
    expect([...ranks].filter(([, r]) => r.superminority).map(([vote]) => vote)).toEqual(['A']);
    // Exactly a third is not enough: the next one joins.
    const exact = stakeRanks([
      { vote: 'X', activatedStake: 1n },
      { vote: 'Y', activatedStake: 1n },
      { vote: 'Z', activatedStake: 1n },
    ]);
    expect([...exact].filter(([, r]) => r.superminority).map(([vote]) => vote)).toEqual(['X', 'Y']);
  });

  it('puts an unlisted vote account after everyone, outside the superminority', () => {
    expect(unrankedStake(stakes)).toEqual({ activatedStake: 0n, rank: 6, superminority: false });
  });
});
