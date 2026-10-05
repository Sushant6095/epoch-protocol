import { type GeyserUnaryClient, type SubscribeRequest, type SubscribeUpdate } from '@epoch/solana';

import { FakeChain } from '../__fixtures__/FakeChain';
import { formatReport, SolamiCheck, type SolamiCheckOptions } from './SolamiCheck';

const TOKEN = 'grpc-secret-token';
const RPC_KEY = 'rpc-secret-key';
const RPC_URL = `https://rpc.solami.dev/sol?api_key=${RPC_KEY}`;

/** A fake Solami: unary calls, a meta stream from FakeChain, and the firehose (allowed or refused). */
function fakeSolami(chain: FakeChain, options: { firehose: 'ok' | 'refused'; auth?: 'refused' }) {
  const subscriptions: SubscribeRequest[] = [];
  const client: GeyserUnaryClient = {
    connect: async () => undefined,
    getVersion: async () => ({
      version: JSON.stringify({ version: { package: 'yellowstone-grpc-geyser', version: '15.2.1', solana: '4.2.2' } }),
    }),
    subscribeReplayInfo: async () => ({ firstAvailable: String(chain.tip - 3_000) }),
    getSlot: async () => ({ slot: String(chain.tip) }),
    subscribe: async (request?: SubscribeRequest) => {
      subscriptions.push(request as SubscribeRequest);
      if (options.auth === 'refused') {
        throw Object.assign(new Error('failed to open subscribe stream'), {
          cause: new Error(
            `gRPC status: code: 'The request does not have valid authentication credentials', message: "invalid api key"`,
          ),
        });
      }
      const firehose = Object.keys(request?.transactions ?? {}).length > 0;
      if (firehose && options.firehose === 'refused') {
        throw new Error(
          'status: PermissionDenied, message: "unfiltered/firehose subscriptions are not allowed on non-PAYG streams"',
        );
      }
      return {
        destroy: () => undefined,
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 40; i++) {
            chain.tip++;
            const updates: SubscribeUpdate[] = firehose ? chain.firehose(chain.tip) : chain.meta(chain.tip);
            for (const update of updates) yield update;
          }
        },
      };
    },
  };
  return { client, subscriptions };
}

function check(chain: FakeChain, solami: ReturnType<typeof fakeSolami>, patch: Partial<SolamiCheckOptions> = {}) {
  let now = 1_000_000;
  const lines: string[] = [];
  const result = new SolamiCheck(
    {
      grpc: { name: 'solami', url: 'https://grpc.solami.dev', token: TOKEN },
      rpc: {
        url: RPC_URL,
        getVersion: async () => ({ 'solana-core': '4.2.2' }),
        getSlot: async () => chain.tip - 1,
        getEpochInfo: async () => ({ epoch: 1048, slotIndex: 210_000, slotsInEpoch: 432_000, absoluteSlot: chain.tip }),
      },
      slots: 5,
      firehoseSeconds: 2,
      secrets: [TOKEN, RPC_KEY],
      ...patch,
    },
    {
      createClient: () => solami.client,
      fetchJson: async (url) =>
        url.endsWith('/pricing')
          ? { payg: { grpc: { usd_per_gb: 0.08 } } }
          : ['15qWd4huAkoxvhDsHMfpUn27TW1YBYMMJJ2jkAkbeam'],
      now: () => (now += 50),
      sleep: async () => undefined,
      log: (line) => lines.push(line),
    },
  );
  return { check: result, lines };
}

describe('SolamiCheck', () => {
  it('passes with a working key, reports the replay window, block timing and the firehose cost', async () => {
    const chain = new FakeChain(432_000, () => false, 452_937_000);
    const solami = fakeSolami(chain, { firehose: 'ok' });
    const { check: c, lines } = check(chain, solami);
    const results = await c.run();
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['rpc', 'PASS'],
      ['grpc endpoint', 'PASS'],
      ['grpc key', 'PASS'],
      ['grpc firehose', 'PASS'],
      ['beam', 'PASS'],
    ]);
    expect(results[1].detail).toContain('yellowstone-grpc-geyser 15.2.1 (solana 4.2.2)');
    expect(results[1].detail).toContain('from_slot replay window 3000 slots');
    expect(results[2].detail).toMatch(/5 confirmed block metas/);
    expect(results[3].detail).toMatch(/GiB\/day ≈ \$\d+\.\d\d\/day at \$0\.08\/GB/);
    expect(c.passed).toBe(true);
    // The meta request first, then the indexer's firehose request.
    expect(Object.keys(solami.subscriptions[0].transactions)).toEqual([]);
    expect(Object.keys(solami.subscriptions[1].transactions)).toEqual(['fees']);
    const printed = [...lines, formatReport(results)].join('\n');
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(RPC_KEY);
    expect(printed).toContain('Solami check: PASS');
  });

  it('warns (not fails) when the plan refuses the firehose, pointing at hybrid mode and PAYG', async () => {
    const chain = new FakeChain(432_000, () => false, 452_937_000);
    const { check: c } = check(chain, fakeSolami(chain, { firehose: 'refused' }));
    const results = await c.run();
    const firehose = results.find((r) => r.name === 'grpc firehose');
    expect(firehose?.status).toBe('WARN');
    expect(firehose?.detail).toContain('SLOT_SOURCE=hybrid');
    expect(c.passed).toBe(true);
  });

  it('fails clearly on a refused key or a missing token, without printing either', async () => {
    const chain = new FakeChain(432_000, () => false, 452_937_000);
    const refused = check(chain, fakeSolami(chain, { firehose: 'ok', auth: 'refused' }));
    const results = await refused.check.run();
    // The endpoint answers its unary calls without a key; the subscription is what proves the key.
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['rpc', 'PASS'],
      ['grpc endpoint', 'PASS'],
      ['grpc key', 'FAIL'],
      ['beam', 'PASS'],
    ]);
    expect(results.find((r) => r.name === 'grpc key')?.detail).toContain('check SOLAMI_TOKEN');
    expect(refused.check.passed).toBe(false);

    const missing = check(chain, fakeSolami(chain, { firehose: 'ok' }), { grpc: undefined, rpc: undefined });
    const out = await missing.check.run();
    expect(out.map((r) => [r.name, r.status])).toEqual([
      ['rpc', 'WARN'],
      ['grpc', 'FAIL'],
      ['beam', 'PASS'],
    ]);
  });
});
