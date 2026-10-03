import { PublicKey } from '@solana/web3.js';

import { EpochProgramSource, toWsUrl } from './EpochProgramSource';

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

  it('turns an http RPC url into its websocket url', () => {
    expect(toWsUrl('https://api.devnet.solana.com')).toBe('wss://api.devnet.solana.com');
    expect(toWsUrl('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8899');
  });
});
