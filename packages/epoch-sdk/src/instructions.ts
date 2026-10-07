/**
 * Instruction builders for all 56 instructions in `programs/epoch/src/lib.rs`.
 *
 * Accounts are listed in the exact order of each Rust `#[derive(Accounts)]` struct, with its signer and `mut`
 * flags; PDAs are derived from `programId`. Data is `discriminator ++ borsh(args)` in `lib.rs` argument order.
 * Every builder returns `TransactionInstruction[]` so multi-instruction helpers compose the same way.
 *
 * Optional accounts (`Option<Account<…>>`, e.g. `advance` in `Sweep`) are passed as the program ID itself when
 * absent: Anchor's `Option<T>::try_accounts` reads an account whose key equals the executing program's ID as `None`.
 */
import {
  type AccountMeta,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';

import { type PoolParams, writePoolParams } from './accounts';
import { BorshWriter, U64_MAX } from './borsh';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
  METEORA,
  PROGRAM_CONSTANTS,
  NATIVE_MINT,
  SIDES,
  type Side,
  TOKEN_PROGRAM_ID,
  type Tranche,
  TRANCHES,
  VOTE_PROGRAM_ID,
} from './constants';
import { INSTRUCTION_DISCRIMINATORS, type InstructionName } from './discriminators';
import {
  findAdvancePda,
  findAssociatedTokenAddress,
  findBuybackEscrowPda,
  findBuybackTokensPda,
  findBuybackWsolPda,
  findEscrowPda,
  findFeeIndexPda,
  findIndexBallotPda,
  findIndexOperatorsPda,
  findLenderPda,
  findPartnerTreasuryPda,
  findPoolPda,
  findPositionPda,
  findPriorityFeeDistributionPda,
  findQuotePda,
  findRevenueTokenPda,
  findScoreConfigPda,
  findDammPositionNftAccount,
  findSwapPda,
  findTipDistributionPda,
  findValidatorHistoryPda,
  findTreasuryWsolPda,
  findVaultPda,
  findVoteAuthPda,
  findWithdrawRequestPda,
} from './pda';

const SYSTEM_PROGRAM_ID = SystemProgram.programId;

const signerWritable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });
const signer = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
const writable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/** Duck-typed rather than `instanceof`, so a PublicKey from another copy of web3.js is accepted. */
function checkProgramId(programId: PublicKey): PublicKey {
  if (typeof (programId as { toBytes?: unknown } | undefined)?.toBytes !== 'function') {
    throw new TypeError('programId must be a PublicKey');
  }
  return programId;
}

let web3Buffer: typeof Buffer | undefined;

/**
 * `TransactionInstruction.data` must be a `Buffer`. Instead of importing `buffer` (a Node built-in that browser
 * bundlers only provide when it is a declared dependency), use the Buffer class web3.js itself was built with:
 * Node's under Node, the npm polyfill in a browser bundle.
 */
function toWeb3Buffer(bytes: Uint8Array): Buffer {
  web3Buffer ??= PublicKey.default.toBuffer().constructor as typeof Buffer;
  return web3Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function instruction(
  programId: PublicKey,
  name: InstructionName,
  keys: AccountMeta[],
  args?: (w: BorshWriter) => void,
): TransactionInstruction[] {
  checkProgramId(programId);
  const w = new BorshWriter().fixedBytes(INSTRUCTION_DISCRIMINATORS[name], 8, 'discriminator');
  args?.(w);
  return [new TransactionInstruction({ programId, keys, data: toWeb3Buffer(w.toBytes()) })];
}

/** The PDAs shared by most instructions. */
function poolKeys(programId: PublicKey): { pool: PublicKey; vault: PublicKey; feeIndex: PublicKey } {
  const [pool] = findPoolPda(checkProgramId(programId));
  return { pool, vault: findVaultPda(programId, pool)[0], feeIndex: findFeeIndexPda(programId, pool)[0] };
}

function voteKeys(
  programId: PublicKey,
  vote: PublicKey,
): { position: PublicKey; voteAuth: PublicKey; escrow: PublicKey } {
  return {
    position: findPositionPda(checkProgramId(programId), vote)[0],
    voteAuth: findVoteAuthPda(programId, vote)[0],
    escrow: findEscrowPda(programId, vote)[0],
  };
}

interface WithProgram {
  /** The Epoch program ID (still a placeholder on-chain, so always explicit). */
  programId: PublicKey;
}

// ─── Pool: admin ───────────────────────────────────────────────────────────

export interface InitializePoolInput extends WithProgram {
  admin: PublicKey;
  treasury: PublicKey;
  scorer: PublicKey;
  params: PoolParams;
}

/** `initialize_pool(params)`: creates the pool and funds its vault to rent-exemption. Signer: admin (payer). */
export function initializePool({
  programId,
  admin,
  treasury,
  scorer,
  params,
}: InitializePoolInput): TransactionInstruction[] {
  const { pool, vault } = poolKeys(programId);
  return instruction(
    programId,
    'initialize_pool',
    [
      signerWritable(admin),
      writable(pool),
      writable(vault),
      readonly(treasury),
      readonly(scorer),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    (w) => writePoolParams(w, params),
  );
}

export interface UpdateParamsInput extends WithProgram {
  admin: PublicKey;
  params: PoolParams;
}

/** `update_params(params)`. Signer: admin. */
export function updateParams({ programId, admin, params }: UpdateParamsInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  return instruction(programId, 'update_params', [signer(admin), writable(pool)], (w) => writePoolParams(w, params));
}

export interface SetPausedInput extends WithProgram {
  admin: PublicKey;
  paused: boolean;
}

/** `set_paused(paused)`. Signer: admin. */
export function setPaused({ programId, admin, paused }: SetPausedInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  return instruction(programId, 'set_paused', [signer(admin), writable(pool)], (w) => w.bool(paused, 'paused'));
}

export interface SetRolesInput extends WithProgram {
  admin: PublicKey;
  treasury: PublicKey;
  scorer: PublicKey;
  /** Pass the current admin to keep it. */
  newAdmin: PublicKey;
}

/** `set_roles()`: rotate treasury, scorer and admin. Signer: admin. */
export function setRoles({ programId, admin, treasury, scorer, newAdmin }: SetRolesInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  return instruction(programId, 'set_roles', [
    signer(admin),
    writable(pool),
    readonly(treasury),
    readonly(scorer),
    readonly(newAdmin),
  ]);
}

// ─── Pool: lenders ─────────────────────────────────────────────────────────

export interface DepositInput extends WithProgram {
  owner: PublicKey;
  tranche: Tranche;
  lamports: bigint;
}

/** `deposit(tranche, assets)`: creates the lender account on first deposit. Signer: owner (payer). */
export function deposit({ programId, owner, tranche, lamports }: DepositInput): TransactionInstruction[] {
  const { pool, vault } = poolKeys(programId);
  const [lender] = findLenderPda(programId, pool, owner, tranche);
  return instruction(
    programId,
    'deposit',
    [signerWritable(owner), writable(pool), writable(vault), writable(lender), readonly(SYSTEM_PROGRAM_ID)],
    (w) => w.variant(TRANCHES, tranche, 'tranche').u64(lamports, 'lamports'),
  );
}

export interface RequestWithdrawInput extends WithProgram {
  owner: PublicKey;
  tranche: Tranche;
  shares: bigint;
  /** `pool.withdraw_tail` at send time: the new request's sequence number and PDA seed. */
  withdrawTail: bigint;
}

/** `request_withdraw(shares)`: queues shares; the request PDA is `["withdraw", pool, withdrawTail]`. */
export function requestWithdraw({
  programId,
  owner,
  tranche,
  shares,
  withdrawTail,
}: RequestWithdrawInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const [lender] = findLenderPda(programId, pool, owner, tranche);
  const [request] = findWithdrawRequestPda(programId, pool, withdrawTail);
  return instruction(
    programId,
    'request_withdraw',
    [signerWritable(owner), writable(pool), writable(lender), writable(request), readonly(SYSTEM_PROGRAM_ID)],
    (w) => w.u64(shares, 'shares'),
  );
}

export interface CancelWithdrawInput extends WithProgram {
  owner: PublicKey;
  tranche: Tranche;
  seq: bigint;
}

/** `cancel_withdraw()`. Signer: owner. */
export function cancelWithdraw({ programId, owner, tranche, seq }: CancelWithdrawInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const [lender] = findLenderPda(programId, pool, owner, tranche);
  const [request] = findWithdrawRequestPda(programId, pool, seq);
  return instruction(programId, 'cancel_withdraw', [
    signer(owner),
    writable(pool),
    writable(lender),
    writable(request),
  ]);
}

export interface ProcessWithdrawalInput extends WithProgram {
  cranker: PublicKey;
  /** The request's owner: receives the payout and the request's rent. */
  owner: PublicKey;
  tranche: Tranche;
  seq: bigint;
}

/** `process_withdrawal()`: pays the head of the queue. Anyone may crank. */
export function processWithdrawal({
  programId,
  cranker,
  owner,
  tranche,
  seq,
}: ProcessWithdrawalInput): TransactionInstruction[] {
  const { pool, vault } = poolKeys(programId);
  const [lender] = findLenderPda(programId, pool, owner, tranche);
  const [request] = findWithdrawRequestPda(programId, pool, seq);
  return instruction(programId, 'process_withdrawal', [
    signer(cranker),
    writable(pool),
    writable(vault),
    writable(owner),
    writable(lender),
    writable(request),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

export interface AccrueInput extends WithProgram {
  cranker: PublicKey;
  /** Must equal `pool.treasury`; receives the protocol fee. */
  treasury: PublicKey;
}

/** `accrue()`: once per epoch. Anyone may crank. */
export function accrue({ programId, cranker, treasury }: AccrueInput): TransactionInstruction[] {
  const { pool, vault } = poolKeys(programId);
  return instruction(programId, 'accrue', [
    signer(cranker),
    writable(pool),
    writable(vault),
    writable(treasury),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

// ─── Credit ────────────────────────────────────────────────────────────────

export interface OnboardValidatorInput extends WithProgram {
  /** Pays rent and becomes the position's operator. */
  operator: PublicKey;
  /** The vote account's withdraw authority today (may be the same key as `operator`). */
  currentWithdrawer: PublicKey;
  vote: PublicKey;
  payout: PublicKey;
}

/** `onboard_validator()`: hands the vote account's withdraw authority to the program. Signers: operator, currentWithdrawer. */
export function onboardValidator({
  programId,
  operator,
  currentWithdrawer,
  vote,
  payout,
}: OnboardValidatorInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const { position, voteAuth, escrow } = voteKeys(programId, vote);
  return instruction(programId, 'onboard_validator', [
    signerWritable(operator),
    signer(currentWithdrawer),
    writable(pool),
    writable(vote),
    writable(position),
    readonly(voteAuth),
    writable(escrow),
    readonly(payout),
    readonly(SYSVAR_CLOCK_PUBKEY),
    readonly(VOTE_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

export interface SetCollectorsInput extends WithProgram {
  cranker: PublicKey;
  vote: PublicKey;
}

/** `set_collectors()`: points both commission collectors (SIMD-0232) at the escrow. Anyone may crank. */
export function setCollectors({ programId, cranker, vote }: SetCollectorsInput): TransactionInstruction[] {
  const { position, voteAuth, escrow } = voteKeys(programId, vote);
  return instruction(programId, 'set_collectors', [
    signer(cranker),
    readonly(position),
    writable(vote),
    readonly(voteAuth),
    writable(escrow),
    readonly(VOTE_PROGRAM_ID),
  ]);
}

export interface BondInput extends WithProgram {
  operator: PublicKey;
  vote: PublicKey;
  lamports: bigint;
}

function bond(
  name: 'post_bond' | 'withdraw_bond',
  { programId, operator, vote, lamports }: BondInput,
): TransactionInstruction[] {
  const { pool, vault } = poolKeys(programId);
  const [position] = findPositionPda(programId, vote);
  return instruction(
    programId,
    name,
    [signerWritable(operator), writable(pool), writable(vault), writable(position), readonly(SYSTEM_PROGRAM_ID)],
    (w) => w.u64(lamports, 'lamports'),
  );
}

/** `post_bond(lamports)`. Signer: operator. */
export function postBond(input: BondInput): TransactionInstruction[] {
  return bond('post_bond', input);
}

/** `withdraw_bond(lamports)`. Signer: operator. */
export function withdrawBond(input: BondInput): TransactionInstruction[] {
  return bond('withdraw_bond', input);
}

export interface OnboardWithBondInput extends OnboardValidatorInput {
  /** 0 omits `post_bond`. */
  bondLamports: bigint;
  /**
   * Include `set_collectors` (default true). Pass false on clusters where SIMD-0232 commission collectors are not
   * active yet; the program keeps `set_collectors` separate for that reason.
   */
  setCollectors?: boolean;
}

/**
 * One transaction's worth of onboarding: `[onboard_validator, set_collectors (cranker = operator), post_bond]`.
 * Signers: operator and currentWithdrawer.
 */
export function onboardWithBond(input: OnboardWithBondInput): TransactionInstruction[] {
  const { programId, operator, vote, bondLamports } = input;
  if (typeof bondLamports !== 'bigint' || bondLamports < 0n || bondLamports > U64_MAX) {
    throw new RangeError('bondLamports must be a u64 bigint');
  }
  const out = onboardValidator(input);
  if (input.setCollectors !== false) out.push(...setCollectors({ programId, cranker: operator, vote }));
  if (bondLamports > 0n) out.push(...postBond({ programId, operator, vote, lamports: bondLamports }));
  return out;
}

export interface ScoreUpdate {
  /** u16: vote credits as a share of the cluster average, bps. */
  creditsRatioBps: number;
  /** u16: the higher of inflation and MEV commission, bps. */
  commissionBps: number;
  /** u16 */
  epochsActive: number;
  delinquent: boolean;
  superminority: boolean;
  /** The validator holds a Fee Market hedge for the coming epoch. */
  hedged: boolean;
}

export interface UpdateScoreInput extends WithProgram {
  scorer: PublicKey;
  vote: PublicKey;
  update: ScoreUpdate;
}

/**
 * `update_score(update)`. Signer: the pool's scorer. The fallback for clusters without history: refused with
 * `HistoryIsFresh` once the validator's `ValidatorHistory` holds a vote copy from the current epoch.
 */
export function updateScore({ programId, scorer, vote, update }: UpdateScoreInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const [position] = findPositionPda(programId, vote);
  // The history address is always passed: the program refuses while it holds a fresh vote copy.
  const [history] = findValidatorHistoryPda(programId, vote);
  return instruction(
    programId,
    'update_score',
    [signer(scorer), readonly(pool), writable(position), readonly(history)],
    (w) =>
      w
        .u16(update.creditsRatioBps, 'creditsRatioBps')
        .u16(update.commissionBps, 'commissionBps')
        .u16(update.epochsActive, 'epochsActive')
        .bool(update.delinquent, 'delinquent')
        .bool(update.superminority, 'superminority')
        .bool(update.hedged, 'hedged'),
  );
}

export interface RequestAdvanceInput extends WithProgram {
  operator: PublicKey;
  vote: PublicKey;
  /** Must equal `position.payout`; receives the principal. */
  payout: PublicKey;
  /** `position.advance_seq` at send time: the new advance's PDA seed. */
  advanceSeq: bigint;
  lamports: bigint;
}

/** `request_advance(amount)`: the advance PDA is `["advance", vote, advanceSeq]`. Signer: operator (payer). */
export function requestAdvance({
  programId,
  operator,
  vote,
  payout,
  advanceSeq,
  lamports,
}: RequestAdvanceInput): TransactionInstruction[] {
  const { pool, vault } = poolKeys(programId);
  const [position] = findPositionPda(programId, vote);
  const [advance] = findAdvancePda(programId, vote, advanceSeq);
  return instruction(
    programId,
    'request_advance',
    [
      signerWritable(operator),
      writable(pool),
      writable(vault),
      writable(position),
      writable(advance),
      writable(payout),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    (w) => w.u64(lamports, 'lamports'),
  );
}

export interface SweepInput extends WithProgram {
  cranker: PublicKey;
  vote: PublicKey;
  /** Must equal `position.payout`. */
  payout: PublicKey;
  /** `position.open_advance`; null when there is none (passed as `programId`, Anchor's `None`). */
  openAdvance: PublicKey | null;
  /**
   * `position.revenue_token`. When set, the revenue token and its buyback escrow are passed (the program requires
   * them, so the share cannot be skipped); null or omitted passes `programId` twice (Anchor's `None`).
   */
  revenueToken?: PublicKey | null;
}

/** `sweep()`: once per epoch per validator. Anyone may crank. */
export function sweep({
  programId,
  cranker,
  vote,
  payout,
  openAdvance,
  revenueToken,
}: SweepInput): TransactionInstruction[] {
  const { pool, vault } = poolKeys(programId);
  const { position, voteAuth, escrow } = voteKeys(programId, vote);
  return instruction(programId, 'sweep', [
    signer(cranker),
    writable(pool),
    writable(vault),
    writable(position),
    writable(vote),
    readonly(voteAuth),
    writable(escrow),
    writable(payout),
    openAdvance ? writable(openAdvance) : readonly(programId),
    readonly(VOTE_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
    ...revenueTokenMetas(programId, vote, revenueToken ?? null),
  ]);
}

/** The two optional `sweep` accounts: the revenue token and its escrow, or `None` twice. */
function revenueTokenMetas(programId: PublicKey, vote: PublicKey, revenueToken: PublicKey | null): AccountMeta[] {
  if (!revenueToken) return [readonly(programId), readonly(programId)];
  return [writable(revenueToken), writable(findBuybackEscrowPda(programId, vote)[0])];
}

/** The fields of a decoded `ValidatorPosition` a sweep needs. */
export interface SweepPositionInput extends WithProgram {
  cranker: PublicKey;
  position: { vote: PublicKey; payout: PublicKey; openAdvance: PublicKey | null; revenueToken: PublicKey | null };
}

/** `sweep()` for a decoded position: payout, open advance and revenue token come from the account. */
export function sweepPosition({ programId, cranker, position }: SweepPositionInput): TransactionInstruction[] {
  return sweep({
    programId,
    cranker,
    vote: position.vote,
    payout: position.payout,
    openAdvance: position.openAdvance,
    revenueToken: position.revenueToken,
  });
}

export interface MarkDefaultInput extends WithProgram {
  cranker: PublicKey;
  vote: PublicKey;
  /** The position's open advance. */
  advance: PublicKey;
}

/** `mark_default()`. Anyone may crank once the advance is defaultable. */
export function markDefault({ programId, cranker, vote, advance }: MarkDefaultInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const [position] = findPositionPda(programId, vote);
  return instruction(programId, 'mark_default', [
    signer(cranker),
    writable(pool),
    writable(position),
    writable(advance),
  ]);
}

export interface ReleaseValidatorInput extends WithProgram {
  operator: PublicKey;
  vote: PublicKey;
  /** Becomes the withdraw authority (normally `position.original_withdrawer`). */
  newWithdrawer: PublicKey;
  /** Must equal `position.identity`. */
  identity: PublicKey;
  /** `position.revenue_token` (required by the program when set: release waits for the end of its term). */
  revenueToken?: PublicKey | null;
}

/** `release_validator()`: hands the withdraw authority back and closes the position. Signer: operator. */
export function releaseValidator({
  programId,
  operator,
  vote,
  newWithdrawer,
  identity,
  revenueToken,
}: ReleaseValidatorInput): TransactionInstruction[] {
  const { pool, vault } = poolKeys(programId);
  const { position, voteAuth, escrow } = voteKeys(programId, vote);
  return instruction(programId, 'release_validator', [
    signerWritable(operator),
    writable(pool),
    writable(vault),
    writable(position),
    writable(vote),
    readonly(voteAuth),
    writable(escrow),
    readonly(newWithdrawer),
    // Writable: restoring the block revenue collector to the identity passes it writable to the vote program.
    writable(identity),
    readonly(SYSVAR_CLOCK_PUBKEY),
    readonly(VOTE_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
    readonly(revenueToken ?? programId),
  ]);
}

export interface UpdateCommissionInput extends WithProgram {
  operator: PublicKey;
  vote: PublicKey;
  /** u8: 0 = inflation rewards, 1 = block revenue (`COMMISSION_KIND`). The program rejects anything else. */
  kind: number;
  /** u16, bps. */
  commissionBps: number;
  /** `position.revenue_token` (required by the program when set: its commission floor applies during the term). */
  revenueToken?: PublicKey | null;
}

/** `update_commission(kind, commission_bps)`. Signer: operator. */
export function updateCommission({
  programId,
  operator,
  vote,
  kind,
  commissionBps,
  revenueToken,
}: UpdateCommissionInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const { position, voteAuth } = voteKeys(programId, vote);
  return instruction(
    programId,
    'update_commission',
    [
      signer(operator),
      readonly(pool),
      writable(position),
      writable(vote),
      readonly(voteAuth),
      readonly(VOTE_PROGRAM_ID),
      readonly(revenueToken ?? programId),
    ],
    (w) => w.u8(kind, 'kind').u16(commissionBps, 'commissionBps'),
  );
}

export interface UpdateIdentityInput extends WithProgram {
  operator: PublicKey;
  vote: PublicKey;
  /** Must co-sign, as the vote program requires. */
  newIdentity: PublicKey;
}

/** `update_identity()`. Signers: operator and newIdentity. */
export function updateIdentity({
  programId,
  operator,
  vote,
  newIdentity,
}: UpdateIdentityInput): TransactionInstruction[] {
  const { position, voteAuth } = voteKeys(programId, vote);
  return instruction(programId, 'update_identity', [
    signer(operator),
    signer(newIdentity),
    writable(position),
    writable(vote),
    readonly(voteAuth),
    readonly(VOTE_PROGRAM_ID),
  ]);
}

// ─── Fee Index ─────────────────────────────────────────────────────────────

export interface InitializeIndexInput extends WithProgram {
  admin: PublicKey;
  publisher: PublicKey;
  disputeWindowSlots: bigint;
  /** u16, bps. */
  maxMoveBps: number;
}

/** `initialize_index(dispute_window_slots, max_move_bps)`. Signer: admin (payer). */
export function initializeIndex({
  programId,
  admin,
  publisher,
  disputeWindowSlots,
  maxMoveBps,
}: InitializeIndexInput): TransactionInstruction[] {
  const { pool, feeIndex } = poolKeys(programId);
  return instruction(
    programId,
    'initialize_index',
    [signerWritable(admin), readonly(pool), writable(feeIndex), readonly(publisher), readonly(SYSTEM_PROGRAM_ID)],
    (w) => w.u64(disputeWindowSlots, 'disputeWindowSlots').u16(maxMoveBps, 'maxMoveBps'),
  );
}

export type ConfigureIndexInput = InitializeIndexInput;

/** `configure_index(dispute_window_slots, max_move_bps)`: also sets the publisher. Signer: admin. */
export function configureIndex({
  programId,
  admin,
  publisher,
  disputeWindowSlots,
  maxMoveBps,
}: ConfigureIndexInput): TransactionInstruction[] {
  const { pool, feeIndex } = poolKeys(programId);
  return instruction(
    programId,
    'configure_index',
    [signer(admin), readonly(pool), writable(feeIndex), readonly(publisher)],
    (w) => w.u64(disputeWindowSlots, 'disputeWindowSlots').u16(maxMoveBps, 'maxMoveBps'),
  );
}

export interface PostIndexInput extends WithProgram {
  publisher: PublicKey;
  epoch: bigint;
  /** Stake-weighted median priority fee, micro-lamports per CU. */
  value: bigint;
  /** 32-byte commitment to the per-slot inputs. */
  inputsHash: Uint8Array;
  /**
   * The signer is the sole operator of a one-operator registry (consensus on, `FeeIndex.publisher` is the registry
   * PDA): appends the registry as `remaining_accounts[0]`, which the program needs to accept the shortcut.
   */
  soleOperator?: boolean;
}

/**
 * `post_index(epoch, value, inputs_hash)`: the fee index PDA is derived from the pool PDA. Signer: publisher, or
 * with `soleOperator` the only registered operator (the registry PDA rides in `remaining_accounts`).
 */
export function postIndex({
  programId,
  publisher,
  epoch,
  value,
  inputsHash,
  soleOperator = false,
}: PostIndexInput): TransactionInstruction[] {
  const { feeIndex } = poolKeys(programId);
  const keys = [signer(publisher), writable(feeIndex)];
  if (soleOperator) keys.push(readonly(findIndexOperatorsPda(programId, feeIndex)[0]));
  return instruction(programId, 'post_index', keys, (w) =>
    w.u64(epoch, 'epoch').u64(value, 'value').fixedBytes(inputsHash, 32, 'inputsHash'),
  );
}

export interface FinalizeIndexInput extends WithProgram {
  cranker: PublicKey;
}

/** `finalize_index()`: after the dispute window. Anyone may crank. */
export function finalizeIndex({ programId, cranker }: FinalizeIndexInput): TransactionInstruction[] {
  const { feeIndex } = poolKeys(programId);
  return instruction(programId, 'finalize_index', [signer(cranker), writable(feeIndex)]);
}

export interface VetoIndexInput extends WithProgram {
  admin: PublicKey;
}

/** `veto_index()`: drops the pending proposal. Signer: admin. */
export function vetoIndex({ programId, admin }: VetoIndexInput): TransactionInstruction[] {
  const { pool, feeIndex } = poolKeys(programId);
  return instruction(programId, 'veto_index', [signer(admin), readonly(pool), writable(feeIndex)]);
}

// ─── Fee Index: operator consensus ─────────────────────────────────────────

/** The pool, fee index and operator registry PDAs every consensus instruction names. */
function consensusKeys(programId: PublicKey): { pool: PublicKey; feeIndex: PublicKey; indexOperators: PublicKey } {
  const { pool, feeIndex } = poolKeys(programId);
  return { pool, feeIndex, indexOperators: findIndexOperatorsPda(programId, feeIndex)[0] };
}

export interface InitializeIndexOperatorsInput extends WithProgram {
  admin: PublicKey;
  /** u16, bps of the total registered weight that must agree (5,001 to 10,000; the program's default is 6,667). */
  thresholdBps: number;
  /** u16, bps: a vote agrees when it is within this of the weighted median (0 to 1,000). */
  toleranceBps: number;
}

/**
 * `initialize_index_operators(threshold_bps, tolerance_bps)`: creates the empty registry and turns consensus on
 * (`FeeIndex.publisher` becomes the registry PDA). Add the operators in the same transaction. Signer: admin (payer).
 */
export function initializeIndexOperators({
  programId,
  admin,
  thresholdBps,
  toleranceBps,
}: InitializeIndexOperatorsInput): TransactionInstruction[] {
  const { pool, feeIndex, indexOperators } = consensusKeys(programId);
  return instruction(
    programId,
    'initialize_index_operators',
    [signerWritable(admin), readonly(pool), writable(feeIndex), writable(indexOperators), readonly(SYSTEM_PROGRAM_ID)],
    (w) => w.u16(thresholdBps, 'thresholdBps').u16(toleranceBps, 'toleranceBps'),
  );
}

export interface IndexOperatorInput extends WithProgram {
  admin: PublicKey;
  /** The operator's voting key. */
  operator: PublicKey;
}

export interface IndexOperatorWeightInput extends IndexOperatorInput {
  /** u32, above zero; the registry's total weight stays at most 10,000. */
  weight: number;
}

function manageIndexOperator(
  name: 'add_index_operator' | 'remove_index_operator' | 'set_index_operator_weight',
  { programId, admin, operator }: IndexOperatorInput,
  args?: (w: BorshWriter) => void,
): TransactionInstruction[] {
  const { pool, feeIndex, indexOperators } = consensusKeys(programId);
  return instruction(
    programId,
    name,
    [signer(admin), readonly(pool), readonly(feeIndex), writable(indexOperators), readonly(operator)],
    args,
  );
}

/** `add_index_operator(weight)`: registers a voting key (at most 8). Applies from the next ballot round. Signer: admin. */
export function addIndexOperator(input: IndexOperatorWeightInput): TransactionInstruction[] {
  return manageIndexOperator('add_index_operator', input, (w) => w.u32(input.weight, 'weight'));
}

/** `remove_index_operator()`: open rounds keep it in their snapshot. Signer: admin. */
export function removeIndexOperator(input: IndexOperatorInput): TransactionInstruction[] {
  return manageIndexOperator('remove_index_operator', input);
}

/** `set_index_operator_weight(weight)`. Signer: admin. */
export function setIndexOperatorWeight(input: IndexOperatorWeightInput): TransactionInstruction[] {
  return manageIndexOperator('set_index_operator_weight', input, (w) => w.u32(input.weight, 'weight'));
}

export type SetIndexConsensusInput = InitializeIndexOperatorsInput;

/** `set_index_consensus(threshold_bps, tolerance_bps)`: same ranges as at initialization. Signer: admin. */
export function setIndexConsensus({
  programId,
  admin,
  thresholdBps,
  toleranceBps,
}: SetIndexConsensusInput): TransactionInstruction[] {
  const { pool, feeIndex, indexOperators } = consensusKeys(programId);
  return instruction(
    programId,
    'set_index_consensus',
    [signer(admin), readonly(pool), readonly(feeIndex), writable(indexOperators)],
    (w) => w.u16(thresholdBps, 'thresholdBps').u16(toleranceBps, 'toleranceBps'),
  );
}

export interface CastIndexVoteInput extends WithProgram {
  /** A registered operator's voting key. */
  operator: PublicKey;
  /** Pays the ballot's rent when this vote opens it (refunded by `close_index_ballot`). Defaults to `operator`. */
  payer?: PublicKey;
  /** Program epoch voted on (the `post_index` numbering). */
  epoch: bigint;
  /** Stake-weighted median priority fee, micro-lamports per CU. */
  value: bigint;
  /** 32-byte commitment to the per-slot inputs. */
  inputsHash: Uint8Array;
}

/**
 * `cast_index_vote(epoch, value, inputs_hash)`: records or replaces the operator's vote in the epoch's ballot
 * (created by the first vote), and writes the proposal into `FeeIndex` once agreeing weight reaches the threshold.
 * Signers: operator and payer (one transaction signature when they are the same key).
 */
export function castIndexVote({
  programId,
  operator,
  payer = operator,
  epoch,
  value,
  inputsHash,
}: CastIndexVoteInput): TransactionInstruction[] {
  const { feeIndex, indexOperators } = consensusKeys(programId);
  const [ballot] = findIndexBallotPda(programId, feeIndex, epoch);
  return instruction(
    programId,
    'cast_index_vote',
    [
      signerWritable(payer),
      signer(operator),
      writable(feeIndex),
      readonly(indexOperators),
      writable(ballot),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    (w) => w.u64(epoch, 'epoch').u64(value, 'value').fixedBytes(inputsHash, 32, 'inputsHash'),
  );
}

export interface IndexBallotInput extends WithProgram {
  /** Program epoch of the ballot (its PDA seed). */
  epoch: bigint;
}

/** `submit_index_ballot()`: writes a queued consensus into `FeeIndex` once it is free. Anyone may crank. */
export function submitIndexBallot({
  programId,
  cranker,
  epoch,
}: IndexBallotInput & { cranker: PublicKey }): TransactionInstruction[] {
  const { feeIndex, indexOperators } = consensusKeys(programId);
  const [ballot] = findIndexBallotPda(programId, feeIndex, epoch);
  return instruction(programId, 'submit_index_ballot', [
    signer(cranker),
    writable(feeIndex),
    readonly(indexOperators),
    writable(ballot),
  ]);
}

/** `reset_index_ballot()`: opens the next round with a fresh registry snapshot (no live consensus). Signer: admin. */
export function resetIndexBallot({
  programId,
  admin,
  epoch,
}: IndexBallotInput & { admin: PublicKey }): TransactionInstruction[] {
  const { pool, feeIndex, indexOperators } = consensusKeys(programId);
  const [ballot] = findIndexBallotPda(programId, feeIndex, epoch);
  return instruction(programId, 'reset_index_ballot', [
    signer(admin),
    readonly(pool),
    readonly(feeIndex),
    readonly(indexOperators),
    writable(ballot),
  ]);
}

export interface CloseIndexBallotInput extends IndexBallotInput {
  cranker: PublicKey;
  /** `IndexBallot.payer`: receives the rent. */
  payer: PublicKey;
}

/** `close_index_ballot()`: once `FeeIndex.epoch ≥ epoch`, closes the ballot and refunds its payer. Anyone may crank. */
export function closeIndexBallot({
  programId,
  cranker,
  epoch,
  payer,
}: CloseIndexBallotInput): TransactionInstruction[] {
  const { feeIndex } = poolKeys(programId);
  const [ballot] = findIndexBallotPda(programId, feeIndex, epoch);
  return instruction(programId, 'close_index_ballot', [
    signer(cranker),
    readonly(feeIndex),
    writable(ballot),
    writable(payer),
  ]);
}

// ─── Fee Market ────────────────────────────────────────────────────────────

export interface PostQuoteInput extends WithProgram {
  maker: PublicKey;
  epoch: bigint;
  fixedRate: bigint;
  maxNotional: bigint;
  /** u16, bps. */
  maxMoveBps: number;
  expirySlot: bigint;
}

/** `post_quote(epoch, fixed_rate, max_notional, max_move_bps, expiry_slot)`. Signer: maker (payer, posts collateral). */
export function postQuote({
  programId,
  maker,
  epoch,
  fixedRate,
  maxNotional,
  maxMoveBps,
  expirySlot,
}: PostQuoteInput): TransactionInstruction[] {
  const { pool, feeIndex } = poolKeys(programId);
  const [quote] = findQuotePda(programId, maker, epoch);
  return instruction(
    programId,
    'post_quote',
    [signerWritable(maker), readonly(pool), readonly(feeIndex), writable(quote), readonly(SYSTEM_PROGRAM_ID)],
    (w) =>
      w
        .u64(epoch, 'epoch')
        .u64(fixedRate, 'fixedRate')
        .u64(maxNotional, 'maxNotional')
        .u16(maxMoveBps, 'maxMoveBps')
        .u64(expirySlot, 'expirySlot'),
  );
}

export interface WithdrawQuoteInput extends WithProgram {
  maker: PublicKey;
  epoch: bigint;
}

/** `withdraw_quote()`: closes the quote, returning rent and remaining collateral. Signer: maker. */
export function withdrawQuote({ programId, maker, epoch }: WithdrawQuoteInput): TransactionInstruction[] {
  const { feeIndex } = poolKeys(programId);
  const [quote] = findQuotePda(programId, maker, epoch);
  return instruction(programId, 'withdraw_quote', [signerWritable(maker), readonly(feeIndex), writable(quote)]);
}

export interface SwapLeg {
  quote: PublicKey;
  side: Side;
  notionalLamports: bigint;
}

export interface OpenSwapInput extends WithProgram, SwapLeg {
  taker: PublicKey;
}

/** `open_swap(notional, side)`: the swap PDA is `["swap", quote, taker]`. Signer: taker (payer, posts collateral). */
export function openSwap({ programId, taker, quote, side, notionalLamports }: OpenSwapInput): TransactionInstruction[] {
  const { pool, feeIndex } = poolKeys(programId);
  const [swap] = findSwapPda(programId, quote, taker);
  return instruction(
    programId,
    'open_swap',
    [
      signerWritable(taker),
      readonly(pool),
      readonly(feeIndex),
      writable(quote),
      writable(swap),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    (w) => w.u64(notionalLamports, 'notionalLamports').variant(SIDES, side, 'side'),
  );
}

export interface OpenSwapsInput extends WithProgram {
  taker: PublicKey;
  swaps: readonly SwapLeg[];
}

/** Several `open_swap`s for one transaction (e.g. a five-epoch hedge: one quote per epoch). */
export function openSwaps({ programId, taker, swaps }: OpenSwapsInput): TransactionInstruction[] {
  return swaps.flatMap((leg) => openSwap({ programId, taker, ...leg }));
}

export interface SettleSwapInput extends WithProgram {
  cranker: PublicKey;
  quote: PublicKey;
  /** The swap's taker: receives collateral ± P&L and the swap's rent. */
  taker: PublicKey;
}

/** `settle_swap()`: once the index for the swap's epoch is final. Anyone may crank. */
export function settleSwap({ programId, cranker, quote, taker }: SettleSwapInput): TransactionInstruction[] {
  const { feeIndex } = poolKeys(programId);
  const [swap] = findSwapPda(programId, quote, taker);
  return instruction(programId, 'settle_swap', [
    signer(cranker),
    readonly(feeIndex),
    writable(quote),
    writable(taker),
    writable(swap),
  ]);
}

// ─── Revenue tokens (Meteora) ──────────────────────────────────────────────

const TOKEN_VAULT_SEED = Uint8Array.from('token_vault', (c) => c.charCodeAt(0));

/** A Meteora pool's token vault: `["token_vault", mint, pool]` under the DBC or DAMM v2 program. */
export function findMeteoraVaultPda(program: PublicKey, mint: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TOKEN_VAULT_SEED, mint.toBytes(), pool.toBytes()], program)[0];
}

export interface RegisterRevenueTokenInput extends WithProgram {
  /** The position's operator: signs and pays rent. */
  operator: PublicKey;
  vote: PublicKey;
  /** The token, launched on DBC with the Epoch treasury PDA as fee claimer. */
  mint: PublicKey;
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  /** u16, 1–5,000 bps of gross revenue. */
  shareBps: number;
  /** u16, 10–1,000 epochs. */
  termEpochs: number;
}

/** `register_revenue_token(share_bps, term_epochs)`. Signer: operator (payer). */
export function registerRevenueToken({
  programId,
  operator,
  vote,
  mint,
  dbcPool,
  dbcConfig,
  shareBps,
  termEpochs,
}: RegisterRevenueTokenInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const { position, voteAuth } = voteKeys(programId, vote);
  return instruction(
    programId,
    'register_revenue_token',
    [
      signerWritable(operator),
      readonly(pool),
      writable(position),
      readonly(vote),
      readonly(voteAuth),
      writable(findRevenueTokenPda(programId, vote)[0]),
      writable(findBuybackEscrowPda(programId, vote)[0]),
      writable(findBuybackTokensPda(programId, vote)[0]),
      readonly(mint),
      readonly(dbcPool),
      readonly(dbcConfig),
      readonly(findPartnerTreasuryPda(programId, pool)[0]),
      readonly(TOKEN_PROGRAM_ID),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    (w) => w.u16(shareBps, 'shareBps').u16(termEpochs, 'termEpochs'),
  );
}

export interface SyncRevenueTokenPoolInput extends WithProgram {
  cranker: PublicKey;
  vote: PublicKey;
  dbcPool: PublicKey;
  /** The DAMM v2 config DBC migrated with (`DAMM_V2_MIGRATION_FEE_ADDRESS[option]` in the DBC SDK). */
  dammConfig: PublicKey;
  dammPool: PublicKey;
}

/** `sync_revenue_token_pool()`: records the DAMM v2 pool once the curve graduated. Anyone may crank. */
export function syncRevenueTokenPool({
  programId,
  cranker,
  vote,
  dbcPool,
  dammConfig,
  dammPool,
}: SyncRevenueTokenPoolInput): TransactionInstruction[] {
  checkProgramId(programId);
  return instruction(programId, 'sync_revenue_token_pool', [
    signer(cranker),
    writable(findRevenueTokenPda(programId, vote)[0]),
    readonly(dbcPool),
    readonly(dammConfig),
    readonly(dammPool),
  ]);
}

/** The venue of a buyback: the DBC pool until the token graduates and its DAMM v2 pool is synced. */
export interface BuybackVenueKeys {
  kind: 'dbc' | 'dammV2';
  pool: PublicKey;
  /** The pool's vault of the revenue token (derived when omitted). */
  tokenVault?: PublicKey;
  /** The pool's wrapped-SOL vault (derived when omitted). */
  quoteVault?: PublicKey;
}

export interface ExecuteBuybackInput extends WithProgram {
  cranker: PublicKey;
  vote: PublicKey;
  mint: PublicKey;
  dbcConfig: PublicKey;
  venue: BuybackVenueKeys;
  /** u8: the slice index, 0 … slices_per_epoch − 1. */
  slice: number;
  /** From a fresh quote; must be ≥ the program's floor (fee-free output − max_slippage_bps). */
  minAmountOut: bigint;
  /** Append the instructions sysvar (only pools whose rate limiter asks for it). */
  withInstructionsSysvar?: boolean;
}

/**
 * `execute_buyback(slice, min_amount_out)`: one slice. Anyone may crank; the cranker fronts ~0.002 SOL of rent.
 * Stopped by the pool's pause as well as the token's own flag.
 */
export function executeBuyback({
  programId,
  cranker,
  vote,
  mint,
  dbcConfig,
  venue,
  slice,
  minAmountOut,
  withInstructionsSysvar,
}: ExecuteBuybackInput): TransactionInstruction[] {
  checkProgramId(programId);
  const isDbc = venue.kind === 'dbc';
  const program = isDbc ? METEORA.DBC_PROGRAM_ID : METEORA.CP_AMM_PROGRAM_ID;
  const tokenVault = venue.tokenVault ?? findMeteoraVaultPda(program, mint, venue.pool);
  const quoteVault = venue.quoteVault ?? findMeteoraVaultPda(program, NATIVE_MINT, venue.pool);
  const keys = [
    signerWritable(cranker),
    readonly(poolKeys(programId).pool),
    writable(findRevenueTokenPda(programId, vote)[0]),
    writable(findBuybackEscrowPda(programId, vote)[0]),
    writable(findBuybackWsolPda(programId, vote)[0]),
    writable(findBuybackTokensPda(programId, vote)[0]),
    writable(mint),
    readonly(NATIVE_MINT),
    readonly(dbcConfig),
    writable(venue.pool),
    writable(tokenVault),
    writable(quoteVault),
    readonly(isDbc ? METEORA.DBC_POOL_AUTHORITY : METEORA.CP_AMM_POOL_AUTHORITY),
    readonly(isDbc ? METEORA.DBC_EVENT_AUTHORITY : METEORA.CP_AMM_EVENT_AUTHORITY),
    readonly(program),
    readonly(TOKEN_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
  ];
  if (withInstructionsSysvar) keys.push(readonly(INSTRUCTIONS_SYSVAR_ID));
  return instruction(programId, 'execute_buyback', keys, (w) => w.u8(slice, 'slice').u64(minAmountOut, 'minAmountOut'));
}

export interface RedeemInput extends WithProgram {
  holder: PublicKey;
  /** The holder's token account for `mint` (burned from). */
  holderTokens: PublicKey;
  vote: PublicKey;
  mint: PublicKey;
  /**
   * The Epoch treasury's token account for `mint` (a DBC leftover waiting to be burned), when it holds tokens: excluded
   * from circulation. Leaving it out only lowers the payout.
   */
  treasuryTokens?: PublicKey | null;
  amount: bigint;
}

/**
 * `redeem(amount)`: burn tokens for a pro-rata share of the buyback escrow. Signer: holder. Circulating supply is the
 * mint supply less the buyback and treasury token accounts; tokens in the Meteora pools count (excluding them let a
 * holder sell into the pool, redeem at an inflated rate and buy back).
 */
export function redeem({
  programId,
  holder,
  holderTokens,
  vote,
  mint,
  treasuryTokens,
  amount,
}: RedeemInput): TransactionInstruction[] {
  checkProgramId(programId);
  return instruction(
    programId,
    'redeem',
    [
      signerWritable(holder),
      writable(holderTokens),
      writable(findRevenueTokenPda(programId, vote)[0]),
      writable(findBuybackEscrowPda(programId, vote)[0]),
      readonly(findBuybackTokensPda(programId, vote)[0]),
      writable(mint),
      readonly(treasuryTokens ?? programId),
      readonly(TOKEN_PROGRAM_ID),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    (w) => w.u64(amount, 'amount'),
  );
}

/** `BuybackParams` (`configure_revenue_token`). */
export interface BuybackParams {
  /** u8, 1–32. */
  slicesPerEpoch: number;
  /** u32, ≥ slicesPerEpoch. */
  windowSlots: number;
  /** u16, 50–2,000. */
  maxSlippageBps: number;
  /** u16, 10–1,000. */
  maxImpactBps: number;
  /** u8, `REVENUE_TOKEN_FLAGS` bits. */
  flags: number;
}

export interface ConfigureRevenueTokenInput extends WithProgram {
  admin: PublicKey;
  vote: PublicKey;
  params: BuybackParams;
}

/** `configure_revenue_token(params)`: buyback schedule, protections and flags. Signer: the pool admin. */
export function configureRevenueToken({
  programId,
  admin,
  vote,
  params,
}: ConfigureRevenueTokenInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  return instruction(
    programId,
    'configure_revenue_token',
    [signer(admin), readonly(pool), writable(findRevenueTokenPda(programId, vote)[0])],
    (w) =>
      w
        .u8(params.slicesPerEpoch, 'slicesPerEpoch')
        .u32(params.windowSlots, 'windowSlots')
        .u16(params.maxSlippageBps, 'maxSlippageBps')
        .u16(params.maxImpactBps, 'maxImpactBps')
        .u8(params.flags, 'flags'),
  );
}

export interface CloseRevenueTokenInput extends WithProgram {
  cranker: PublicKey;
  vote: PublicKey;
  /** `revenue_token.operator`: receives the rent and dust. */
  operator: PublicKey;
  mint: PublicKey;
}

/**
 * `close_revenue_token()`: after the term, once the escrow is spent or, whatever it holds, once the redemption grace
 * period (`REDEEM_GRACE_EPOCHS`) is over; the unclaimed escrow then becomes pool income. Anyone may crank.
 */
export function closeRevenueToken({
  programId,
  cranker,
  vote,
  operator,
  mint,
}: CloseRevenueTokenInput): TransactionInstruction[] {
  checkProgramId(programId);
  const { pool, vault } = poolKeys(programId);
  return instruction(programId, 'close_revenue_token', [
    signer(cranker),
    writable(operator),
    writable(pool),
    writable(vault),
    writable(findRevenueTokenPda(programId, vote)[0]),
    writable(findBuybackEscrowPda(programId, vote)[0]),
    writable(findBuybackTokensPda(programId, vote)[0]),
    writable(mint),
    writable(findPositionPda(programId, vote)[0]),
    readonly(TOKEN_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

// ─── Partner treasury claims (Meteora) ─────────────────────────────────────
//
// Permissionless: the program signs the Meteora claim as the treasury PDA `["treasury", pool]`, books the SOL as pool
// income and burns the token side. The cranker pays the transaction fee and fronts the rent of the claim's token
// accounts (about 0.002 SOL each), which comes back in the same instruction.

/** The accounts every treasury claim starts with. */
function treasuryKeys(programId: PublicKey): {
  pool: PublicKey;
  vault: PublicKey;
  treasury: PublicKey;
  treasuryWsol: PublicKey;
} {
  const { pool, vault } = poolKeys(programId);
  return {
    pool,
    vault,
    treasury: findPartnerTreasuryPda(programId, pool)[0],
    treasuryWsol: findTreasuryWsolPda(programId, pool)[0],
  };
}

/** A DBC pool whose config names the treasury. Its vaults are derived (`["token_vault", mint, pool]`) when omitted. */
export interface DbcClaimPoolKeys {
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  /** The pool's base mint (the token). */
  mint: PublicKey;
  baseVault?: PublicKey;
  quoteVault?: PublicKey;
}

export interface ClaimPartnerTradingFeeInput extends WithProgram, DbcClaimPoolKeys {
  cranker: PublicKey;
}

/**
 * `claim_partner_trading_fee()`: DBC `claim_trading_fee` for the treasury. SOL → pool income; base tokens (pools that
 * collect fees in the output token) → burned. Anyone may crank.
 */
export function claimPartnerTradingFee({
  programId,
  cranker,
  dbcPool,
  dbcConfig,
  mint,
  baseVault,
  quoteVault,
}: ClaimPartnerTradingFeeInput): TransactionInstruction[] {
  const { pool, vault, treasury, treasuryWsol } = treasuryKeys(checkProgramId(programId));
  const dbc = METEORA.DBC_PROGRAM_ID;
  return instruction(programId, 'claim_partner_trading_fee', [
    signerWritable(cranker),
    writable(pool),
    writable(vault),
    readonly(treasury),
    writable(treasuryWsol),
    writable(findAssociatedTokenAddress(treasury, mint)),
    writable(dbcPool),
    readonly(dbcConfig),
    writable(baseVault ?? findMeteoraVaultPda(dbc, mint, dbcPool)),
    writable(quoteVault ?? findMeteoraVaultPda(dbc, NATIVE_MINT, dbcPool)),
    writable(mint),
    readonly(NATIVE_MINT),
    readonly(METEORA.DBC_POOL_AUTHORITY),
    readonly(METEORA.DBC_EVENT_AUTHORITY),
    readonly(dbc),
    readonly(TOKEN_PROGRAM_ID),
    readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

export interface ClaimPartnerQuoteInput extends WithProgram {
  cranker: PublicKey;
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  /** The pool's wrapped-SOL vault (derived when omitted). */
  quoteVault?: PublicKey;
}

function partnerQuoteClaim(
  name: 'claim_partner_surplus' | 'claim_partner_migration_fee',
  { programId, cranker, dbcPool, dbcConfig, quoteVault }: ClaimPartnerQuoteInput,
): TransactionInstruction[] {
  const { pool, vault, treasury, treasuryWsol } = treasuryKeys(checkProgramId(programId));
  const dbc = METEORA.DBC_PROGRAM_ID;
  return instruction(programId, name, [
    signerWritable(cranker),
    writable(pool),
    writable(vault),
    readonly(treasury),
    writable(treasuryWsol),
    writable(dbcPool),
    readonly(dbcConfig),
    writable(quoteVault ?? findMeteoraVaultPda(dbc, NATIVE_MINT, dbcPool)),
    readonly(NATIVE_MINT),
    readonly(METEORA.DBC_POOL_AUTHORITY),
    readonly(METEORA.DBC_EVENT_AUTHORITY),
    readonly(dbc),
    readonly(TOKEN_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

/** `claim_partner_surplus()`: the partner's share of a completed curve's surplus → pool income. Anyone may crank. */
export function claimPartnerSurplus(input: ClaimPartnerQuoteInput): TransactionInstruction[] {
  return partnerQuoteClaim('claim_partner_surplus', input);
}

/** `claim_partner_migration_fee()`: the partner's share of the DBC migration fee → pool income. Anyone may crank. */
export function claimPartnerMigrationFee(input: ClaimPartnerQuoteInput): TransactionInstruction[] {
  return partnerQuoteClaim('claim_partner_migration_fee', input);
}

export interface BurnLeftoverInput extends WithProgram {
  cranker: PublicKey;
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  /** The pool's base mint. */
  mint: PublicKey;
  /** The pool's base vault (derived when omitted). */
  baseVault?: PublicKey;
}

/**
 * `burn_leftover()`: DBC `withdraw_leftover` to the treasury (the receiver must be the treasury), then burn all of it;
 * after someone else withdrew it, burns what the treasury's token account holds. Anyone may crank.
 */
export function burnLeftover({
  programId,
  cranker,
  dbcPool,
  dbcConfig,
  mint,
  baseVault,
}: BurnLeftoverInput): TransactionInstruction[] {
  const { pool, treasury } = treasuryKeys(checkProgramId(programId));
  const dbc = METEORA.DBC_PROGRAM_ID;
  return instruction(programId, 'burn_leftover', [
    signerWritable(cranker),
    readonly(pool),
    readonly(treasury),
    writable(findAssociatedTokenAddress(treasury, mint)),
    writable(dbcPool),
    readonly(dbcConfig),
    writable(baseVault ?? findMeteoraVaultPda(dbc, mint, dbcPool)),
    writable(mint),
    readonly(METEORA.DBC_POOL_AUTHORITY),
    readonly(METEORA.DBC_EVENT_AUTHORITY),
    readonly(dbc),
    readonly(TOKEN_PROGRAM_ID),
    readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

export interface ClaimTreasuryLpFeeInput extends WithProgram {
  cranker: PublicKey;
  /** The DAMM v2 pool (token A = the token, token B = wrapped SOL). */
  dammPool: PublicKey;
  /** Token A's mint. */
  mint: PublicKey;
  /** A position in that pool whose NFT the treasury holds. */
  position: PublicKey;
  /** The position's NFT mint (`position.nft_mint`); its NFT account is derived from it unless given. */
  nftMint: PublicKey;
  positionNftAccount?: PublicKey;
  /** The pool's vaults (derived when omitted). */
  tokenAVault?: PublicKey;
  tokenBVault?: PublicKey;
}

/**
 * `claim_treasury_lp_fee()`: DAMM v2 `claim_position_fee` on a treasury-owned position. SOL → pool income, token A →
 * burned. Anyone may crank.
 */
export function claimTreasuryLpFee({
  programId,
  cranker,
  dammPool,
  mint,
  position,
  nftMint,
  positionNftAccount,
  tokenAVault,
  tokenBVault,
}: ClaimTreasuryLpFeeInput): TransactionInstruction[] {
  const { pool, vault, treasury, treasuryWsol } = treasuryKeys(checkProgramId(programId));
  const cpAmm = METEORA.CP_AMM_PROGRAM_ID;
  return instruction(programId, 'claim_treasury_lp_fee', [
    signerWritable(cranker),
    writable(pool),
    writable(vault),
    readonly(treasury),
    writable(treasuryWsol),
    writable(findAssociatedTokenAddress(treasury, mint)),
    readonly(dammPool),
    writable(position),
    readonly(positionNftAccount ?? findDammPositionNftAccount(nftMint)),
    writable(tokenAVault ?? findMeteoraVaultPda(cpAmm, mint, dammPool)),
    writable(tokenBVault ?? findMeteoraVaultPda(cpAmm, NATIVE_MINT, dammPool)),
    writable(mint),
    readonly(NATIVE_MINT),
    readonly(METEORA.CP_AMM_POOL_AUTHORITY),
    readonly(METEORA.CP_AMM_EVENT_AUTHORITY),
    readonly(cpAmm),
    readonly(TOKEN_PROGRAM_ID),
    readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

// ─── Units ─────────────────────────────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * SOL → lamports with exact decimal arithmetic: `'0.1'` → `100000000n`. Accepts a decimal string (optionally with an
 * exponent, e.g. `'1.5e-3'`) or a number (converted through its shortest decimal form, so pass strings for amounts a
 * float cannot represent). Throws on more than 9 decimal places (trailing zeros aside), negatives, or > u64::MAX.
 */
export function solToLamports(sol: number | string): bigint {
  let text: string;
  if (typeof sol === 'number') {
    if (!Number.isFinite(sol)) throw new RangeError(`solToLamports: ${sol} is not a finite number`);
    text = String(sol);
  } else if (typeof sol === 'string') {
    text = sol.trim();
  } else {
    throw new TypeError('solToLamports: expected a number or a decimal string');
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new RangeError(`solToLamports: '${text}' is not a decimal number`);
  }
  const [, sign, whole, fraction = '', exponent = '0'] = m;
  const digits = (whole + fraction).replace(/^0+/, '');
  // value = digits × 10^(exponent − fraction.length); lamports = value × 10^9.
  const scale = Number(exponent) - fraction.length + 9;
  let lamports: bigint;
  if (digits === '') {
    lamports = 0n;
  } else if (scale >= 0) {
    if (digits.length + scale > 20) throw new RangeError(`solToLamports: '${text}' exceeds u64::MAX lamports`);
    lamports = BigInt(digits) * 10n ** BigInt(scale);
  } else {
    const keep = digits.length + scale;
    const dropped = keep > 0 ? digits.slice(keep) : digits;
    if (/[^0]/.test(dropped)) throw new RangeError(`solToLamports: '${text}' has more than 9 decimal places`);
    lamports = keep > 0 ? BigInt(digits.slice(0, keep)) : 0n;
  }
  if (sign === '-' && lamports !== 0n) throw new RangeError(`solToLamports: '${text}' is negative`);
  if (lamports > U64_MAX) throw new RangeError(`solToLamports: '${text}' exceeds u64::MAX lamports`);
  return lamports;
}

/** Lamports → exact SOL decimal string without trailing zeros: `1500000000n` → `'1.5'`. */
export function lamportsToSolString(lamports: bigint): string {
  if (typeof lamports !== 'bigint') throw new TypeError('lamportsToSolString: expected a bigint');
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const fraction = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// ─── Validator history and the permissionless score ───────────────────────

export interface HistoryInput extends WithProgram {
  /** Any signer: pays the fee (and the rent for `initValidatorHistory`). */
  cranker: PublicKey;
  vote: PublicKey;
}

/** `init_validator_history`: creates `["history", vote]` (8,352 bytes, ~0.059 SOL rent). Signer: cranker (payer). */
export function initValidatorHistory({ programId, cranker, vote }: HistoryInput): TransactionInstruction[] {
  const [history] = findValidatorHistoryPda(programId, vote);
  return instruction(programId, 'init_validator_history', [
    signerWritable(cranker),
    readonly(vote),
    writable(history),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

/** `copy_vote_account`: credits (up to 64 epochs), commissions, newest vote, lamports and revenue. Permissionless. */
export function copyVoteAccount({ programId, cranker, vote }: HistoryInput): TransactionInstruction[] {
  const [history] = findValidatorHistoryPda(programId, vote);
  const [escrow] = findEscrowPda(programId, vote);
  return instruction(programId, 'copy_vote_account', [
    signer(cranker),
    writable(history),
    readonly(vote),
    readonly(escrow),
  ]);
}

export interface CopyDistributionInput extends HistoryInput {
  epoch: bigint;
}

/** `copy_tip_distribution_account(epoch)`: Jito MEV commission and tips; a no-op where the account does not exist. */
export function copyTipDistributionAccount({
  programId,
  cranker,
  vote,
  epoch,
}: CopyDistributionInput): TransactionInstruction[] {
  const [history] = findValidatorHistoryPda(programId, vote);
  const [account] = findTipDistributionPda(vote, epoch);
  return instruction(
    programId,
    'copy_tip_distribution_account',
    [signer(cranker), writable(history), readonly(account)],
    (w) => w.u64(epoch, 'epoch'),
  );
}

/** `copy_priority_fee_distribution(epoch)`: Jito priority-fee commission and lamports; no-op where absent. */
export function copyPriorityFeeDistribution({
  programId,
  cranker,
  vote,
  epoch,
}: CopyDistributionInput): TransactionInstruction[] {
  const [history] = findValidatorHistoryPda(programId, vote);
  const [account] = findPriorityFeeDistributionPda(vote, epoch);
  return instruction(
    programId,
    'copy_priority_fee_distribution',
    [signer(cranker), writable(history), readonly(account)],
    (w) => w.u64(epoch, 'epoch'),
  );
}

export interface StakeInfo {
  epoch: bigint;
  activatedStakeLamports: bigint;
  /** u32, 1 = largest stake. */
  rank: number;
  superminority: boolean;
}

export interface UpdateStakeInfoInput extends WithProgram {
  scorer: PublicKey;
  vote: PublicKey;
  info: StakeInfo;
}

/** `update_stake_info(epoch, activated_stake, rank, superminority)`: the one oracle input. Signer: the pool's scorer. */
export function updateStakeInfo({ programId, scorer, vote, info }: UpdateStakeInfoInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const [history] = findValidatorHistoryPda(programId, vote);
  return instruction(programId, 'update_stake_info', [signer(scorer), readonly(pool), writable(history)], (w) =>
    w
      .u64(info.epoch, 'epoch')
      .u64(info.activatedStakeLamports, 'activatedStakeLamports')
      .u32(info.rank, 'rank')
      .bool(info.superminority, 'superminority'),
  );
}

export interface RefreshScoreInput extends HistoryInput {
  /** The position's operator: the hedge counts its swaps. */
  operator: PublicKey;
  /** `ScoreConfig.market_maker`, or null when unset (then no swap accounts are passed). */
  marketMaker: PublicKey | null;
  /** The program cluster's current epoch: the hedge covers current + 1 … current + 5. */
  currentEpoch: bigint;
}

/** The swap PDAs `refresh_score` expects, in order: the operator's swap on the maker's quote for each epoch ahead. */
export function hedgeSwapAccounts(
  programId: PublicKey,
  marketMaker: PublicKey,
  operator: PublicKey,
  currentEpoch: bigint,
): PublicKey[] {
  const out: PublicKey[] = [];
  for (let i = 1; i <= PROGRAM_CONSTANTS.HEDGE_EPOCHS_AHEAD; i++) {
    const [quote] = findQuotePda(programId, marketMaker, currentEpoch + BigInt(i));
    out.push(findSwapPda(programId, quote, operator)[0]);
  }
  return out;
}

/** `refresh_score`: the Epoch Score from on-chain history. Permissionless; refuses stale history. */
export function refreshScore({
  programId,
  cranker,
  vote,
  operator,
  marketMaker,
  currentEpoch,
}: RefreshScoreInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const [scoreConfig] = findScoreConfigPda(programId, pool);
  const [position] = findPositionPda(programId, vote);
  const [history] = findValidatorHistoryPda(programId, vote);
  const swaps = marketMaker ? hedgeSwapAccounts(programId, marketMaker, operator, currentEpoch).map(readonly) : [];
  return instruction(programId, 'refresh_score', [
    signer(cranker),
    readonly(pool),
    readonly(scoreConfig),
    writable(position),
    writable(history),
    ...swaps,
  ]);
}

export interface ScoringParams {
  /** null: nobody is hedged. */
  marketMaker: PublicKey | null;
  /** u8, 1..=32. */
  creditsWindowEpochs: number;
  countBlockCommission: boolean;
  /** u16, 5,000..=10,000. */
  creditsReferenceBps: number;
  /** u32, 150..=216,000. */
  maxCopyAgeSlots: number;
}

export const DEFAULT_SCORING_PARAMS: Readonly<Omit<ScoringParams, 'marketMaker'>> = Object.freeze({
  creditsWindowEpochs: PROGRAM_CONSTANTS.DEFAULT_CREDITS_WINDOW_EPOCHS,
  countBlockCommission: false,
  creditsReferenceBps: PROGRAM_CONSTANTS.DEFAULT_CREDITS_REFERENCE_BPS,
  maxCopyAgeSlots: PROGRAM_CONSTANTS.DEFAULT_MAX_COPY_AGE_SLOTS,
});

export interface ConfigureScoringInput extends WithProgram {
  admin: PublicKey;
  params: ScoringParams;
}

/** `configure_scoring(params)`: creates or updates `["score_config", pool]`. Signer: the pool admin (payer). */
export function configureScoring({ programId, admin, params }: ConfigureScoringInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const [scoreConfig] = findScoreConfigPda(programId, pool);
  return instruction(
    programId,
    'configure_scoring',
    [signerWritable(admin), readonly(pool), writable(scoreConfig), readonly(SYSTEM_PROGRAM_ID)],
    (w) =>
      w
        .pubkey(params.marketMaker ?? PublicKey.default, 'marketMaker')
        .u8(params.creditsWindowEpochs, 'creditsWindowEpochs')
        .bool(params.countBlockCommission, 'countBlockCommission')
        .u16(params.creditsReferenceBps, 'creditsReferenceBps')
        .u32(params.maxCopyAgeSlots, 'maxCopyAgeSlots'),
  );
}
