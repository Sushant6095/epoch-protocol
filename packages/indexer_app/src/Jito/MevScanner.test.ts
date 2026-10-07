import {
  bytesToAddress,
  claimStatusAddress,
  JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
  JITO_TIP_DISTRIBUTION_PROGRAM_ID,
  type ProgramAccountsFilter,
} from '@epoch/solana';

import { MemoryMevRepository } from '../Repositories/MevRepository';
import { type RpcAccountInfo, type RpcKeyedAccount } from '../Rpc/SolanaRpc';
import fixture from '../__fixtures__/jito-mev-accounts.json';
import { MevScanner, type MevScanRpc } from './MevScanner';

// Real mainnet accounts (epochs 1050 and 1051, read 7 Oct 2026): three TDAs of epoch 1050 at 0, 700 and 10,000 bps,
// the epoch's three PFDAs, the 1051 TDA of the 0-bps validator (no root yet) and the two commission-node ClaimStatus.
const V0 = '3N7s9zXMZ4QqvHQR15t5GNHyqc89KduzMP7423eWiD5g';
const TDA_700 = '8LpeJwvZxerRJPMq7nbZgnHoGXJSvQa8JdGzhyAYs7nC';
const TDA_10000 = '2CzcKdpHizZjxeb85XW7TUqfM9C6BLVwzSR1xzJmusnC';

interface RawAccount {
  pubkey: string;
  account: { lamports: number; data: string[] };
}

const keyed = (owner: string, raw: RawAccount): RpcKeyedAccount => ({
  pubkey: raw.pubkey,
  lamports: raw.account.lamports,
  owner,
  data: Buffer.from(raw.account.data[0], 'base64'),
});

/** A mainnet RPC over the fixture: applies dataSize and memcmp filters the way the node does. */
class FixtureRpc implements MevScanRpc {
  calls: string[] = [];
  claimsVisible = true;
  extra: RpcKeyedAccount[] = [];
  /** Accounts getMultipleAccounts answers besides the fixture's ClaimStatus (by address). */
  extraAccounts = new Map<string, RpcAccountInfo>();

  constructor(private readonly epoch: number) {}

  private readonly accounts: RpcKeyedAccount[] = [
    ...fixture.tdas1050.map((a) => keyed(JITO_TIP_DISTRIBUTION_PROGRAM_ID, a)),
    ...fixture.tdas1051.map((a) => keyed(JITO_TIP_DISTRIBUTION_PROGRAM_ID, a)),
    ...fixture.pfdas1050.map((a) => keyed(JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID, a)),
  ];

  async getEpochInfo() {
    this.calls.push('getEpochInfo');
    return { epoch: this.epoch, slotIndex: 1, slotsInEpoch: 432_000, absoluteSlot: this.epoch * 432_000 + 1 };
  }

  async getMinimumBalanceForRentExemption(size: number) {
    this.calls.push(`rent:${size}`);
    return fixture.rentLamports168;
  }

  async getProgramAccounts(programId: string, filters: ProgramAccountsFilter[]) {
    this.calls.push(`gpa:${programId.slice(0, 4)}`);
    return [...this.accounts, ...this.extra].filter(
      (a) =>
        a.owner === programId &&
        filters.every((f) => {
          if ('dataSize' in f) return a.data.length === f.dataSize;
          const bytes = Buffer.from(f.memcmp.bytes, 'base64');
          return Buffer.from(a.data.subarray(f.memcmp.offset, f.memcmp.offset + bytes.length)).equals(bytes);
        }),
    );
  }

  async getMultipleAccounts(pubkeys: string[]): Promise<(RpcAccountInfo | null)[]> {
    this.calls.push(`multiple:${pubkeys.length}`);
    return pubkeys.map((key) => {
      const found = this.claimsVisible ? fixture.claimStatuses.find((c) => c.address === key) : undefined;
      if (!found) return this.extraAccounts.get(key) ?? null;
      return {
        lamports: found.lamports,
        owner: JITO_TIP_DISTRIBUTION_PROGRAM_ID,
        data: Buffer.from(found.data, 'base64'),
      };
    });
  }
}

const scanner = (rpc: MevScanRpc, repo: MemoryMevRepository, backfillEpochs = 2) =>
  new MevScanner(rpc, repo, { intervalMinutes: 60, backfillEpochs, spacingMs: 0 });

const row = (repo: MemoryMevRepository, vote: string, epoch: number) =>
  [...repo.rows.values()].find((r) => r.vote === vote && r.epoch === epoch);
const byTda = (repo: MemoryMevRepository, tda: string) => [...repo.rows.values()].find((r) => r.tda === tda);

describe('MevScanner', () => {
  it('reads an epoch in bulk: commission, tips, root, claims; 0 % commission is `none`, not a missed claim', async () => {
    const rpc = new FixtureRpc(1051);
    const repo = new MemoryMevRepository();
    const result = await scanner(rpc, repo).scanOnce();

    // getEpochInfo, rent, then per epoch 2 TDA + 2 PFDA calls; one getMultipleAccounts for epoch 1050's two
    // commission nodes (the 0-bps validator's node is never read).
    expect(rpc.calls).toEqual([
      'getEpochInfo',
      'rent:168',
      'gpa:4R3g',
      'gpa:4R3g',
      'gpa:Prio',
      'gpa:Prio',
      'gpa:4R3g',
      'gpa:4R3g',
      'gpa:Prio',
      'gpa:Prio',
      'multiple:2',
    ]);
    expect(result).toMatchObject({ currentEpoch: 1051, rentLamports: 1_503_680, skipped: [], expired: 0 });
    expect(result.scanned).toEqual([
      { epoch: 1051, tdas: 1, pfdas: 0, claimsRead: 0, undecoded: 0 },
      { epoch: 1050, tdas: 3, pfdas: 3, claimsRead: 2, undecoded: 0 },
    ]);

    expect(row(repo, V0, 1050)).toMatchObject({
      tda: '9K9MRQencRx8cZbtK9bvkdYgc3znvyUSjtAUP1TbCUDE',
      mevCommissionBps: 0,
      tipsLamports: 164_413_744_343n,
      rootUploaded: true,
      nodesClaimed: 940,
      maxNodes: 1_151,
      validatorClaim: 'none',
      validatorShareLamports: 0n,
      validatorShareEstimated: false,
      expiresAt: 1_060,
    });
    // 700 bps: the ClaimStatus amount is exactly ⌊tips × 700 ÷ 10,000⌋.
    expect(byTda(repo, TDA_700)).toMatchObject({
      mevCommissionBps: 700,
      tipsLamports: 106_700_426_062n,
      validatorClaim: 'claimed',
      validatorShareLamports: 7_469_029_824n,
      validatorShareEstimated: false,
      validatorClaimedSlot: 454_050_628,
    });
    // 10,000 bps: the protocol fee comes first, so the claim is below the tips.
    expect(byTda(repo, TDA_10000)).toMatchObject({
      mevCommissionBps: 10_000,
      tipsLamports: 108_786_690_982n,
      validatorClaim: 'claimed',
      validatorShareLamports: 105_425_182_231n,
      validatorClaimedSlot: 454_043_187,
    });
    // The epoch in progress: no root, tips so far = TDA balance − rent read from the RPC.
    expect(row(repo, V0, 1051)).toMatchObject({
      tda: '719ow3CJtkEN3YLzyjtq1pEM18aqbUqSDtGsvbnqDgHu',
      rootUploaded: false,
      tdaLamports: 32_921_835_444n,
      tipsLamports: 32_921_835_444n - 1_503_680n,
      nodesClaimed: null,
    });
    // Validators with only a PFDA this epoch get a row with the PFDA fields.
    const pfOnly = [...repo.rows.values()].filter((r) => r.epoch === 1050 && r.tda === null);
    expect(pfOnly).toHaveLength(3);
    expect(pfOnly).toContainEqual(
      expect.objectContaining({
        pfda: '7DteLZUv7xTR8nf2Ym2YMa9igaXmD6c8UAeg36PYtkr5',
        pfCommissionBps: 5_000,
        pfRootUploaded: true,
        pfTotalClaimLamports: 0n,
        // 50 % of nothing: the validator node is 0, so it is never claimed.
        pfValidatorClaim: 'none',
        mevCommissionBps: null,
        validatorClaim: null,
      }),
    );
  });

  it("reads a PFDA validator node's ClaimStatus only when the node is above 0 (existence = claimed)", async () => {
    const rpc = new FixtureRpc(1051);
    // The real 50 % PFDA of epoch 1050 with a total set to 1 SOL for this test (max_total_claim at offset 105).
    const raw = fixture.pfdas1050.find((a) => a.pubkey === '7DteLZUv7xTR8nf2Ym2YMa9igaXmD6c8UAeg36PYtkr5')!;
    const data = Buffer.from(raw.account.data[0], 'base64');
    data.writeBigUInt64LE(1_000_000_000n, 105);
    rpc.extra = [{ ...keyed(JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID, raw), data }];
    rpc.calls = [];
    const repo = new MemoryMevRepository();
    // The fixture's own copy is filtered out: replace it by the edited one.
    const accounts = (rpc as unknown as { accounts: RpcKeyedAccount[] }).accounts;
    accounts.splice(
      accounts.findIndex((a) => a.pubkey === raw.pubkey),
      1,
    );
    await scanner(rpc, repo).scanOnce();
    const pfda = () => [...repo.rows.values()].find((r) => r.pfda === raw.pubkey);
    expect(pfda()).toMatchObject({ pfTotalClaimLamports: 1_000_000_000n, pfValidatorClaim: 'pending' });
    expect(rpc.calls.filter((c) => c.startsWith('multiple'))).toEqual(['multiple:2', 'multiple:1']);

    // A PF ClaimStatus (48 bytes: discriminator, payer, expires_at) at ["CLAIM_STATUS", vote, pfda].
    const vote = data.subarray(8, 40);
    const claim = Buffer.alloc(48);
    Buffer.from('16b7f99df75f9660', 'hex').copy(claim, 0);
    claim.writeBigUInt64LE(1_060n, 40);
    const address = claimStatusAddress(bytesToAddress(vote), raw.pubkey, JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID);
    rpc.extraAccounts.set(address, {
      lamports: 1_224_960,
      owner: JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
      data: claim,
    });
    await scanner(rpc, repo).scanOnce();
    expect(pfda()?.pfValidatorClaim).toBe('claimed');
  });

  it('does not read a settled epoch again; keeps reading the epoch in progress', async () => {
    const rpc = new FixtureRpc(1051);
    const repo = new MemoryMevRepository();
    await scanner(rpc, repo).scanOnce();
    rpc.calls = [];
    const again = await scanner(rpc, repo).scanOnce();
    expect(again.skipped).toEqual([1050]);
    expect(again.scanned.map((s) => s.epoch)).toEqual([1051]);
    expect(rpc.calls).toEqual(['getEpochInfo', 'rent:168', 'gpa:4R3g', 'gpa:4R3g', 'gpa:Prio', 'gpa:Prio']);
  });

  it('estimates an unclaimed commission node, then replaces it with the claim; known claims are not re-read', async () => {
    const rpc = new FixtureRpc(1051);
    rpc.claimsVisible = false;
    const repo = new MemoryMevRepository();
    await scanner(rpc, repo, 1).scanOnce(); // 1051 only: nothing to claim yet
    await scanner(rpc, repo, 2).scanOnce();
    expect(byTda(repo, TDA_700)).toMatchObject({
      validatorClaim: 'pending',
      validatorShareLamports: 7_469_029_824n,
      validatorShareEstimated: true,
    });
    // At 10,000 bps the estimate (all tips) is an upper bound until the claim shows the real figure.
    expect(byTda(repo, TDA_10000)).toMatchObject({
      validatorClaim: 'pending',
      validatorShareLamports: 108_786_690_982n,
      validatorShareEstimated: true,
    });

    rpc.claimsVisible = true;
    rpc.calls = [];
    await scanner(rpc, repo).scanOnce();
    expect(rpc.calls).toContain('multiple:2');
    expect(byTda(repo, TDA_10000)).toMatchObject({
      validatorClaim: 'claimed',
      validatorShareLamports: 105_425_182_231n,
    });

    // Settled now: the next scan reads neither the epoch nor its claims, and the rows keep their claims.
    rpc.calls = [];
    await scanner(rpc, repo).scanOnce();
    expect(rpc.calls.some((c) => c.startsWith('multiple'))).toBe(false);
    expect(byTda(repo, TDA_700)).toMatchObject({ validatorClaim: 'claimed', validatorClaimedSlot: 454_050_628 });
  });

  it('marks a commission node expired once its TDA expired unclaimed', async () => {
    const repo = new MemoryMevRepository();
    const rpc = new FixtureRpc(1051);
    rpc.claimsVisible = false;
    await scanner(rpc, repo).scanOnce();
    expect(await repo.expirePending(1_060)).toBe(0);
    expect(await repo.expirePending(1_061)).toBe(2);
    expect(byTda(repo, TDA_700)?.validatorClaim).toBe('expired');
  });

  it('counts and skips accounts that match the filters but do not decode (layout drift)', async () => {
    const rpc = new FixtureRpc(1051);
    const real = keyed(JITO_TIP_DISTRIBUTION_PROGRAM_ID, fixture.tdas1051[0]);
    const broken = Buffer.from(real.data);
    broken[0] ^= 0xff; // wrong discriminator, same size, tag and epoch
    rpc.extra = [{ ...real, pubkey: 'Broken1111111111111111111111111111111111111', data: broken }];
    const result = await scanner(rpc, new MemoryMevRepository(), 1).scanOnce();
    expect(result.scanned).toEqual([{ epoch: 1051, tdas: 1, pfdas: 0, claimsRead: 0, undecoded: 1 }]);
  });
});
