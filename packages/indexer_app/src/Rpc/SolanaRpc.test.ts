import { BlockFetcher, RateLimiter } from '../Streams/BlockFetcher';
import { recordedBlocks } from '../__fixtures__/mainnetBlocks';
import { redact, RpcError, rpcHost, SolanaRpc } from './SolanaRpc';

const KEY = 'not-a-real-key-123';
const URL_WITH_KEY = `https://rpc.solami.dev/sol?api_key=${KEY}`;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('SolanaRpc', () => {
  it('sends JSON-RPC and asks getBlock for v1 transactions in base64', async () => {
    const fetchFn = jest.fn(async () => reply(200, { jsonrpc: '2.0', id: 1, result: null }));
    const rpc = new SolanaRpc(URL_WITH_KEY, { fetchFn: fetchFn as unknown as typeof fetch });
    await rpc.getBlock(452_937_393);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe(URL_WITH_KEY);
    expect(JSON.parse(init.body)).toMatchObject({
      method: 'getBlock',
      params: [
        452_937_393,
        {
          encoding: 'base64',
          maxSupportedTransactionVersion: 1,
          transactionDetails: 'full',
          rewards: true,
          commitment: 'confirmed',
        },
      ],
    });
    expect(rpc.host).toBe('rpc.solami.dev');
  });

  it('retries Solami’s HTTP-200 rate limit (-32005), HTTP 429 and network errors', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(reply(200, { error: { code: -32005, message: 'Rate limited' } }))
      .mockResolvedValueOnce(reply(429, {}, { 'retry-after': '0' }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(200, { result: 452_937_400 }));
    const rpc = new SolanaRpc(URL_WITH_KEY, { fetchFn: fetchFn as unknown as typeof fetch });
    await expect(rpc.getSlot()).resolves.toBe(452_937_400);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('does not retry a refused key, and never puts the key in an error', async () => {
    const fetchFn = jest.fn(async () => reply(401, { message: 'unauthorized' }));
    const rpc = new SolanaRpc(URL_WITH_KEY, { fetchFn: fetchFn as unknown as typeof fetch });
    const error = (await rpc.getSlot().catch((e: unknown) => e)) as Error;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toContain(KEY);
  });

  it('surfaces node errors with their code (e.g. a skipped slot)', async () => {
    const fetchFn = jest.fn(async () =>
      reply(200, { error: { code: -32007, message: 'Slot 452937313 was skipped, or missing due to ledger jump' } }),
    );
    const rpc = new SolanaRpc(URL_WITH_KEY, { fetchFn: fetchFn as unknown as typeof fetch });
    await expect(rpc.getBlock(452_937_313)).rejects.toMatchObject({ code: -32007 });
  });

  it('redacts keys from URLs and messages', () => {
    expect(rpcHost(URL_WITH_KEY)).toBe('rpc.solami.dev');
    expect(redact(`GET ${URL_WITH_KEY}&x=1`)).toBe('GET https://rpc.solami.dev/sol?api_key=***&x=1');
    expect(redact(`token ${KEY} leaked`, [KEY])).toBe('token *** leaked');
  });
});

describe('BlockFetcher', () => {
  const recorded = recordedBlocks().blocks[2];

  it('decodes a block, reports skipped slots, and retries "not available yet"', async () => {
    let calls = 0;
    const rpc = {
      getBlock: async (slot: number) => {
        calls++;
        if (slot === 1) throw new RpcError(-32007, 'skipped');
        if (slot === 2) throw new RpcError(-32009, 'skipped in long-term storage');
        if (slot === 3 && calls < 6) throw new RpcError(-32004, 'Block not available for slot 3');
        return recorded.block;
      },
    };
    const fetcher = new BlockFetcher(rpc, new RateLimiter(1_000, 2), 5, 1);
    expect(await fetcher.fetch(1)).toEqual({ kind: 'skipped', slot: 1 });
    expect(await fetcher.fetch(2)).toEqual({ kind: 'skipped', slot: 2 });
    const result = await fetcher.fetch(3);
    expect(result.kind).toBe('block');
    if (result.kind === 'block') expect(result.block.txs).toHaveLength(recorded.reference.nonVote);
  });

  it('gives up after the retries so the caller can try again later', async () => {
    const fetcher = new BlockFetcher({ getBlock: async () => null }, new RateLimiter(1_000, 1), 2, 1);
    await expect(fetcher.fetch(9)).rejects.toMatchObject({ code: -32004 });
  });
});

describe('RateLimiter', () => {
  it('spaces calls and caps concurrency', async () => {
    const limiter = new RateLimiter(100, 2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          started.push(Date.now() - t0);
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    // 6 calls at 100/s: the last starts no sooner than ~50 ms in.
    expect(Math.max(...started)).toBeGreaterThanOrEqual(45);
  });
});
