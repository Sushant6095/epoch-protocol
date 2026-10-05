import {
  findDbcPoolPda,
  findEscrowPda,
  findPartnerTreasuryPda,
  findPoolPda,
  findVoteAuthPda,
  instructionNameOf,
  METEORA,
  TOKEN_PROGRAM_ID,
} from '@epoch/epoch-sdk';

import {
  advance,
  dbcConfigData,
  dbcPoolData,
  key,
  mintData,
  pool,
  position,
  PROGRAM_ID,
  SOL,
  voteState,
} from './__fixtures__/accounts';
import {
  accountLabels,
  type OperatorContext,
  planOnboard,
  planRegisterRevenueToken,
  planRelease,
  planSetCollectors,
  planUpdateCommission,
  planUpdateIdentity,
  planWithdrawBond,
  type RegisterContext,
} from './Plans';

const VOTE = key(20);
const OPERATOR = key(22);
const programWithdraws = voteState({ authorizedWithdrawer: findVoteAuthPda(PROGRAM_ID, VOTE)[0].toBase58() });

const ctx = (overrides: Partial<OperatorContext> = {}): OperatorContext => ({
  programId: PROGRAM_ID,
  operator: OPERATOR,
  vote: VOTE,
  position: position(),
  advance: null,
  pool: pool(),
  voteState: programWithdraws,
  ...overrides,
});
const names = (plan: { instructions: { data: Buffer }[] }) => plan.instructions.map((ix) => instructionNameOf(ix.data));
const withAdvance = { position: position({ openAdvance: key(80) }), advance: advance() };

describe('operator plans', () => {
  it('update-commission: one update_commission with kind and bps, checked against the program covenants', () => {
    const plan = planUpdateCommission(ctx(), 'block', 750);
    expect(names(plan)).toEqual(['update_commission']);
    expect(plan.problems).toEqual([]);
    const data = plan.instructions[0].data;
    expect([data[8], data.readUInt16LE(9)]).toEqual([1, 750]); // kind u8 (1 = block revenue), commission_bps u16

    expect(planUpdateCommission(ctx(), 'inflation', 400).problems).toEqual([
      expect.stringContaining('CommissionTooLow'),
    ]);
    expect(planUpdateCommission(ctx(withAdvance), 'block', 900).problems).toEqual([
      expect.stringContaining('CommissionChangeBlocked'),
    ]);
    expect(planUpdateCommission(ctx(withAdvance), 'block', 1_200).problems).toEqual([]);
  });

  it('update-identity: update_identity then set_collectors, signed by the new identity', () => {
    const plan = planUpdateIdentity(ctx(), key(77), true);
    expect(names(plan)).toEqual(['update_identity', 'set_collectors']);
    // update_identity accounts: operator, new_identity (signer), position, vote, vote_auth, vote program.
    expect(plan.instructions[0].keys[1]).toEqual({ pubkey: key(77), isSigner: true, isWritable: false });
    // set_collectors is cranked by the operator.
    expect(plan.instructions[1].keys[0].pubkey.equals(OPERATOR)).toBe(true);
    expect(plan.problems).toEqual([]);

    const bare = planUpdateIdentity(ctx(), key(77), false);
    expect(names(bare)).toEqual(['update_identity']);
    expect(bare.warnings[0]).toContain('set_collectors');
    expect(planUpdateIdentity(ctx(withAdvance), key(77), true).problems).toEqual([
      expect.stringContaining('AdvanceOpen'),
    ]);
  });

  it('withdraw-bond: blocked while an advance is open and above the bond', () => {
    expect(planWithdrawBond(ctx(), SOL).problems).toEqual([]);
    expect(names(planWithdrawBond(ctx(), SOL))).toEqual(['withdraw_bond']);
    expect(planWithdrawBond(ctx(), 3n * SOL).problems).toEqual([expect.stringContaining('cannot withdraw more')]);
    expect(planWithdrawBond(ctx(withAdvance), SOL).problems).toEqual([expect.stringContaining('BondLocked')]);
  });

  it('release: hands the authority back to the original withdrawer and passes the identity writable', () => {
    const plan = planRelease(ctx());
    expect(names(plan)).toEqual(['release_validator']);
    const keys = plan.instructions[0].keys;
    // Accounts: operator, pool, vault, position, vote, vote_auth, escrow, new_withdrawer, identity, clock, vote program, system.
    expect(keys[7].pubkey.equals(key(24))).toBe(true);
    expect(keys[8]).toEqual({ pubkey: key(21), isSigner: false, isWritable: true });
    expect(plan.problems).toEqual([]);

    const elsewhere = planRelease(ctx(), key(5));
    expect(elsewhere.instructions[0].keys[7].pubkey.equals(key(5))).toBe(true);
    expect(elsewhere.warnings[0]).toContain('not the original withdrawer');
    expect(planRelease(ctx(withAdvance)).problems).toEqual([expect.stringContaining('AdvanceOpen')]);
    expect(planRelease(ctx({ position: position({ status: 'late' }) })).problems).toEqual([
      expect.stringContaining('PositionNotActive'),
    ]);
  });

  it('refuses another operator’s position and a vote account the program no longer controls', () => {
    expect(planWithdrawBond(ctx({ operator: key(99) }), SOL).problems).toEqual([
      expect.stringContaining('NotOperator'),
    ]);
    expect(
      planWithdrawBond(ctx({ voteState: voteState({ authorizedWithdrawer: key(1).toBase58() }) }), SOL).problems,
    ).toEqual([expect.stringContaining('ProgramNotWithdrawAuthority')]);
  });

  it('labels the accounts, the operator first', () => {
    const labels = accountLabels({
      programId: PROGRAM_ID,
      operator: OPERATOR,
      vote: VOTE,
      position: position({ identity: OPERATOR }),
    });
    expect(labels.get(OPERATOR.toBase58())).toBe('operator (you)');
    expect(labels.get(VOTE.toBase58())).toBe('vote account');
    expect(labels.get(findVoteAuthPda(PROGRAM_ID, VOTE)[0].toBase58())).toBe('vote authority (program PDA)');
  });

  it('set-collectors: both collectors to the escrow; needs a v4 vote account the program controls', () => {
    const plan = planSetCollectors(ctx());
    expect(names(plan)).toEqual(['set_collectors']);
    expect(plan.problems).toEqual([]);
    expect(planSetCollectors(ctx({ voteState: { ...programWithdraws, version: 'v3' } })).problems).toEqual([
      expect.stringContaining('vote state v4'),
    ]);
    const escrow = findEscrowPda(PROGRAM_ID, VOTE)[0].toBase58();
    const done = { ...programWithdraws, inflationRewardsCollector: escrow, blockRevenueCollector: escrow };
    expect(planSetCollectors(ctx({ voteState: done })).warnings).toEqual([
      'both collectors already point at the escrow',
    ]);
  });

  describe('onboard-validator', () => {
    const withdrawer = key(24);
    const onboardCtx = (overrides = {}) => ({
      programId: PROGRAM_ID,
      operator: OPERATOR,
      vote: VOTE,
      pool: pool(),
      voteState: voteState({ authorizedWithdrawer: withdrawer.toBase58() }),
      onboarded: false,
      ...overrides,
    });
    const input = { payout: key(23), withdrawer, bondLamports: 2n * SOL, setCollectors: true };

    it('onboard_validator, set_collectors and post_bond; the withdrawer co-signs', () => {
      const plan = planOnboard(onboardCtx(), input);
      expect(names(plan)).toEqual(['onboard_validator', 'set_collectors', 'post_bond']);
      expect(plan.instructions[0].keys[1]).toEqual({ pubkey: withdrawer, isSigner: true, isWritable: false });
      expect(plan.problems).toEqual([]);
      expect(plan.summary.find(([l]) => l === 'withdraw authority then')?.[1]).toContain(
        findVoteAuthPda(PROGRAM_ID, VOTE)[0].toBase58(),
      );
      expect(names(planOnboard(onboardCtx(), { ...input, bondLamports: 0n, setCollectors: false }))).toEqual([
        'onboard_validator',
      ]);
    });

    it('refuses what the program would', () => {
      expect(planOnboard(onboardCtx({ onboarded: true }), input).problems).toEqual([
        expect.stringContaining('already has a position'),
      ]);
      expect(planOnboard(onboardCtx({ pool: { ...pool(), paused: true } }), input).problems).toEqual([
        'the pool is paused (Paused)',
      ]);
      expect(planOnboard(onboardCtx(), { ...input, withdrawer: key(99) }).problems).toEqual([
        expect.stringContaining('NotWithdrawAuthority'),
      ]);
      expect(
        planOnboard(
          onboardCtx({
            voteState: voteState({ authorizedWithdrawer: withdrawer.toBase58(), inflationRewardsCommissionBps: 100 }),
          }),
          input,
        ).problems,
      ).toEqual([expect.stringContaining('CommissionTooLow')]);
      expect(planOnboard(onboardCtx({ voteState: null }), input).problems).toEqual([
        expect.stringContaining('NotAVoteAccount'),
      ]);
    });
  });

  describe('register-revenue-token', () => {
    const mint = key(90);
    const config = key(91);
    const [treasury] = findPartnerTreasuryPda(PROGRAM_ID, findPoolPda(PROGRAM_ID)[0]);
    const dbcPool = findDbcPoolPda(config, mint);
    const registerCtx = (overrides: Partial<RegisterContext> = {}): RegisterContext => ({
      ...ctx(),
      mint: { owner: TOKEN_PROGRAM_ID, data: mintData() },
      dbcConfig: { owner: METEORA.DBC_PROGRAM_ID, data: dbcConfigData(treasury) },
      dbcPool: { address: dbcPool, owner: METEORA.DBC_PROGRAM_ID, data: dbcPoolData(config, mint) },
      revenueTokenExists: false,
      ...overrides,
    });
    const input = { mint, dbcConfig: config, shareBps: 500, termEpochs: 100 };

    it('register_revenue_token through the SDK builder, with the config checks of the program', () => {
      const plan = planRegisterRevenueToken(registerCtx(), input);
      expect(names(plan)).toEqual(['register_revenue_token']);
      expect(plan.problems).toEqual([]);
      const keys = plan.instructions[0].keys.map((k) => k.pubkey.toBase58());
      expect(keys).toEqual(
        expect.arrayContaining([mint.toBase58(), config.toBase58(), dbcPool.toBase58(), treasury.toBase58()]),
      );
      expect(plan.summary.find(([l]) => l === 'venue fee floor')?.[1]).toBe('100 bps (max_impact_bps ≤ 200)');
      const data = plan.instructions[0].data;
      expect([data.readUInt16LE(8), data.readUInt16LE(10)]).toEqual([500, 100]);
    });

    it('names the program error a bad launch would hit', () => {
      const problems = (overrides: Partial<RegisterContext>) =>
        planRegisterRevenueToken(registerCtx(overrides), input).problems;
      expect(
        problems({
          dbcConfig: { owner: METEORA.DBC_PROGRAM_ID, data: dbcConfigData(treasury, { leftoverReceiver: key(1) }) },
        }),
      ).toEqual([expect.stringContaining('NotTreasuryLeftoverReceiver')]);
      expect(
        problems({
          dbcConfig: { owner: METEORA.DBC_PROGRAM_ID, data: dbcConfigData(treasury, { creatorUnlocked: 20 }) },
        }),
      ).toEqual([expect.stringContaining('LiquidityNotLocked')]);
      expect(
        problems({
          dbcConfig: { owner: METEORA.DBC_PROGRAM_ID, data: dbcConfigData(treasury, { feeClaimer: key(1) }) },
        }),
      ).toEqual([expect.stringContaining('InvalidDbcConfig')]);
      expect(problems({ mint: { owner: TOKEN_PROGRAM_ID, data: mintData({ freezeAuthority: true }) } })).toEqual([
        expect.stringContaining('InvalidRevenueMint'),
      ]);
      expect(problems({ mint: { owner: key(5), data: mintData() } })).toEqual([
        expect.stringContaining('Token-2022 is refused'),
      ]);
      expect(problems({ dbcPool: null })).toEqual([expect.stringContaining('InvalidDbcPool')]);
      expect(
        problems({ dbcPool: { address: dbcPool, owner: METEORA.DBC_PROGRAM_ID, data: dbcPoolData(key(3), mint) } }),
      ).toEqual([expect.stringContaining('InvalidDbcPool')]);
      expect(problems({ revenueTokenExists: true })).toEqual([expect.stringContaining('RevenueTokenExists')]);
      expect(problems({ pool: { ...pool(), paused: true } })).toEqual(['the pool is paused (Paused)']);
      expect(problems({ operator: key(99) })).toEqual([expect.stringContaining('NotOperator')]);
    });
  });
});
