import {
  type AdvanceAccount,
  checkLaunchConfig,
  COMMISSION_KIND,
  decodeDbcLaunchConfig,
  decodeDbcPoolHead,
  findDbcPoolPda,
  findEscrowPda,
  findFeeIndexPda,
  findPartnerTreasuryPda,
  findPoolPda,
  findPositionPda,
  findRevenueTokenPda,
  findVaultPda,
  findVoteAuthPda,
  lamportsToSolString,
  METEORA,
  onboardWithBond,
  type PoolAccount,
  registerRevenueToken,
  releaseValidator,
  setCollectors,
  TOKEN_PROGRAM_ID,
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
      'without set_collectors: a block revenue collector that was the old identity follows the new one (the vote ' +
        'program moves only that one); run set_collectors before the next sweep or block revenue bypasses the escrow',
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
 * `release_validator`, with the identity account passed writable: on a v4 vote account whose block revenue collector
 * is the escrow the program CPIs `UpdateCommissionCollector(BlockRevenue → identity)`, and the vote program takes the
 * collector writable (the program's `identity` is `mut` and the SDK builder marks it so; the loop below only keeps
 * older builders working).
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

// ─── Onboarding, collectors and revenue tokens ─────────────────────────────

/** `set_collectors`: both commission collectors → the escrow. Permissionless: the signer only pays the fee. */
export function planSetCollectors(ctx: OperatorContext): Plan {
  const problems: string[] = [];
  if (ctx.position.status === 'released') problems.push('the position is released (PositionNotActive)');
  const [voteAuth] = findVoteAuthPda(ctx.programId, ctx.vote);
  const [escrow] = findEscrowPda(ctx.programId, ctx.vote);
  const warnings: string[] = [];
  if (ctx.voteState) {
    if (ctx.voteState.authorizedWithdrawer !== voteAuth.toBase58()) {
      problems.push('the program is not the vote account’s withdraw authority (ProgramNotWithdrawAuthority)');
    }
    if (ctx.voteState.version !== 'v4') {
      problems.push(
        `the vote account is ${ctx.voteState.version}: commission collectors need vote state v4 (SIMD-0232)`,
      );
    }
    if (
      ctx.voteState.inflationRewardsCollector === escrow.toBase58() &&
      ctx.voteState.blockRevenueCollector === escrow.toBase58()
    ) {
      warnings.push('both collectors already point at the escrow');
    }
  } else warnings.push('could not read the vote account');
  return {
    title: 'set_collectors',
    summary: [
      ['vote account', ctx.vote.toBase58()],
      [
        'collectors now',
        ctx.voteState
          ? `${ctx.voteState.inflationRewardsCollector ?? 'vote account'} / ${ctx.voteState.blockRevenueCollector ?? 'identity'}`
          : 'unknown',
      ],
      ['collectors then', `${escrow.toBase58()} (escrow) / same`],
    ],
    instructions: setCollectors({ programId: ctx.programId, cranker: ctx.operator, vote: ctx.vote }),
    problems,
    warnings,
  };
}

/** What `onboard-validator` reads first. */
export interface OnboardContext {
  programId: PublicKey;
  /** The signer: becomes the position's operator and pays the rent. */
  operator: PublicKey;
  vote: PublicKey;
  pool: PoolAccount | null;
  voteState: VoteState | null;
  /** A position already exists for this vote account. */
  onboarded: boolean;
}

/**
 * `onboard_validator` (+ `set_collectors`, + `post_bond`): the current withdraw authority co-signs once and the Epoch
 * PDA becomes the withdraw authority; the signer becomes the operator.
 */
export function planOnboard(
  ctx: OnboardContext,
  input: { payout: PublicKey; withdrawer: PublicKey; bondLamports: bigint; setCollectors: boolean },
): Plan {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!ctx.pool) problems.push('the Pool account does not exist (is EPOCH_PROGRAM_ID right?)');
  else if (ctx.pool.paused) problems.push('the pool is paused (Paused)');
  if (ctx.onboarded) problems.push('this vote account already has a position (onboard runs once)');
  const v = ctx.voteState;
  if (!v) problems.push('the vote account is missing or unreadable (NotAVoteAccount)');
  else {
    if (v.authorizedWithdrawer !== input.withdrawer.toBase58()) {
      problems.push(`the withdraw authority is ${v.authorizedWithdrawer}, not --withdrawer (NotWithdrawAuthority)`);
    }
    if (ctx.pool && v.inflationRewardsCommissionBps < ctx.pool.params.minCommissionBps) {
      problems.push(
        `inflation commission ${v.inflationRewardsCommissionBps} bps is below the pool minimum ` +
          `${ctx.pool.params.minCommissionBps} (CommissionTooLow)`,
      );
    }
    if (input.setCollectors && v.version !== 'v4') {
      warnings.push(`vote state ${v.version}: set_collectors needs v4; pass --no-set-collectors on this cluster`);
    }
  }
  if (!input.setCollectors)
    warnings.push('without set_collectors, commission does not flow to the escrow until it runs');
  const [voteAuth] = findVoteAuthPda(ctx.programId, ctx.vote);
  return {
    title: `onboard_validator${input.setCollectors ? ' + set_collectors' : ''}${input.bondLamports > 0n ? ' + post_bond' : ''}`,
    summary: [
      ['vote account', ctx.vote.toBase58()],
      ['identity', v?.nodePubkey ?? 'unknown'],
      ['withdraw authority now', `${input.withdrawer.toBase58()} (co-signs)`],
      ['withdraw authority then', `${voteAuth.toBase58()} (the Epoch program PDA)`],
      ['operator (signer)', ctx.operator.toBase58()],
      ['payout', input.payout.toBase58()],
      ['bond', input.bondLamports > 0n ? `${lamportsToSolString(input.bondLamports)} SOL` : 'none'],
      [
        'commission',
        v ? `${v.inflationRewardsCommissionBps} bps inflation, ${v.blockRevenueCommissionBps} bps block` : '?',
      ],
    ],
    instructions: onboardWithBond({
      programId: ctx.programId,
      operator: ctx.operator,
      currentWithdrawer: input.withdrawer,
      vote: ctx.vote,
      payout: input.payout,
      bondLamports: input.bondLamports,
      setCollectors: input.setCollectors,
    }),
    problems,
    warnings,
  };
}

/** What `register-revenue-token` reads first (raw accounts, decoded here). */
export interface RegisterContext extends OperatorContext {
  mint: { owner: PublicKey; data: Uint8Array } | null;
  dbcConfig: { owner: PublicKey; data: Uint8Array } | null;
  dbcPool: { address: PublicKey; owner: PublicKey; data: Uint8Array } | null;
  /** The `RevenueToken` PDA exists already. */
  revenueTokenExists: boolean;
}

/** SPL Token mint (82 bytes): COption mint authority, supply, decimals, initialized, COption freeze authority. */
function readMint(
  data: Uint8Array,
): { mintAuthority: boolean; supply: bigint; initialized: boolean; freezeAuthority: boolean } | null {
  if (data.length !== 82) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mintAuthority: view.getUint32(0, true) !== 0,
    supply: view.getBigUint64(36, true),
    initialized: data[45] === 1,
    freezeAuthority: view.getUint32(46, true) !== 0,
  };
}

/**
 * `register_revenue_token(share_bps, term_epochs)`, with the program's checks run first: the SDK builder (as the
 * launch scripts use it) and the SDK's mirror of the DBC config checks (`checkLaunchConfig`).
 */
export function planRegisterRevenueToken(
  ctx: RegisterContext,
  input: { mint: PublicKey; dbcConfig: PublicKey; shareBps: number; termEpochs: number },
): Plan {
  const problems = common(ctx);
  const warnings: string[] = [];
  const [poolKey] = findPoolPda(ctx.programId);
  const [treasury] = findPartnerTreasuryPda(ctx.programId, poolKey);
  if (ctx.pool.paused) problems.push('the pool is paused (Paused)');
  if (ctx.position.status !== 'active') problems.push(`the position is ${ctx.position.status} (PositionNotActive)`);
  if (ctx.position.revenueToken || ctx.revenueTokenExists)
    problems.push('this validator has a revenue token (RevenueTokenExists)');
  // The mint: SPL Token, fixed supply, no authorities.
  const mint = ctx.mint && ctx.mint.owner.equals(TOKEN_PROGRAM_ID) ? readMint(ctx.mint.data) : null;
  if (!mint) problems.push('the mint is not an SPL Token mint (InvalidRevenueMint; Token-2022 is refused)');
  else if (!mint.initialized || mint.supply === 0n || mint.mintAuthority || mint.freezeAuthority) {
    problems.push('the mint must be initialized with supply and no mint or freeze authority (InvalidRevenueMint)');
  }
  // Its curve: the pool derived from config and mint.
  const dbcPoolKey = findDbcPoolPda(input.dbcConfig, input.mint);
  let floor: string = '?';
  if (!ctx.dbcPool || !ctx.dbcPool.owner.equals(METEORA.DBC_PROGRAM_ID)) {
    problems.push(`no DBC pool for this mint and config at ${dbcPoolKey.toBase58()} (InvalidDbcPool)`);
  } else {
    try {
      const head = decodeDbcPoolHead(ctx.dbcPool.data);
      if (!head.baseMint.equals(input.mint) || !head.config.equals(input.dbcConfig) || head.poolType !== 0) {
        problems.push('the DBC pool does not trade this mint with this config as SPL Token (InvalidDbcPool)');
      }
    } catch {
      problems.push('the DBC pool account does not decode (InvalidDbcPool)');
    }
  }
  if (!ctx.dbcConfig || !ctx.dbcConfig.owner.equals(METEORA.DBC_PROGRAM_ID)) {
    problems.push('the DBC config is missing or not owned by DBC (InvalidDbcConfig)');
  } else {
    try {
      const check = checkLaunchConfig(decodeDbcLaunchConfig(ctx.dbcConfig.data), treasury);
      if (check.ok) floor = `${check.feeFloorBps} bps (max_impact_bps ≤ ${check.maxImpactBound})`;
      else problems.push(`${check.reason} (${check.error})`);
    } catch {
      problems.push('the DBC config account does not decode (InvalidDbcConfig)');
    }
  }
  warnings.push(
    `the term starts the epoch after registration and runs ${input.termEpochs} epochs; until it ends the ` +
      'validator cannot release or cut either commission below today’s',
  );
  return {
    title: `register_revenue_token: ${input.shareBps} bps for ${input.termEpochs} epochs`,
    summary: [
      ['vote account', ctx.vote.toBase58()],
      ['mint', input.mint.toBase58()],
      ['DBC config / pool', `${input.dbcConfig.toBase58()} / ${dbcPoolKey.toBase58()}`],
      ['treasury PDA (fee claimer, leftover receiver)', treasury.toBase58()],
      ['venue fee floor', floor],
      ['share / term', `${input.shareBps} bps of gross revenue for ${input.termEpochs} epochs`],
      ['revenue token', findRevenueTokenPda(ctx.programId, ctx.vote)[0].toBase58()],
      ['rent (operator pays)', '0.00732192 SOL (RevenueToken 503 B, buyback escrow, buyback token account)'],
    ],
    instructions: registerRevenueToken({
      programId: ctx.programId,
      operator: ctx.operator,
      vote: ctx.vote,
      mint: input.mint,
      dbcPool: dbcPoolKey,
      dbcConfig: input.dbcConfig,
      shareBps: input.shareBps,
      termEpochs: input.termEpochs,
    }),
    problems,
    warnings,
  };
}
