import { mapTopHolders } from './holders';

describe('mapTopHolders', () => {
  it('shares of the supply, labels by token account or owner, empty accounts dropped', () => {
    const holders = mapTopHolders({
      accounts: [
        { address: 'vault', amount: 600_000_000_000n },
        { address: 'acc-1', amount: 250_000_000_000n },
        { address: 'acc-2', amount: 0n },
        { address: 'acc-3', amount: 150_000_000_000n },
      ],
      owners: ['pool-authority', 'wallet-1', 'wallet-2', 'treasury'],
      decimals: 6,
      supply: 1_000_000_000_000n,
      labels: { 'pool-authority': 'Meteora curve vault', treasury: "Epoch's treasury", 'acc-1': 'Buyback escrow' },
    });
    expect(holders).toEqual([
      {
        owner: 'pool-authority',
        tokenAccount: 'vault',
        amount: '600000000000',
        uiAmount: 600_000,
        sharePct: 60,
        label: 'Meteora curve vault',
      },
      {
        owner: 'wallet-1',
        tokenAccount: 'acc-1',
        amount: '250000000000',
        uiAmount: 250_000,
        sharePct: 25,
        label: 'Buyback escrow',
      },
      {
        owner: 'treasury',
        tokenAccount: 'acc-3',
        amount: '150000000000',
        uiAmount: 150_000,
        sharePct: 15,
        label: "Epoch's treasury",
      },
    ]);
    expect(
      mapTopHolders({ accounts: [{ address: 'a', amount: 1n }], owners: [null], decimals: 0, supply: 0n })[0],
    ).toMatchObject({ sharePct: 0, label: null, owner: null });
  });
});
