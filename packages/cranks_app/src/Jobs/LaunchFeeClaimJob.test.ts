import { findDammPositionNftAccount, instructionNameOf } from '@epoch/epoch-sdk';
import {
  type ClaimableItem,
  type ClaimKind,
  type DammPositionClaim,
  type LaunchClaimsState,
  type MigrationReadiness,
} from '@epoch/meteora';
import { Keypair, type PublicKey, type TransactionInstruction } from '@solana/web3.js';

import { type ClaimSimulation, type LaunchClaimChain } from '../Launch/LaunchClaimChain';
import { type ClaimLaunch, parseClaimLaunches } from '../Launch/LaunchRegistryFile';
import { TREASURY_CLAIM_COMPUTE_UNITS, treasuryClaimRoute } from '../Launch/TreasuryClaims';
import { LaunchFeeClaimJob, type LaunchFeeClaimOptions } from './LaunchFeeClaimJob';

const SOL = 1_000_000_000n;
const treasury = Keypair.generate();
const creator = Keypair.generate();
const stranger = Keypair.generate();
const LAUNCH: ClaimLaunch = {
  mint: Keypair.generate().publicKey.toBase58(),
  symbol: 'rREH',
  cluster: 'devnet',
  dbcPool: Keypair.generate().publicKey.toBase58(),
  dbcConfig: null,
  dammPool: null,
};
const DAMM = Keypair.generate().publicKey.toBase58();
const POSITION = Keypair.generate().publicKey.toBase58();
const NFT_MINT = Keypair.generate().publicKey;
/** The Epoch program instruction each treasury claim kind becomes. */
const PROGRAM_KINDS: Record<string, ClaimKind> = {
  claim_partner_trading_fee: 'partnerTradingFee',
  claim_partner_surplus: 'partnerSurplus',
  claim_partner_migration_fee: 'partnerMigrationFee',
  burn_leftover: 'leftover',
  claim_treasury_lp_fee: 'lpFee',
};

const item = (
  kind: ClaimKind,
  signer: string | null,
  lamports: bigint,
  tokens = 0n,
  extra: Partial<ClaimableItem> = {},
): ClaimableItem => ({
  kind,
  signer,
  receiver: signer ?? treasury.publicKey.toBase58(),
  lamports,
  tokens,
  available: lamports > 0n || tokens > 0n,
  withdrawn: false,
  reason: null,
  ...extra,
});

/** A graduated launch: trading fees, the creator's 70%, a surplus, the leftover and LP fees, all claimable. */
function graduatedState(): LaunchClaimsState {
  const partner = treasury.publicKey.toBase58();
  const pool = creator.publicKey.toBase58();
  return {
    dbcPool: LAUNCH.dbcPool,
    config: 'config',
    partner,
    creator: pool,
    leftoverReceiver: partner,
    baseDecimals: 6,
    curveComplete: true,
    migrated: true,
    dammPool: DAMM,
    tradingFees: {
      partner: { totalLamports: 7_034_346n, claimedLamports: 0n, unclaimedLamports: 7_034_346n },
      creator: { totalLamports: 0n, claimedLamports: 0n, unclaimedLamports: 0n },
    },
    migrationFee: {
      totalLamports: 525_000_270n,
      partner: { lamports: 0n, withdrawn: false },
      creator: { lamports: 525_000_270n, withdrawn: false },
    },
    surplus: {
      totalLamports: 10n,
      partner: { lamports: 8n, withdrawn: false },
      creator: { lamports: 0n, withdrawn: false },
      protocol: { lamports: 2n, withdrawn: false },
    },
    leftover: { tokens: 578_372_000_000n, withdrawn: false },
    positions: [],
    items: [
      item('partnerTradingFee', partner, 7_034_346n),
      item('creatorTradingFee', pool, 0n, 0n, { available: false, reason: 'nothing to claim' }),
      item('partnerMigrationFee', partner, 0n, 0n, { available: false, reason: 'nothing to claim' }),
      item('creatorMigrationFee', pool, 525_000_270n),
      item('partnerSurplus', partner, 8n),
      item('creatorSurplus', pool, 0n, 0n, { available: false, reason: 'nothing to claim' }),
      item('leftover', null, 0n, 578_372_000_000n),
      item('lpFee', partner, 2_283_453n, 0n, { position: POSITION }),
    ],
  };
}

/** An in-memory chain: a sent claim empties (accruing) or flags (one-shot) the item, as the DBC program does. */
class FakeClaimChain implements LaunchClaimChain {
  state: LaunchClaimsState | null = graduatedState();
  sent: { kind: ClaimKind; signer: string }[] = [];
  simulated: { kind: ClaimKind; signer: string }[] = [];
  failKinds = new Set<ClaimKind>();
  readError: Error | null = null;

  async readClaims(): Promise<LaunchClaimsState | null> {
    if (this.readError) throw this.readError;
    return this.state ? structuredClone(this.state) : null;
  }

  // Graduations are LaunchMigrationJob's (tested on their own).
  async migrationReadiness(): Promise<MigrationReadiness> {
    return { ready: false, reason: 'ALREADY_MIGRATED' };
  }

  async sendMigration(): Promise<{ signature: string; dammPool: string }> {
    throw new Error('not used here');
  }

  async simulateMigration(): Promise<ClaimSimulation> {
    throw new Error('not used here');
  }

  async sendClaim(
    _launch: ClaimLaunch,
    claim: ClaimableItem,
    dammPool: string | null,
    signer: Keypair,
  ): Promise<string> {
    if (claim.kind === 'lpFee') expect(dammPool).toBe(DAMM);
    if (claim.signer) expect(signer.publicKey.toBase58()).toBe(claim.signer);
    if (this.failKinds.has(claim.kind)) throw new Error('custom program error: 0x1770');
    this.sent.push({ kind: claim.kind, signer: signer.publicKey.toBase58() });
    this.settle(claim.kind, claim.position);
    return `sig-${claim.kind}`;
  }

  /** What the DBC/DAMM v2 programs do once a claim lands: an accruing item empties, a one-shot one is flagged. */
  private settle(kind: ClaimKind, position: string | undefined): void {
    const live = this.state!.items.find((candidate) => candidate.kind === kind && candidate.position === position)!;
    const oneShot = [
      'partnerMigrationFee',
      'creatorMigrationFee',
      'partnerSurplus',
      'creatorSurplus',
      'leftover',
    ].includes(kind);
    Object.assign(live, {
      lamports: 0n,
      tokens: 0n,
      available: false,
      withdrawn: oneShot,
      reason: oneShot ? 'already withdrawn' : 'nothing to claim',
    });
  }

  programSent: { name: string; cranker: string; computeUnits: number; ix: TransactionInstruction }[] = [];
  programSimulated: { name: string; cranker: string }[] = [];

  async sendProgramClaim(
    instructions: TransactionInstruction[],
    cranker: Keypair,
    computeUnits: number,
  ): Promise<string> {
    const [ix] = instructions;
    const name = instructionNameOf(ix.data)!;
    const kind = PROGRAM_KINDS[name];
    if (this.failKinds.has(kind)) throw new Error('custom program error: 0x17c5');
    this.programSent.push({ name, cranker: cranker.publicKey.toBase58(), computeUnits, ix });
    // The LP claim names its position in slot 7.
    this.settle(kind, kind === 'lpFee' ? ix.keys[7].pubkey.toBase58() : undefined);
    return `sig-${name}`;
  }

  async simulateProgramClaim(instructions: TransactionInstruction[], cranker: PublicKey): Promise<ClaimSimulation> {
    this.programSimulated.push({ name: instructionNameOf(instructions[0].data)!, cranker: cranker.toBase58() });
    return { ok: true, error: null };
  }

  /** The treasury's token account balance, by mint (a leftover someone else withdrew to it). */
  treasuryTokens = new Map<string, bigint>();

  async treasuryTokenBalance(mint: PublicKey): Promise<bigint> {
    return this.treasuryTokens.get(mint.toBase58()) ?? 0n;
  }

  async simulateClaim(
    _launch: ClaimLaunch,
    claim: ClaimableItem,
    _dammPool: string | null,
    signer: PublicKey,
  ): Promise<ClaimSimulation> {
    this.simulated.push({ kind: claim.kind, signer: signer.toBase58() });
    return { ok: true, error: null };
  }
}

const options = (chain: FakeClaimChain, overrides: Partial<LaunchFeeClaimOptions> = {}): LaunchFeeClaimOptions => ({
  launches: () => [LAUNCH],
  chain,
  signers: new Map([[treasury.publicKey.toBase58(), treasury]]),
  payer: treasury,
  kinds: new Set<ClaimKind>([
    'partnerTradingFee',
    'partnerSurplus',
    'partnerMigrationFee',
    'lpFee',
    'creatorMigrationFee',
    'creatorSurplus',
    'creatorTradingFee',
  ]),
  minLamports: SOL / 1_000n,
  dryRun: false,
  ...overrides,
});

describe('LaunchFeeClaimJob', () => {
  it("claims the treasury's fees (trading, surplus, LP) and simulates the creator's 70% without its key", async () => {
    const chain = new FakeClaimChain();
    const job = new LaunchFeeClaimJob(options(chain));
    await expect(job.run()).resolves.toBe('done');
    expect(chain.sent).toEqual([
      { kind: 'partnerTradingFee', signer: treasury.publicKey.toBase58() },
      { kind: 'partnerSurplus', signer: treasury.publicKey.toBase58() },
      { kind: 'lpFee', signer: treasury.publicKey.toBase58() },
    ]);
    expect(chain.simulated).toEqual([{ kind: 'creatorMigrationFee', signer: creator.publicKey.toBase58() }]);
    expect(job.last.simulated).toEqual([
      { symbol: 'rREH', kind: 'creatorMigrationFee', ok: true, reason: 'no key for the signer' },
    ]);
    expect(job.last.claimed.map((c) => [c.kind, c.signature, c.lamports])).toEqual([
      ['partnerTradingFee', 'sig-partnerTradingFee', 7_034_346n],
      ['partnerSurplus', 'sig-partnerSurplus', 8n],
      ['lpFee', 'sig-lpFee', 2_283_453n],
    ]);
  });

  it('is idempotent: a second run finds nothing left to send', async () => {
    const chain = new FakeClaimChain();
    const job = new LaunchFeeClaimJob(
      options(chain, {
        signers: new Map([
          [treasury.publicKey.toBase58(), treasury],
          [creator.publicKey.toBase58(), creator],
        ]),
      }),
    );
    await job.run();
    expect(chain.sent.map((s) => s.kind)).toEqual([
      'partnerTradingFee',
      'creatorMigrationFee',
      'partnerSurplus',
      'lpFee',
    ]);
    chain.sent = [];
    await expect(job.run()).resolves.toBe('done');
    expect(chain.sent).toEqual([]);
    expect(job.last).toEqual({ claimed: [], simulated: [], failed: [] });
  });

  it("claims the creator's migration fee with the creator's own key", async () => {
    const chain = new FakeClaimChain();
    await new LaunchFeeClaimJob(
      options(chain, { signers: new Map([[creator.publicKey.toBase58(), creator]]), payer: undefined }),
    ).run();
    expect(chain.sent).toEqual([{ kind: 'creatorMigrationFee', signer: creator.publicKey.toBase58() }]);
  });

  it('leaves accruing fees under the minimum to accumulate, but always takes one-shot withdrawals', async () => {
    const chain = new FakeClaimChain();
    await new LaunchFeeClaimJob(options(chain, { minLamports: SOL / 10n })).run();
    expect(chain.sent.map((s) => s.kind)).toEqual(['partnerSurplus']);
  });

  it('withdraws the leftover only when opted in, paid by the treasury', async () => {
    const chain = new FakeClaimChain();
    await new LaunchFeeClaimJob(options(chain)).run();
    expect(chain.sent.some((s) => s.kind === 'leftover')).toBe(false);
    chain.sent = [];
    chain.state = graduatedState();
    await new LaunchFeeClaimJob(options(chain, { kinds: new Set<ClaimKind>(['leftover']) })).run();
    expect(chain.sent).toEqual([{ kind: 'leftover', signer: treasury.publicKey.toBase58() }]);
  });

  it('only simulates under dry run, even with keys', async () => {
    const chain = new FakeClaimChain();
    const job = new LaunchFeeClaimJob(options(chain, { dryRun: true }));
    await expect(job.run()).resolves.toBe('done');
    expect(chain.sent).toEqual([]);
    expect(chain.simulated.map((s) => s.kind)).toEqual([
      'partnerTradingFee',
      'creatorMigrationFee',
      'partnerSurplus',
      'lpFee',
    ]);
    expect(job.last.simulated.every((s) => s.reason === 'LAUNCH_CLAIMS_DRY_RUN')).toBe(true);
  });

  it('never signs for a wallet whose key it does not hold', async () => {
    const chain = new FakeClaimChain();
    chain.state!.items = chain.state!.items.map((claim) =>
      claim.kind === 'lpFee'
        ? { ...claim, signer: stranger.publicKey.toBase58(), receiver: stranger.publicKey.toBase58() }
        : claim,
    );
    await new LaunchFeeClaimJob(options(chain)).run();
    expect(chain.sent.some((s) => s.kind === 'lpFee')).toBe(false);
    expect(chain.simulated).toContainEqual({ kind: 'lpFee', signer: stranger.publicKey.toBase58() });
  });

  it('keeps going after a failed claim and asks for a retry', async () => {
    const chain = new FakeClaimChain();
    chain.failKinds.add('partnerTradingFee');
    const job = new LaunchFeeClaimJob(options(chain));
    await expect(job.run()).resolves.toBe('retry');
    expect(chain.sent.map((s) => s.kind)).toEqual(['partnerSurplus', 'lpFee']);
    expect(job.last.failed).toEqual([
      { symbol: 'rREH', kind: 'partnerTradingFee', error: 'Error: custom program error: 0x1770' },
    ]);
  });

  it('retries a launch it could not read and skips one without a pool', async () => {
    const chain = new FakeClaimChain();
    chain.readError = new Error('429');
    await expect(new LaunchFeeClaimJob(options(chain)).run()).resolves.toBe('retry');
    chain.readError = null;
    chain.state = null;
    await expect(new LaunchFeeClaimJob(options(chain)).run()).resolves.toBe('done');
    expect(chain.sent).toEqual([]);
  });
});

describe('parseClaimLaunches', () => {
  it('keeps launches with a curve pool and their pools', () => {
    const text = JSON.stringify([
      {
        mint: LAUNCH.mint,
        symbol: 'rREH',
        cluster: 'devnet',
        dbcPool: LAUNCH.dbcPool,
        dbcConfig: null,
        dammPool: DAMM,
        shareBps: 500,
      },
      { mint: Keypair.generate().publicKey.toBase58(), symbol: 'rSOON', cluster: 'mainnet', dbcPool: null },
    ]);
    expect(parseClaimLaunches(text)).toEqual([
      {
        mint: LAUNCH.mint,
        symbol: 'rREH',
        cluster: 'devnet',
        dbcPool: LAUNCH.dbcPool,
        dbcConfig: null,
        dammPool: DAMM,
      },
    ]);
    expect(() => parseClaimLaunches('[{"mint": 1}]')).toThrow();
  });
});

describe('LaunchFeeClaimJob through the Epoch program', () => {
  const programId = Keypair.generate().publicKey;
  const crank = Keypair.generate();
  const route = treasuryClaimRoute(programId, crank);
  const pda = route.treasury.toBase58();

  /** The same graduated launch, but Epoch's fee claimer and leftover receiver are the treasury PDA. */
  function pdaState(): LaunchClaimsState {
    const state = graduatedState();
    const position: DammPositionClaim = {
      position: POSITION,
      nftMint: NFT_MINT.toBase58(),
      owner: pda,
      role: 'partner',
      permanentLockedLiquidity: '1000',
      unlockedLiquidity: '0',
      vestedLiquidity: '0',
      lockedPct: 100,
      unclaimedLamports: 2_283_453n,
      unclaimedTokens: 0n,
      claimedLamports: 0n,
      claimedTokens: 0n,
    };
    return {
      ...state,
      config: Keypair.generate().publicKey.toBase58(),
      partner: pda,
      leftoverReceiver: pda,
      positions: [position],
      items: state.items.map((claim) => {
        const mine = claim.signer === treasury.publicKey.toBase58() || claim.kind === 'leftover';
        return mine ? { ...claim, signer: claim.kind === 'leftover' ? null : pda, receiver: pda } : claim;
      }),
    };
  }

  const allKinds = new Set<ClaimKind>([
    'partnerTradingFee',
    'partnerSurplus',
    'partnerMigrationFee',
    'lpFee',
    'creatorMigrationFee',
    'creatorSurplus',
    'creatorTradingFee',
    'leftover',
  ]);

  it("sends the treasury's claims as program instructions paid by the crank; the creator's stay its own", async () => {
    const chain = new FakeClaimChain();
    chain.state = pdaState();
    const job = new LaunchFeeClaimJob(
      options(chain, { signers: new Map(), payer: undefined, kinds: allKinds, program: route }),
    );
    expect(job.treasury?.toBase58()).toBe(pda);
    await expect(job.run()).resolves.toBe('done');
    expect(chain.sent).toEqual([]);
    expect(chain.programSent.map((s) => [s.name, s.cranker, s.computeUnits])).toEqual([
      ['claim_partner_trading_fee', crank.publicKey.toBase58(), TREASURY_CLAIM_COMPUTE_UNITS],
      ['claim_partner_surplus', crank.publicKey.toBase58(), TREASURY_CLAIM_COMPUTE_UNITS],
      ['burn_leftover', crank.publicKey.toBase58(), TREASURY_CLAIM_COMPUTE_UNITS],
      ['claim_treasury_lp_fee', crank.publicKey.toBase58(), TREASURY_CLAIM_COMPUTE_UNITS],
    ]);
    // Every one is the program's, signed by the crank alone.
    for (const { ix } of chain.programSent) {
      expect(ix.programId.equals(programId)).toBe(true);
      expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([crank.publicKey.toBase58()]);
    }
    const lp = chain.programSent.find((s) => s.name === 'claim_treasury_lp_fee')!.ix;
    expect(lp.keys[8].pubkey.equals(findDammPositionNftAccount(NFT_MINT))).toBe(true);
    // The creator's 70% has no key here: simulated with the creator as signer, never through the program.
    expect(chain.simulated).toEqual([{ kind: 'creatorMigrationFee', signer: creator.publicKey.toBase58() }]);
    expect(job.last.claimed.map((c) => [c.kind, c.via])).toEqual([
      ['partnerTradingFee', 'program'],
      ['partnerSurplus', 'program'],
      ['leftover', 'program'],
      ['lpFee', 'program'],
    ]);
    // Idempotent: the next run finds nothing left.
    chain.programSent = [];
    await job.run();
    expect(chain.programSent).toEqual([]);
  });

  it('simulates the program instructions under dry run', async () => {
    const chain = new FakeClaimChain();
    chain.state = pdaState();
    const job = new LaunchFeeClaimJob(
      options(chain, { signers: new Map(), payer: undefined, kinds: allKinds, program: route, dryRun: true }),
    );
    await job.run();
    expect(chain.programSent).toEqual([]);
    expect(chain.programSimulated.map((s) => s.name)).toEqual([
      'claim_partner_trading_fee',
      'claim_partner_surplus',
      'burn_leftover',
      'claim_treasury_lp_fee',
    ]);
    expect(job.last.simulated.filter((s) => s.via === 'program')).toHaveLength(4);
  });

  it('leaves claims of another fee claimer on the signer path', async () => {
    const chain = new FakeClaimChain();
    // The fee claimer is a plain wallet (a rehearsal): its key signs, the program is not involved.
    const job = new LaunchFeeClaimJob(options(chain, { program: route }));
    await job.run();
    expect(chain.programSent).toEqual([]);
    expect(chain.sent.map((s) => s.kind)).toEqual(['partnerTradingFee', 'partnerSurplus', 'lpFee']);
  });

  it('reports an LP claim whose position was not read and keeps going', async () => {
    const chain = new FakeClaimChain();
    chain.state = { ...pdaState(), positions: [] };
    const job = new LaunchFeeClaimJob(
      options(chain, { signers: new Map(), payer: undefined, kinds: allKinds, program: route }),
    );
    await expect(job.run()).resolves.toBe('retry');
    expect(job.last.failed).toEqual([
      { symbol: 'rREH', kind: 'lpFee', error: `Error: LP position ${POSITION} was not read` },
    ]);
    expect(chain.programSent.map((s) => s.name)).toEqual([
      'claim_partner_trading_fee',
      'claim_partner_surplus',
      'burn_leftover',
    ]);
  });

  it('burns a leftover someone else withdrew to the treasury, once', async () => {
    const chain = new FakeClaimChain();
    const state = pdaState();
    chain.state = {
      ...state,
      leftover: { tokens: 0n, withdrawn: true },
      items: state.items.map((claim) =>
        claim.kind === 'leftover'
          ? { ...claim, tokens: 0n, available: false, withdrawn: true, reason: 'already withdrawn' }
          : claim,
      ),
    };
    chain.treasuryTokens.set(LAUNCH.mint, 578_372_000_000n);
    const job = new LaunchFeeClaimJob(
      options(chain, { signers: new Map(), payer: undefined, kinds: allKinds, program: route }),
    );
    await job.run();
    expect(chain.programSent.map((s) => s.name)).toEqual([
      'claim_partner_trading_fee',
      'claim_partner_surplus',
      'claim_treasury_lp_fee',
      'burn_leftover',
    ]);
    expect(job.last.claimed.at(-1)).toMatchObject({ kind: 'leftover', tokens: 578_372_000_000n, via: 'program' });
    // Burned: the account is empty, so the next run sends nothing.
    chain.treasuryTokens.set(LAUNCH.mint, 0n);
    chain.programSent = [];
    await job.run();
    expect(chain.programSent).toEqual([]);
  });

  it('leaves a withdrawn leftover alone without the leftover kind or another receiver', async () => {
    const chain = new FakeClaimChain();
    chain.state = { ...pdaState(), leftover: { tokens: 0n, withdrawn: true } };
    chain.state.items = chain.state.items.filter((claim) => claim.kind !== 'leftover');
    chain.treasuryTokens.set(LAUNCH.mint, 5n);
    const kinds = new Set<ClaimKind>(['partnerTradingFee']);
    await new LaunchFeeClaimJob(options(chain, { signers: new Map(), payer: undefined, kinds, program: route })).run();
    expect(chain.programSent.map((s) => s.name)).toEqual(['claim_partner_trading_fee']);
    chain.programSent = [];
    chain.state = {
      ...pdaState(),
      leftover: { tokens: 0n, withdrawn: true },
      leftoverReceiver: creator.publicKey.toBase58(),
    };
    chain.state.items = [];
    await new LaunchFeeClaimJob(
      options(chain, { signers: new Map(), payer: undefined, kinds: allKinds, program: route }),
    ).run();
    expect(chain.programSent).toEqual([]);
  });

  it('retries a failed program claim on the next run', async () => {
    const chain = new FakeClaimChain();
    chain.state = pdaState();
    chain.failKinds.add('partnerSurplus');
    const job = new LaunchFeeClaimJob(
      options(chain, { signers: new Map(), payer: undefined, kinds: allKinds, program: route }),
    );
    await expect(job.run()).resolves.toBe('retry');
    expect(job.last.failed).toEqual([
      { symbol: 'rREH', kind: 'partnerSurplus', error: 'Error: custom program error: 0x17c5' },
    ]);
  });
});
