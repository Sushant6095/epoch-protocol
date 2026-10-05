import { type LaunchRegistryEntry } from '@epoch/meteora';
import { PublicKey } from '@solana/web3.js';

import { type LaunchChainReader, readLaunchChain, RpcLaunchChainReader } from './LaunchChain';

/** rLOC's buyback escrow on the local stand-in: 0.1 SOL of shares on top of the 890,880 lamports of rent. */
const ESCROW = '9wjpf4Uw2w1BQ3SC3mygBz7tUDNi7Fwpu4WRSAL9PHva';
const RENT = 890_880;

function rpc(balances: Record<string, number>) {
  const connection = {
    getBalance: jest.fn(async (address: PublicKey) => balances[address.toBase58()] ?? 0),
    getMinimumBalanceForRentExemption: jest
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(RENT),
  };
  const connections = { withFailover: <T>(read: (c: typeof connection) => Promise<T>) => read(connection) };
  return { connection, reader: new RpcLaunchChainReader(connections as never) };
}

describe('LaunchChain', () => {
  it("reports the escrow's SOL above rent, as the program and the buyback feed count it", async () => {
    const { connection, reader } = rpc({ [ESCROW]: 100_890_880, [PublicKey.default.toBase58()]: 500_000 });
    // A failed rent read is not kept: the next read asks again.
    await expect(reader.escrowSol(ESCROW)).rejects.toThrow('fetch failed');
    expect(await reader.escrowSol(ESCROW)).toBe(0.1);
    // Never below zero (an account short of its rent), and the rent is read once.
    expect(await reader.escrowSol(PublicKey.default.toBase58())).toBe(0);
    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledTimes(2);
    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(0);
  });

  it('reads the launch with the escrow above rent', async () => {
    const reader: LaunchChainReader = {
      epochInfo: jest.fn(),
      launchPool: jest.fn().mockResolvedValue(null),
      dammPool: jest.fn().mockResolvedValue(null),
      mint: jest.fn().mockResolvedValue(null),
      holders: jest.fn(),
      escrowSol: jest.fn().mockResolvedValue(0.1),
    };
    const entry = {
      mint: 'G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq',
      symbol: 'rLOC',
      name: 'Epoch local revenue token',
      validator: { name: 'Local test validator', vote: 'F8bkJtsc9HhPj9spAQXzGaVYUCtdUMwZVevSvR68d3jB' },
      shareBps: 500,
      termEpochs: 10,
      startEpoch: 1,
      escrow: ESCROW,
      supply: 1_000_000,
      decimals: 6,
      cluster: 'devnet',
    } satisfies LaunchRegistryEntry;
    expect(await readLaunchChain(entry, reader)).toMatchObject({ escrowSol: 0.1, failed: [] });
    expect(reader.escrowSol).toHaveBeenCalledWith(ESCROW);
  });
});
