import { findVoteAuthPda, instructionNameOf } from '@epoch/epoch-sdk';

import { advance, key, pool, position, PROGRAM_ID, SOL, voteState } from './__fixtures__/accounts';
import {
  accountLabels,
  type OperatorContext,
  planRelease,
  planUpdateCommission,
  planUpdateIdentity,
  planWithdrawBond,
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
});
