import { findFeeIndexPda, findPoolPda } from '@epoch/epoch-sdk';
import { Keypair } from '@solana/web3.js';

import { type FeeIndexStatus } from '../../types/Activity.types';
import { type FeeIndexEpochDeps, FeeIndexEpochService } from './FeeIndexEpochService';

const PROGRAM = Keypair.generate().publicKey;

/** epoch_index rows (mainnet epochs), program points (program epochs) and posts (signature → program epoch). */
function service(
  setup: {
    computed?: Record<number, { value: number; postedSignature: string | null }>;
    points?: Record<number, { value: number; status: FeeIndexStatus }>;
    posts?: Record<string, number>;
    cluster?: string;
    program?: boolean;
  } = {},
) {
  const deps: FeeIndexEpochDeps = {
    computed: async (epoch) => setup.computed?.[epoch] ?? null,
    programPoint: async (epoch) => setup.points?.[epoch] ?? null,
    postedEpoch: async (signature) => setup.posts?.[signature] ?? null,
    program: { programId: setup.program === false ? null : PROGRAM.toBase58(), cluster: setup.cluster ?? 'devnet' },
    methodologyUrl: 'https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md',
    now: () => Date.parse('2026-10-03T12:00:00Z'),
  };
  return new FeeIndexEpochService(deps);
}

describe('FeeIndexEpochService (GET /v1/index/epochs/:epoch)', () => {
  it('walks a mainnet epoch from pending to final through its post on a devnet program', async () => {
    expect(await service().epoch(1_051)).toMatchObject({ epoch: 1_051, status: 'pending', value: null, final: false });

    const computed = { 1_051: { value: 1_400, postedSignature: null } };
    expect(await service({ computed }).epoch(1_051)).toMatchObject({
      status: 'computed',
      value: 1_400,
      final: false,
      onChain: { programEpoch: null, postSignature: null },
    });

    const posted = { 1_051: { value: 1_400, postedSignature: 'sigPost' } };
    const posts = { sigPost: 1_176 };
    expect(
      await service({ computed: posted, posts, points: { 1_176: { value: 1_400, status: 'proposed' } } }).epoch(1_051),
    ).toMatchObject({ status: 'proposed', final: false, onChain: { programEpoch: 1_176, postSignature: 'sigPost' } });

    const final = await service({
      computed: posted,
      posts,
      points: { 1_176: { value: 1_400, status: 'final' } },
    }).epoch(1_051);
    expect(final).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      epoch: 1_051,
      value: 1_400,
      status: 'final',
      final: true,
      unit: 'µL/CU',
      computedValue: 1_400,
      onChain: {
        cluster: 'devnet',
        programId: PROGRAM.toBase58(),
        feeIndexAccount: findFeeIndexPda(PROGRAM, findPoolPda(PROGRAM)[0])[0].toBase58(),
        programEpoch: 1_176,
      },
    });
    expect(final.asOf).toBe('2026-10-03T17:30:00+05:30');
    expect(final.note).toContain('final: the dispute window passed without a veto');
  });

  it('reports a veto, and the program’s value over the computed one', async () => {
    const view = await service({
      computed: { 1_051: { value: 1_400, postedSignature: 'sigPost' } },
      posts: { sigPost: 1_176 },
      points: { 1_176: { value: 9_999, status: 'vetoed' } },
    }).epoch(1_051);
    expect(view).toMatchObject({ status: 'vetoed', final: false, value: 9_999, computedValue: 1_400 });
  });

  it('uses the same epoch number when the program runs on mainnet', async () => {
    const view = await service({ cluster: 'mainnet', points: { 1_051: { value: 1_380, status: 'final' } } }).epoch(
      1_051,
    );
    expect(view).toMatchObject({ status: 'final', value: 1_380, onChain: { programEpoch: 1_051 } });
  });

  it('is never final without the Epoch program', async () => {
    const view = await service({
      program: false,
      computed: { 1_051: { value: 1_400, postedSignature: 'sigPost' } },
      points: { 1_051: { value: 1_400, status: 'final' } },
    }).epoch(1_051);
    expect(view).toMatchObject({ status: 'computed', final: false, onChain: null });
  });
});
