import {
  estimateLaunchCost,
  LAUNCH_ACCOUNT_BYTES,
  METAPLEX_CREATE_FEE_LAMPORTS,
  rentExemptLamports,
} from './launchCost';

describe('estimateLaunchCost', () => {
  it('rent matches what the rehearsal paid for each account', () => {
    // Measured on the rehearsal's launch transactions (Meteora's mainnet programs).
    expect(rentExemptLamports(LAUNCH_ACCOUNT_BYTES.dbcConfig)).toBe(8_184_960);
    expect(rentExemptLamports(LAUNCH_ACCOUNT_BYTES.dbcPool)).toBe(3_841_920);
    expect(rentExemptLamports(LAUNCH_ACCOUNT_BYTES.mint)).toBe(1_461_600);
    expect(rentExemptLamports(LAUNCH_ACCOUNT_BYTES.tokenAccount)).toBe(2_039_280);
    // A 607-byte metadata account held 15,115,600 lamports: its rent plus the 0.01 SOL Metaplex fee.
    expect(rentExemptLamports(607) + METAPLEX_CREATE_FEE_LAMPORTS).toBe(15_115_600);
  });

  it('itemizes a launch: the estimate bounds what the rehearsal spent', () => {
    const cost = estimateLaunchCost({
      newConfig: true,
      signatures: 5,
      transactions: 3,
      initialBuyLamports: 20_000_000,
    });
    expect(cost.items.map((item) => item.label)).toEqual([
      'DBC config account (rent)',
      'DBC pool account (rent)',
      'Token mint (rent)',
      'Curve vaults: token and SOL (rent)',
      'Token metadata (rent, at most) + Metaplex fee',
      'Signature fees',
      'Initial buy',
      "Buyer's token account (rent)",
    ]);
    // The rehearsal's payer spent 0.05474692 SOL on createConfig + createPool (with a 0.02 SOL first buy) + the hand-over.
    expect(cost.totalLamports).toBeGreaterThanOrEqual(54_746_920);
    expect(cost.totalLamports - 54_746_920).toBeLessThan(600_000); // the metadata upper bound (679 vs 607 bytes)
    expect(cost.totalSol).toBeCloseTo(cost.totalLamports / 1e9, 12);
  });

  it('reusing a config saves its rent; priority fees add per transaction', () => {
    const reuse = estimateLaunchCost({ newConfig: false, signatures: 2 });
    expect(reuse.items.some((item) => item.label.startsWith('DBC config'))).toBe(false);
    const priority = estimateLaunchCost({
      newConfig: true,
      signatures: 3,
      transactions: 2,
      priorityFeeLamports: 40_000,
    });
    expect(priority.items.find((item) => item.label === 'Priority fees')?.lamports).toBe(80_000);
  });
});
