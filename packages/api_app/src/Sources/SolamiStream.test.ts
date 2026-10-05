import { CommitmentLevel, SolamiUsage } from '@epoch/solana';

import { FakeGrpc, fixtureUpdate, YELLOWSTONE_PROGRAM } from '../__fixtures__/YellowstoneFakes';
import { type LiveStreamState, type ProgramTransaction, SolamiStream } from './SolamiStream';

const ENDPOINT = { name: 'solami', url: 'https://grpc.solami.dev', token: 'not-a-real-key' };

function stream(programId?: string) {
  const fakes: FakeGrpc[] = [];
  const usage = new SolamiUsage('api');
  const solami = new SolamiStream({
    endpoint: ENDPOINT,
    programId,
    usage,
    createStream: (_endpoints, options) => {
      const fake = new FakeGrpc(options);
      fakes.push(fake);
      return fake;
    },
  });
  return { solami, fakes, usage };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('SolamiStream', () => {
  it('subscribes once for confirmed slots and the program’s successful transactions', async () => {
    const { solami, fakes } = stream(YELLOWSTONE_PROGRAM.program);
    expect(solami.state).toBe('idle');
    solami.onSlot(() => undefined);
    solami.onProgramTransaction(() => undefined);
    await flush();
    // One connection for both listeners.
    expect(fakes).toHaveLength(1);
    expect(fakes[0].options).toMatchObject({ subscription: 'slots+program' });
    expect(fakes[0].request).toMatchObject({
      slots: { slots: { filterByCommitment: true } },
      transactions: {
        program: {
          vote: false,
          failed: false,
          accountInclude: [YELLOWSTONE_PROGRAM.program],
          accountExclude: [],
          accountRequired: [],
        },
      },
      commitment: CommitmentLevel.CONFIRMED,
    });
    await solami.stop();
    expect(fakes[0].stopped).toBe(true);
    expect(solami.state).toBe('stopped');
  });

  it('asks for slots only when the program does not run on mainnet', async () => {
    const { solami, fakes } = stream();
    solami.onSlot(() => undefined);
    await flush();
    expect(fakes[0].request?.transactions).toEqual({});
    expect(fakes[0].options).toMatchObject({ subscription: 'slots' });
    await solami.stop();
  });

  it('decodes Yellowstone updates: confirmed slots, and transactions with their logs and base58 signature', async () => {
    const { solami, fakes } = stream(YELLOWSTONE_PROGRAM.program);
    const slots: number[] = [];
    const txs: ProgramTransaction[] = [];
    solami.onSlot((slot) => slots.push(slot));
    solami.onProgramTransaction((tx) => txs.push(tx));
    await flush();
    for (let i = 0; i < YELLOWSTONE_PROGRAM.updates.length; i++) await fakes[0].deliver(fixtureUpdate(i));
    // The processed status of 453,600,002 is not a confirmed slot.
    expect(slots).toEqual([453_600_001]);
    expect(txs.map((t) => [t.signature, t.slot, t.failed, t.logs.length])).toEqual([
      [YELLOWSTONE_PROGRAM.updates[2].signature, 453_600_001, false, 6],
      [YELLOWSTONE_PROGRAM.updates[3].signature, 453_600_002, false, 8],
    ]);
    expect(txs[0].logs[0]).toBe(`Program ${YELLOWSTONE_PROGRAM.program} invoke [1]`);
    await solami.stop();
  });

  it('reports its state, and `failed` (for good) when Solami refuses the key', async () => {
    const { solami, fakes } = stream(YELLOWSTONE_PROGRAM.program);
    const states: LiveStreamState[] = [];
    solami.onState((state) => states.push(state));
    solami.onSlot(() => undefined);
    await flush();
    fakes[0].status('streaming');
    fakes[0].status('reconnecting');
    fakes[0].refuse(
      Object.assign(new Error('failed to open subscribe stream'), {
        cause: new Error(`gRPC status: code: 'x', message: "invalid api key"`),
      }),
    );
    await flush();
    expect(states).toEqual(['connecting', 'streaming', 'reconnecting', 'failed']);
    // A refused key is not retried: no second connection.
    solami.onSlot(() => undefined);
    expect(fakes).toHaveLength(1);
    expect(solami.state).toBe('failed');
    // The fatal check is Solami's own refusal texts (explainSolamiError).
    const isFatal = fakes[0].options.isFatal as (error: unknown) => boolean;
    expect(isFatal(new Error('UNAUTHENTICATED: invalid api key'))).toBe(true);
    expect(isFatal(new Error('PERMISSION_DENIED: this key does not have gRPC access'))).toBe(true);
    expect(isFatal(new Error('UNAVAILABLE: server is shutting down, please reconnect to another instance'))).toBe(
      false,
    );
    expect(isFatal(new Error('RESOURCE_EXHAUSTED: max concurrent streams (2) reached for your tier'))).toBe(false);
  });
});
