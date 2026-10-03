import {
  type AdvanceAccount,
  COMMISSION_KIND,
  findEscrowPda,
  findFeeIndexPda,
  findPoolPda,
  findPositionPda,
  findVaultPda,
  findVoteAuthPda,
  lamportsToSolString,
  type PoolAccount,
  releaseValidator,
  setCollectors,
  updateCommission,
  updateIdentity,
  type ValidatorPositionAccount,
  VOTE_PROGRAM_ID,
  withdrawBond,
} from '@epoch/epoch-sdk';
import { type VoteState } from '@epoch/solana';
import { type PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, type TransactionInstruction } from '@solana/web3.js';

import { type CommissionKindName } from './Cli';

/** What the operator's command reads before building anything. */
export interface OperatorContext {
  programId: PublicKey;
  operator: PublicKey;
  vote: PublicKey;
  position: ValidatorPositionAccount;
  /** The open advance, when `position.openAdvance` is set. */
  advance: AdvanceAccount | null;
  pool: PoolAccount;
  /** The vote account on the program's cluster; null when it could not be read. */
  voteState: VoteState | null;
}

export interface Plan {
  title: string;
  /** Label → value rows printed before the instructions. */
  summary: [string, string][];
  instructions: TransactionInstruction[];
  /** Blocking: the program would reject the transaction. Nothing is simulated or sent. */
  problems: string[];
  warnings: string[];
}

/** Problems every operator command shares: the position must be the signer's and still onboarded. */
function common(ctx: OperatorContext): string[] {
  const problems: string[] = [];
  if (!ctx.position.operator.equals(ctx.operator)) {
    problems.push(
      `OPERATOR_KEYPAIR_PATH is ${ctx.operator.toBase58()}, but this position's operator is ` +
        `${ctx.position.operator.toBase58()} (NotOperator)`,
    );
  }
  if (ctx.position.status === 'released') problems.push('the position is released (PositionNotActive)');
  if (ctx.voteState) {
    const [voteAuth] = findVoteAuthPda(ctx.programId, ctx.vote);
    if (ctx.voteState.authorizedWithdrawer !== voteAuth.toBase58()) {
      problems.push(
        `the program's vote authority ${voteAuth.toBase58()} is not the vote account's withdraw authority ` +
          `(${ctx.voteState.authorizedWithdrawer}) (ProgramNotWithdrawAuthority)`,
      );
    }
  }
  return problems;
}

export function planUpdateCommission(ctx: OperatorContext, kind: CommissionKindName, bps: number): Plan {
  const problems = common(ctx);
  const warnings: string[] = [];
  const current =
    ctx.voteState === null
      ? null
      : kind === 'inflation'
        ? ctx.voteState.inflationRewardsCommissionBps
        : ctx.voteState.blockRevenueCommissionBps;
  if (bps > 10_000) problems.push('commission above 10,000 bps (BpsOutOfRange)');
  if (kind === 'inflation' && bps < ctx.pool.params.minCommissionBps) {
    problems.push(
      `inflation commission below the pool minimum of ${ctx.pool.params.minCommissionBps} bps (CommissionTooLow)`,
    );
  }
  if (ctx.position.openAdvance && current !== null && bps < current) {
    problems.push(
      `an advance is open: commission cannot go below its current ${current} bps (CommissionChangeBlocked)`,
    );
  }
  if (current === null) warnings.push('could not read the vote account: the current commission is unknown');
  if (ctx.voteState && ctx.voteState.version !== 'v4' && kind === 'block') {
    warnings.push('this vote account is not on vote state v4: a block revenue commission needs SIMD-0232/0123');
  }
  warnings.push('the vote program applies commission changes with a one-epoch delay (SIMD-0249)');
  return {
    title: `update_commission: ${kind} commission → ${bps} bps`,
    summary: [
      ['vote account', ctx.vote.toBase58()],
      ['kind', `${kind} (${COMMISSION_KIND[kind === 'inflation' ? 'inflationRewards' : 'blockRevenue']})`],
      ['current', current === null ? 'unknown' : `${current} bps`],
      ['new', `${bps} bps`],
    ],
    instructions: updateCommission({
      programId: ctx.programId,
      operator: ctx.operator,
      vote: ctx.vote,
      kind: kind === 'inflation' ? COMMISSION_KIND.inflationRewards : COMMISSION_KIND.blockRevenue,
      commissionBps: bps,
    }),
    problems,
    warnings,
  };
}

export function planUpdateIdentity(ctx: OperatorContext, newIdentity: PublicKey, withCollectors: boolean): Plan {
  const problems = common(ctx);
  if (ctx.position.status !== 'active')
    problems.push(`the position is ${ctx.position.status}, not active (PositionNotActive)`);
  if (ctx.position.openAdvance)
    problems.push('an advance is open: the identity is locked until it is repaid (AdvanceOpen)');
  if (newIdentity.equals(ctx.position.identity)) problems.push('the new identity is the current identity');
  const warnings: string[] = [];
  if (!withCollectors) {
    warnings.push(
      'without set_collectors the block revenue collector stays on the new identity (the vote program resets it); ' +
        'run set_collectors before the next sweep or block revenue bypasses the escrow',
    );
  }
  const instructions = updateIdentity({
    programId: ctx.programId,
    operator: ctx.operator,
    vote: ctx.vote,
    newIdentity,
  });
  if (withCollectors)
    instructions.push(...setCollectors({ programId: ctx.programId, cranker: ctx.operator, vote: ctx.vote }));
  return {
    title: `update_identity${withCollectors ? ' + set_collectors' : ''}`,
    summary: [
      ['vote account', ctx.vote.toBase58()],
      ['current identity', ctx.position.identity.toBase58()],
      ['new identity', `${newIdentity.toBase58()} (co-signs)`],
    ],
    instructions,
    problems,
    warnings,
  };
}

export function planWithdrawBond(ctx: OperatorContext, lamports: bigint): Plan {
  const problems = common(ctx);
  if (ctx.position.openAdvance) problems.push('an advance is open: the bond is locked until it is repaid (BondLocked)');
  if (ctx.position.status !== 'active')
    problems.push(`the position is ${ctx.position.status}, not active (PositionNotActive)`);
  if (lamports > ctx.position.bondLamports) {
    problems.push(`the bond is ${lamportsToSolString(ctx.position.bondLamports)} SOL; cannot withdraw more`);
  }
  return {
    title: `withdraw_bond: ${lamportsToSolString(lamports)} SOL`,
    summary: [
      ['vote account', ctx.vote.toBase58()],
      ['bond now', `${lamportsToSolString(ctx.position.bondLamports)} SOL`],
      ['withdraw', `${lamportsToSolString(lamports)} SOL → ${ctx.operator.toBase58()}`],
    ],
    instructions: withdrawBond({ programId: ctx.programId, operator: ctx.operator, vote: ctx.vote, lamports }),
    problems,
    warnings: [],
  };
}

/**
 * `release_validator`, with the identity account passed WRITABLE. The SDK builder mirrors the Rust `ReleaseValidator`
 * struct, where `identity` is read-only, but on a v4 vote account whose block revenue collector is the escrow the
 * program CPIs `UpdateCommissionCollector(BlockRevenue → identity)`, and the vote program takes the collector as a
 * writable account: passed read-only, the CPI fails with a privilege escalation. (Program bug: `identity` should be
 * `#[account(mut, …)]` in `instructions/credit/release.rs`.)
 */
export function planRelease(ctx: OperatorContext, newWithdrawer?: PublicKey): Plan {
  const problems = common(ctx);
  if (ctx.position.openAdvance) problems.push('an advance is open: repay it before leaving (AdvanceOpen)');
  if (ctx.position.status !== 'active')
    problems.push(`the position is ${ctx.position.status}, not active (PositionNotActive)`);
  const target = newWithdrawer ?? ctx.position.originalWithdrawer;
  const warnings: string[] = [];
  if (newWithdrawer && !newWithdrawer.equals(ctx.position.originalWithdrawer)) {
    warnings.push(
      `the withdraw authority goes to ${newWithdrawer.toBase58()}, not the original withdrawer ` +
        `${ctx.position.originalWithdrawer.toBase58()}: make sure you hold that key`,
    );
  }
  const instructions = releaseValidator({
    programId: ctx.programId,
    operator: ctx.operator,
    vote: ctx.vote,
    newWithdrawer: target,
    identity: ctx.position.identity,
  });
  for (const ix of instructions) {
    for (const meta of ix.keys) if (meta.pubkey.equals(ctx.position.identity)) meta.isWritable = true;
  }
  return {
    title: 'release_validator: leave Epoch',
    summary: [
      ['vote account', ctx.vote.toBase58()],
      ['new withdraw authority', target.toBase58()],
      ['bond returned', `${lamportsToSolString(ctx.position.bondLamports)} SOL → operator`],
      ['also returned', 'the escrow balance and the position account rent → operator'],
      ['collectors', 'reset to the vote account (inflation) and the identity (block revenue) on v4'],
    ],
    instructions,
    problems,
    warnings,
  };
}

/** Names for every account an operator instruction can touch, for the printed instruction list. */
export function accountLabels(
  ctx: Pick<OperatorContext, 'programId' | 'operator' | 'vote' | 'position'>,
): Map<string, string> {
  const [pool] = findPoolPda(ctx.programId);
  const labels = new Map<string, string>();
  // First name wins: the operator key may also be the identity or the original withdrawer.
  const add = (key: PublicKey, label: string) => {
    if (!labels.has(key.toBase58())) labels.set(key.toBase58(), label);
  };
  add(ctx.operator, 'operator (you)');
  add(pool, 'pool');
  add(findVaultPda(ctx.programId, pool)[0], 'pool vault');
  add(findFeeIndexPda(ctx.programId, pool)[0], 'fee index');
  add(findPositionPda(ctx.programId, ctx.vote)[0], 'validator position');
  add(ctx.vote, 'vote account');
  add(findVoteAuthPda(ctx.programId, ctx.vote)[0], 'vote authority (program PDA)');
  add(findEscrowPda(ctx.programId, ctx.vote)[0], 'escrow (commission collector)');
  add(ctx.position.identity, 'validator identity');
  add(ctx.position.originalWithdrawer, 'original withdrawer');
  add(SYSVAR_CLOCK_PUBKEY, 'clock sysvar');
  add(VOTE_PROGRAM_ID, 'vote program');
  add(SystemProgram.programId, 'system program');
  add(ctx.programId, 'Epoch program');
  return labels;
}
