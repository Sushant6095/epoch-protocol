import { PublicKey } from '@solana/web3.js';

import { EpochProgramSource, solamiWsUrl, toWsUrl } from './EpochProgramSource';

const config = {
  EPOCH_CLUSTER: 'devnet' as const,
  EPOCH_RPC_URL: 'https://api.devnet.solana.com',
  PROGRAM_EVENTS_INGEST: false,
  PROGRAM_EVENTS_BACKFILL_LIMIT: 0,
};

describe('EpochProgramSource', () => {
  it('answers 503 PROGRAM_NOT_CONFIGURED until EPOCH_PROGRAM_ID is set', async () => {
    const source = new EpochProgramSource(config);
    expect(source.configured).toBe(false);
    expect(() => source.requireProgramId()).toThrow(
      expect.objectContaining({ code: 'PROGRAM_NOT_CONFIGURED', statusCode: 503 }),
    );
    await expect(source.pool()).rejects.toMatchObject({ code: 'PROGRAM_NOT_CONFIGURED' });
  });

  it('derives the pool PDA from the configured program id', () => {
    const programId = new PublicKey(new Uint8Array(32).fill(42)).toBase58();
    const source = new EpochProgramSource({ ...config, EPOCH_PROGRAM_ID: programId });
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from('pool')], new PublicKey(programId));
    expect(source.poolAddress().toBase58()).toBe(expected.toBase58());
  });

  it('drops the pool cache after a treasury claim (cash and income changed)', () => {
    const source = new EpochProgramSource(config);
    const invalidate = jest.spyOn(source, 'invalidate');
    source.invalidateFor('TreasuryClaimed');
    expect(invalidate.mock.calls).toEqual([['pool']]);
  });

  it('drops the positions cache after refresh_score and the score config after configure_scoring', () => {
    const source = new EpochProgramSource(config);
    const invalidate = jest.spyOn(source, 'invalidate');
    source.invalidateFor('ScoreRefreshed');
    source.invalidateFor('ScoringConfigured');
    source.invalidateFor('VoteAccountCopied'); // histories are read fresh: nothing cached to drop
    expect(invalidate.mock.calls).toEqual([['positions'], ['scoreConfig']]);
  });

  it('reads a ValidatorHistory at ["history", vote] and ignores an account the program does not own', async () => {
    const programId = new PublicKey(new Uint8Array(32).fill(42));
    const vote = new PublicKey(new Uint8Array(32).fill(7));
    const source = new EpochProgramSource({ ...config, EPOCH_PROGRAM_ID: programId.toBase58() });
    await expect(new EpochProgramSource(config).validatorHistory(vote.toBase58())).rejects.toMatchObject({
      code: 'PROGRAM_NOT_CONFIGURED',
    });
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from('history'), vote.toBytes()], programId);
    const asked: string[] = [];
    let owner: PublicKey | null = null;
    jest.spyOn(source.connections, 'withFailover').mockImplementation(async (fn) =>
      fn({
        getAccountInfo: async (address: PublicKey) => {
          asked.push(address.toBase58());
          return owner ? { owner, data: Buffer.alloc(8_352), lamports: 1, executable: false } : null;
        },
      } as never),
    );
    expect(await source.validatorHistory(vote.toBase58())).toBeNull();
    owner = PublicKey.default; // someone else's account at that address
    expect(await source.validatorHistory(vote.toBase58())).toBeNull();
    expect(asked).toEqual([expected.toBase58(), expected.toBase58()]);
  });

  it('turns an http RPC url into its websocket url', () => {
    expect(toWsUrl('https://api.devnet.solana.com')).toBe('wss://api.devnet.solana.com');
    expect(toWsUrl('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8899');
  });

  it("sends a Solami RPC url to Solami's websocket host, keeping the region and the key", () => {
    // solami.dev/docs, "Endpoints and regions": RPC https://rpc.solami.dev/sol, WebSocket wss://ws.solami.dev/ws/sol,
    // both `?api_key=`; a region prefixes the host (fra.rpc… ↔ fra.ws…).
    expect(toWsUrl('https://rpc.solami.dev/sol?api_key=k1')).toBe('wss://ws.solami.dev/ws/sol?api_key=k1');
    expect(toWsUrl('https://fra.rpc.solami.dev/sol?api_key=k1')).toBe('wss://fra.ws.solami.dev/ws/sol?api_key=k1');
    expect(toWsUrl('https://rpc.solami.dev/sol/')).toBe('wss://ws.solami.dev/ws/sol');
    expect(solamiWsUrl('https://api.mainnet-beta.solana.com')).toBeUndefined();
    expect(solamiWsUrl('https://rpc.solami.dev.evil.example/sol')).toBeUndefined();
    expect(solamiWsUrl('http://rpc.solami.dev/sol')).toBeUndefined();
  });
});
