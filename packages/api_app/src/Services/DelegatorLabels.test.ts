import { addressToBytes, bytesToAddress, findProgramAddress } from '@epoch/solana';

import { type TokenSource } from '../Sources/ExternalSources';
import { type SolanaDataSource } from '../Sources/SolanaDataSource';
import { DelegatorLabels, keyBase64 } from './DelegatorLabels';

// @epoch/solana pulls in web3.js, whose ESM dependencies jest cannot load; a reversible stand-in is enough here.
jest.mock('@epoch/solana', () => ({
  bytesToAddress: (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8'),
  addressToBytes: (address: string) => Buffer.from(address, 'utf8'),
  findProgramAddress: (seeds: Uint8Array[], programId: string) =>
    `pda(${seeds.map((seed) => Buffer.from(seed).toString('utf8')).join(',')}|${programId})`,
}));

const PROGRAM = 'stake-pool-program';
const POOL = 'pool-1';
const MINT = 'mint-1';
const POOL_OWNER = keyBase64(findProgramAddress([addressToBytes(POOL), Buffer.from('withdraw')], PROGRAM));
const WALLET = keyBase64('plain-wallet');

const build = (symbols: (string | null | undefined)[]) => {
  const solana = {
    getStakePools: jest.fn().mockResolvedValue([{ pool: POOL, mint: addressToBytes(MINT) }]),
  } as unknown as SolanaDataSource;
  const symbol = jest.fn();
  for (const value of symbols) symbol.mockResolvedValueOnce(value);
  const tokens = { symbol } as unknown as TokenSource;
  return { labels: new DelegatorLabels(solana, tokens, undefined, [PROGRAM]), symbol };
};

describe('DelegatorLabels', () => {
  it('names a stake pool by its token symbol and keeps the name', async () => {
    const { labels, symbol } = build(['JitoSOL']);
    await labels.load();
    const label = await labels.resolve(POOL_OWNER);
    expect(label).toMatchObject({ name: 'JitoSOL pool', kind: 'Liquid staking', entity: `pool:${MINT}` });
    expect(label?.address).toBe(bytesToAddress(Buffer.from(POOL_OWNER, 'base64')));
    await labels.resolve(POOL_OWNER);
    expect(symbol).toHaveBeenCalledTimes(1);
  });

  it('retries a failed lookup on the next request instead of keeping the placeholder', async () => {
    const { labels, symbol } = build([undefined, 'JupSOL']);
    await labels.load();
    expect((await labels.resolve(POOL_OWNER))?.name).toBe('Stake pool mint…nt-1');
    expect((await labels.resolve(POOL_OWNER))?.name).toBe('JupSOL pool');
    expect(symbol).toHaveBeenCalledTimes(2);
  });

  it('warms the given owners and leaves unknown wallets unnamed', async () => {
    const { labels, symbol } = build(['BNSOL']);
    await labels.load();
    await labels.warm([POOL_OWNER, WALLET]);
    expect(symbol).toHaveBeenCalledTimes(1);
    expect((await labels.resolve(POOL_OWNER))?.name).toBe('BNSOL pool');
    expect(await labels.resolve(WALLET)).toBeUndefined();
  });
});
