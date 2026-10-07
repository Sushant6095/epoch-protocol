import { type LaunchRegistryEntry } from '@epoch/meteora';
import { Keypair, PublicKey } from '@solana/web3.js';

import { REHEARSAL, RLOC } from '../../__fixtures__/LaunchFixtures';
import {
  buybackEscrowAddress,
  partnerTreasuryAddress,
  ProgramRevenueTokenSource,
  registryRevenueToken,
  revenueTokenAddress,
  type RevenueTokenChain,
  RpcRevenueTokenChain,
} from './RevenueTokenSource';

const PROGRAM = new PublicKey(RLOC.programId);
/** rLOC as the launch CLI recorded it, registered with the program on the local stand-in. */
const RLOC_ENTRY: LaunchRegistryEntry = {
  mint: 'G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq',
  symbol: 'rLOC',
  name: 'Epoch local revenue token',
  validator: { name: 'Local test validator', vote: 'F8bkJtsc9HhPj9spAQXzGaVYUCtdUMwZVevSvR68d3jB' },
  shareBps: 500,
  termEpochs: 10,
  startEpoch: 1,
  dbcPool: 'AYr4ALrNGSqnxCFuv52NKBfhtXFeQi197bktKEH9NsVp',
  dbcConfig: '7gs7DvMjnzPxGEFGLbHrtCqSGbvV4R6Resb68C2npsWf',
  supply: 1_000_000,
  decimals: 6,
  cluster: 'devnet',
};
const VOTE = new PublicKey(RLOC_ENTRY.validator.vote as string);
const pda = (seed: string, ...keys: PublicKey[]) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map((key) => key.toBuffer())], PROGRAM)[0].toBase58();
const TREASURY = pda('treasury', new PublicKey(pda('pool')));
const RENT = 890_880;
const NOW = Date.parse('2026-10-04T06:20:00Z');

/** The program's cluster with the recorded RevenueToken and escrow. */
function chain(accounts: Record<string, { data: Uint8Array; lamports: number }> = {}): jest.Mocked<RevenueTokenChain> {
  return {
    accounts: jest.fn(async (addresses: readonly PublicKey[]) =>
      addresses.map((key) => accounts[key.toBase58()] ?? null),
    ),
    rentExemptMinimum: jest.fn(async () => RENT),
    epoch: jest.fn(async () => 0),
  };
}
const registered = () =>
  chain({
    [RLOC.address]: { data: Buffer.from(RLOC.data, 'base64'), lamports: RLOC.lamports },
    [RLOC.escrow.address]: { data: new Uint8Array(0), lamports: RLOC.escrow.lamports },
  });

describe('RevenueTokenSource', () => {
  it("derives the program's PDAs with the SDK: RevenueToken, buyback escrow, partner treasury", () => {
    expect(revenueTokenAddress(PROGRAM, VOTE).toBase58()).toBe(pda('revenue_token', VOTE));
    expect(revenueTokenAddress(PROGRAM, VOTE).toBase58()).toBe(RLOC.address);
    expect(buybackEscrowAddress(PROGRAM, VOTE).toBase58()).toBe(RLOC.escrow.address);
    expect(partnerTreasuryAddress(PROGRAM).toBase58()).toBe(TREASURY);
    // The treasury the launch CLI made the DBC fee claimer on the stand-in.
    expect(TREASURY).toBe('CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP');
  });

  it("decodes the registered RevenueToken: the program's terms, the escrow above rent, the buyback settings", async () => {
    const source = new ProgramRevenueTokenSource(PROGRAM, registered(), () => NOW);
    expect(await source.get(RLOC_ENTRY)).toEqual({
      source: 'program',
      programId: PROGRAM.toBase58(),
      address: RLOC.address,
      buybackEscrow: RLOC.escrow.address,
      treasury: TREASURY,
      registeredOnChain: true,
      shareBps: 500,
      termEpochs: 10,
      startEpoch: 1,
      endEpoch: 10,
      registeredEpoch: 0,
      status: 'curve',
      dammPool: null,
      operator: '3Wg6vJYo9jz881tVExLZdBh9x72ZPSUZTwmf5wWANCVJ',
      commissionFloorBps: { inflation: 500, blockRevenue: 1_000 },
      escrow: { balanceSol: 0.1, asOf: '2026-10-04T11:50:00+05:30' },
      buybacks: {
        slicesPerEpoch: 12,
        windowSlots: 9_000,
        maxSlippageBps: 300,
        maxImpactBps: 100,
        paused: false,
        redeemOpen: false,
      },
      totals: {
        escrowedSol: 0,
        spentSol: 0,
        boughtTokens: 0,
        burnedTokens: 0,
        redeemedTokens: 0,
        redeemedSol: 0,
        buybacks: 0,
      },
      note: null,
    });
  });

  it('reuses a read for ten seconds', async () => {
    let clock = NOW;
    const reads = registered();
    const source = new ProgramRevenueTokenSource(PROGRAM, reads, () => clock);
    await source.get(RLOC_ENTRY);
    clock += 9_000;
    await source.get(RLOC_ENTRY);
    expect(reads.accounts).toHaveBeenCalledTimes(1);
    clock += 2_000;
    await source.get(RLOC_ENTRY);
    expect(reads.accounts).toHaveBeenCalledTimes(2);
  });

  it('falls back to the launch record: no program, no vote, not registered, another mint, a failed read', async () => {
    // No program id configured: the record's terms; the PDAs it can derive are null.
    expect(await new ProgramRevenueTokenSource(null, null).get(REHEARSAL)).toMatchObject({
      source: 'registry',
      address: null,
      treasury: REHEARSAL.feeClaimer,
      registeredOnChain: null,
      shareBps: 500,
      startEpoch: 1,
      endEpoch: 10,
      escrow: null,
      totals: null,
    });
    // Not registered yet.
    const empty = chain();
    expect(await new ProgramRevenueTokenSource(PROGRAM, empty).get(RLOC_ENTRY)).toMatchObject({
      source: 'registry',
      address: RLOC.address,
      buybackEscrow: RLOC.escrow.address,
      treasury: TREASURY,
      registeredOnChain: false,
      note: "Not registered with the program yet: the terms are the launch record's.",
    });
    // Registered (the record says so) and the term is over, but no account: closed after its term.
    const closedChain = chain();
    closedChain.epoch.mockResolvedValue(42);
    expect(
      await new ProgramRevenueTokenSource(PROGRAM, closedChain).get({ ...RLOC_ENTRY, registeredEpoch: 0 }),
    ).toMatchObject({ registeredOnChain: false, note: expect.stringMatching(/^Closed after its term/) });
    // The vote account registered another mint.
    const other = await new ProgramRevenueTokenSource(PROGRAM, registered()).get({
      ...RLOC_ENTRY,
      mint: Keypair.generate().publicKey.toBase58(),
    });
    expect(other).toMatchObject({ registeredOnChain: false, note: expect.stringContaining(RLOC_ENTRY.mint) });
    // The RPC fails: the record, with a note; not cached, so the next request reads again.
    const failing = chain();
    failing.accounts.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    const source = new ProgramRevenueTokenSource(PROGRAM, failing);
    expect(await source.get(RLOC_ENTRY)).toMatchObject({
      source: 'registry',
      registeredOnChain: null,
      note: "The program could not be read just now: the terms are the launch record's.",
    });
    expect((await source.get(RLOC_ENTRY)).registeredOnChain).toBe(false);
    // No vote account: nothing to look up.
    const noVote = chain();
    await new ProgramRevenueTokenSource(PROGRAM, noVote).get({ ...RLOC_ENTRY, validator: { name: 'X', vote: null } });
    expect(noVote.accounts).not.toHaveBeenCalled();
  });

  it('the registry fallback keeps what the launch record knows', () => {
    expect(
      registryRevenueToken({ ...RLOC_ENTRY, revenueToken: RLOC.address, registeredEpoch: 0, dammPool: null }, null),
    ).toMatchObject({ address: RLOC.address, registeredEpoch: 0, startEpoch: 1, endEpoch: 10 });
  });

  it('reads through the program source: accounts, the rent once, the epoch', async () => {
    const connection = {
      getMultipleAccountsInfo: jest.fn(async (keys: PublicKey[]) =>
        keys.map((key, i) =>
          i === 0 ? { data: Buffer.from([1, 2]), lamports: 7, owner: PROGRAM, executable: false } : null,
        ),
      ),
      getMinimumBalanceForRentExemption: jest
        .fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValue(RENT),
    };
    const program = {
      connections: { withFailover: <T>(read: (c: typeof connection) => Promise<T>) => read(connection) },
      epochInfo: async () => ({ epoch: 801, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 1 }),
    };
    const rpc = new RpcRevenueTokenChain(program as never);
    expect(await rpc.accounts([PROGRAM, VOTE])).toEqual([{ data: Buffer.from([1, 2]), lamports: 7 }, null]);
    await expect(rpc.rentExemptMinimum()).rejects.toThrow('fetch failed');
    expect(await rpc.rentExemptMinimum()).toBe(RENT);
    expect(await rpc.rentExemptMinimum()).toBe(RENT);
    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledTimes(2);
    expect(await rpc.epoch()).toBe(801);
  });
});
