import * as sdk from '@epoch/epoch-sdk';

import { rentFromPerByte } from '../lib/budget';
import { cp1Lines, CP1_REVENUE } from './budget';
import { CP1_COMMISSION, CP1_STEPS, resultsMarkdown } from './cp1';

const base = {
  cluster: 'devnet',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  programId: 'P',
  vote: 'V',
  identity: 'I',
  withdrawer: 'W',
  voteAuth: 'A',
  escrow: 'E',
  link: (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  writtenAt: '2026-10-07 18:40 IST',
};

describe('cp1', () => {
  it('only ever decreases the commission, so the refusal can only be the authority', () => {
    expect(CP1_COMMISSION.control).toBeLessThan(CP1_COMMISSION.initial);
    expect(CP1_COMMISSION.refused).toBeLessThan(CP1_COMMISSION.control);
    expect(CP1_COMMISSION.closing).toBeLessThanOrEqual(CP1_COMMISSION.control);
  });

  it('marks the steps after the epoch boundary as pending until they ran', () => {
    const md = resultsMarkdown({
      ...base,
      steps: {
        'control-before': { at: 'x', signature: 'sig0' },
        onboard: { at: 'x', signature: 'sig1' },
        'set-collectors': { at: 'x', signature: 'sig2' },
        'direct-update-refused': {
          at: 'x',
          signature: 'sig3',
          err: '{"InstructionError":[0,"MissingRequiredSignature"]}',
        },
      },
    });
    expect(md).toContain('Steps 4–5 run after the next epoch boundary.');
    expect(md).toContain('failed as expected: `{"InstructionError":[0,"MissingRequiredSignature"]}`');
    expect(md).toContain('(https://explorer.solana.com/tx/sig1?cluster=devnet)');
    expect(md.match(/\| pending \|/g)).toHaveLength(4);
  });

  it('says all steps passed once every step has a signature', () => {
    const steps = Object.fromEntries(CP1_STEPS.map(([id], i) => [id, { at: 'x', signature: `sig${i}` }]));
    const md = resultsMarkdown({ ...base, steps });
    expect(md).toContain('All steps passed.');
    expect(md).not.toContain('pending');
  });

  it('is priced from the cluster rent: vote account, reserve, rents, float and the swept revenue', () => {
    const rent = rentFromPerByte(5_080n);
    const lines = cp1Lines(rent, 100_000_000n);
    const total = lines.reduce((a, l) => a + l.lamports, 0n);
    // Devnet, 0.1 SOL reserve: 0.153820120 SOL, of which the 0.01 SOL revenue comes back.
    expect(total).toBe(
      rent(3_762) + 100_000_000n + rent(sdk.ACCOUNT_SIZES.ValidatorPosition) + rent(0) * 2n + 20_000_000n + CP1_REVENUE,
    );
    expect(total).toBe(153_820_120n);
    expect(lines.filter((l) => l.recoverable).map((l) => l.lamports)).toEqual([CP1_REVENUE]);
  });
});
