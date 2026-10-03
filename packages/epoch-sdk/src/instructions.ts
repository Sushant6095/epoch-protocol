/**
 * Instruction builders for all 29 instructions in `programs/epoch/src/lib.rs`.
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
import { SIDES, type Side, type Tranche, TRANCHES, VOTE_PROGRAM_ID } from './constants';
import { INSTRUCTION_DISCRIMINATORS, type InstructionName } from './discriminators';
import {
  findAdvancePda,
  findEscrowPda,
  findFeeIndexPda,
  findLenderPda,
  findPoolPda,
  findPositionPda,
  findQuotePda,
  findSwapPda,
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

/** `update_score(update)`. Signer: the pool's scorer. */
export function updateScore({ programId, scorer, vote, update }: UpdateScoreInput): TransactionInstruction[] {
  const { pool } = poolKeys(programId);
  const [position] = findPositionPda(programId, vote);
  return instruction(programId, 'update_score', [signer(scorer), readonly(pool), writable(position)], (w) =>
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
}

/** `sweep()`: once per epoch per validator. Anyone may crank. */
export function sweep({ programId, cranker, vote, payout, openAdvance }: SweepInput): TransactionInstruction[] {
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
  ]);
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
}

/** `release_validator()`: hands the withdraw authority back and closes the position. Signer: operator. */
export function releaseValidator({
  programId,
  operator,
  vote,
  newWithdrawer,
  identity,
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
    readonly(identity),
    readonly(SYSVAR_CLOCK_PUBKEY),
    readonly(VOTE_PROGRAM_ID),
    readonly(SYSTEM_PROGRAM_ID),
  ]);
}

export interface UpdateCommissionInput extends WithProgram {
  operator: PublicKey;
  vote: PublicKey;
  /** u8: 0 = inflation rewards, 1 = block revenue (`COMMISSION_KIND`). The program rejects anything else. */
  kind: number;
  /** u16, bps. */
  commissionBps: number;
}

/** `update_commission(kind, commission_bps)`. Signer: operator. */
export function updateCommission({
  programId,
  operator,
  vote,
  kind,
  commissionBps,
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
}

/** `post_index(epoch, value, inputs_hash)`: the fee index PDA is derived from the pool PDA. Signer: publisher. */
export function postIndex({
  programId,
  publisher,
  epoch,
  value,
  inputsHash,
}: PostIndexInput): TransactionInstruction[] {
  const { feeIndex } = poolKeys(programId);
  return instruction(programId, 'post_index', [signer(publisher), writable(feeIndex)], (w) =>
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
