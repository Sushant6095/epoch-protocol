import { Keypair } from '@solana/web3.js';

import { feeFloat, topUps } from './funding';

describe('topUps', () => {
  it('sends only the shortfall and skips wallets at or above target', () => {
    const [a, b, c] = [0, 1, 2].map(() => Keypair.generate().publicKey);
    const out = topUps(
      [
        { label: 'admin', to: a, lamports: 100n },
        { label: 'scorer', to: b, lamports: 50n },
        { label: 'crank', to: c, lamports: 70n },
      ],
      [30n, 50n, 90n],
    );
    expect(out.map((t) => [t.label, t.send])).toEqual([['admin', 70n]]);
  });

  it('refills a fee float only once it is below its refill line, then to the full target', () => {
    const to = Keypair.generate().publicKey;
    const float = feeFloat('scorer', to, 20_000_000n);
    expect(float.refillBelow).toBe(10_000_000n);
    // A re-run right after a run that paid two fees: above the line, nothing to send.
    expect(topUps([float], [19_990_000n])).toEqual([]);
    // Drained below half: back to the full float.
    expect(topUps([float], [9_000_000n]).map((t) => t.send)).toEqual([11_000_000n]);
  });
});
