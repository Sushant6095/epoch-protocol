/**
 * The Epoch program side of a launch, through `@epoch/epoch-sdk` (ADR 0006): the program's treasury PDA the DBC config
 * must name as fee claimer (and leftover receiver), the reads the pre-flight needs (the program, the Pool, the
 * validator's position and vote account, an existing `RevenueToken`), and `register_revenue_token`, which the
 * validator's operator signs. Used by `launch-revenue-token.ts` and `register-revenue-token.ts`.
 */
import {
  decodePool,
  decodeRevenueToken,
  decodeValidatorPosition,
  findBuybackEscrowPda,
  findBuybackTokensPda,
  findPartnerTreasuryPda,
  findPoolPda,
  findPositionPda,
  findRevenueTokenPda,
  findVoteAuthPda,
  PROGRAM_CONSTANTS,
  registerRevenueToken,
  type RevenueTokenAccount,
} from '@epoch/epoch-sdk';
import { type Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';

import { rentExemptLamports, type RevenueTokenLimits, type ValidatorPositionState } from '../src';

/** The program's accounts every launch uses: the Pool PDA `["pool"]` and the partner treasury `["treasury", pool]`. */
export interface EpochProgramKeys {
  programId: PublicKey;
  pool: PublicKey;
  treasury: PublicKey;
}

export function epochProgramKeys(programId: PublicKey): EpochProgramKeys {
  const [pool] = findPoolPda(programId);
  const [treasury] = findPartnerTreasuryPda(programId, pool);
  return { programId, pool, treasury };
}

/** The token's PDAs under the program: `["revenue_token", vote]` and the buyback escrow `["buyback", vote]`. */
export function revenueTokenAccounts(
  keys: EpochProgramKeys,
  vote: PublicKey,
): { revenueToken: PublicKey; escrow: PublicKey } {
  return {
    revenueToken: findRevenueTokenPda(keys.programId, vote)[0],
    escrow: findBuybackEscrowPda(keys.programId, vote)[0],
  };
}

/** `register_revenue_token`'s limits, from the SDK's mirror of the program constants. */
export const REVENUE_TOKEN_LIMITS: RevenueTokenLimits = {
  minShareBps: PROGRAM_CONSTANTS.MIN_SHARE_BPS,
  maxShareBps: PROGRAM_CONSTANTS.MAX_SHARE_BPS,
  minTermEpochs: PROGRAM_CONSTANTS.MIN_TERM_EPOCHS,
  maxTermEpochs: PROGRAM_CONSTANTS.MAX_TERM_EPOCHS,
};

/** Rent the operator pays at registration: the `RevenueToken` (503 bytes), the escrow and its token account. */
export const REGISTRATION_RENT_LAMPORTS = rentExemptLamports(503) + rentExemptLamports(0) + rentExemptLamports(165);

/** The vote account's authorized withdrawer (VoteState: a 4-byte version tag, the node pubkey, then the withdrawer). */
export function voteWithdrawer(data: Uint8Array): PublicKey | null {
  return data.length >= 68 ? new PublicKey(data.subarray(36, 68)) : null;
}

export interface EpochProgramRead {
  program: { executable: boolean } | null;
  pool: { address: string; exists: boolean; paused: boolean | null };
  position: ValidatorPositionState | null;
  /** The validator's `RevenueToken`, when it has one already. */
  revenueToken: { address: PublicKey; account: RevenueTokenAccount } | null;
  /** The cluster's epoch now: a registration now starts the term with the next one. */
  epoch: number;
}

/** Reads the program, the Pool, the validator's position and vote account, and its `RevenueToken`, in one round trip. */
export async function readEpochProgram(
  connection: Connection,
  keys: EpochProgramKeys,
  vote: PublicKey | null,
): Promise<EpochProgramRead> {
  const position = vote ? findPositionPda(keys.programId, vote)[0] : null;
  const revenueToken = vote ? findRevenueTokenPda(keys.programId, vote)[0] : null;
  const [accounts, epochInfo] = await Promise.all([
    connection.getMultipleAccountsInfo(
      [keys.programId, keys.pool, ...(vote && position && revenueToken ? [position, vote, revenueToken] : [])],
      'confirmed',
    ),
    connection.getEpochInfo('confirmed'),
  ]);
  const [programInfo, poolInfo, positionInfo, voteInfo, revenueTokenInfo] = accounts;
  const owned = (info: (typeof accounts)[number] | undefined) =>
    info && info.owner.equals(keys.programId) ? info : null;
  const pool = owned(poolInfo);
  const positionAccount = owned(positionInfo);
  const decodedPosition = positionAccount ? decodeValidatorPosition(positionAccount.data) : null;
  const revenueTokenAccount = owned(revenueTokenInfo);
  const withdrawer = voteInfo ? voteWithdrawer(voteInfo.data) : null;
  return {
    program: programInfo ? { executable: programInfo.executable } : null,
    pool: {
      address: keys.pool.toBase58(),
      exists: !!pool,
      paused: pool ? decodePool(pool.data).paused : null,
    },
    position:
      decodedPosition && vote && position
        ? {
            address: position.toBase58(),
            status: decodedPosition.status,
            operator: decodedPosition.operator.toBase58(),
            revenueToken: decodedPosition.revenueToken?.toBase58() ?? null,
            authorityHeld: !!withdrawer && withdrawer.equals(findVoteAuthPda(keys.programId, vote)[0]),
          }
        : null,
    revenueToken:
      revenueToken && revenueTokenAccount
        ? { address: revenueToken, account: decodeRevenueToken(revenueTokenAccount.data) }
        : null,
    epoch: epochInfo.epoch,
  };
}

export interface RegistrationPlan {
  instruction: TransactionInstruction;
  operator: PublicKey;
  vote: PublicKey;
  mint: PublicKey;
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  revenueToken: PublicKey;
  escrow: PublicKey;
  escrowTokens: PublicKey;
}

/** `register_revenue_token(share_bps, term_epochs)` for a launched token, signed and paid by the position's operator. */
export function planRegistration(params: {
  keys: EpochProgramKeys;
  operator: PublicKey;
  vote: PublicKey;
  mint: PublicKey;
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  shareBps: number;
  termEpochs: number;
}): RegistrationPlan {
  const { keys, vote } = params;
  const [instruction] = registerRevenueToken({
    programId: keys.programId,
    operator: params.operator,
    vote,
    mint: params.mint,
    dbcPool: params.dbcPool,
    dbcConfig: params.dbcConfig,
    shareBps: params.shareBps,
    termEpochs: params.termEpochs,
  });
  return {
    instruction,
    operator: params.operator,
    vote,
    mint: params.mint,
    dbcPool: params.dbcPool,
    dbcConfig: params.dbcConfig,
    revenueToken: findRevenueTokenPda(keys.programId, vote)[0],
    escrow: findBuybackEscrowPda(keys.programId, vote)[0],
    escrowTokens: findBuybackTokensPda(keys.programId, vote)[0],
  };
}

/** Labels for the registration's accounts, for the operator to check before signing. */
export function registrationLabels(plan: RegistrationPlan, keys: EpochProgramKeys): Map<string, string> {
  return new Map([
    [plan.operator.toBase58(), "the validator's operator: signs and pays the rent"],
    [keys.pool.toBase58(), 'Epoch Pool'],
    [findPositionPda(keys.programId, plan.vote)[0].toBase58(), 'ValidatorPosition ["position", vote]'],
    [plan.vote.toBase58(), 'vote account'],
    [findVoteAuthPda(keys.programId, plan.vote)[0].toBase58(), 'vote_auth PDA: holds the withdraw authority'],
    [plan.mint.toBase58(), 'token mint'],
    [plan.dbcPool.toBase58(), 'DBC pool'],
    [plan.dbcConfig.toBase58(), 'DBC config'],
    ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token program'],
    ['11111111111111111111111111111111', 'System program'],
    [plan.revenueToken.toBase58(), 'RevenueToken, new account ["revenue_token", vote]'],
    [plan.escrow.toBase58(), 'buyback escrow ["buyback", vote]'],
    [plan.escrowTokens.toBase58(), 'escrow token account, new ["buyback_tokens", vote]'],
    [keys.treasury.toBase58(), 'Epoch treasury PDA ["treasury", pool]: must be the DBC fee claimer'],
    [keys.programId.toBase58(), 'Epoch program'],
  ]);
}

/**
 * What the operator signs, printed in full when the launch does not hold the operator key: the program, every account
 * (in order, with its flags) and the instruction data, so any wallet or multisig can build the same transaction.
 */
export function registrationLines(plan: RegistrationPlan, labels: Map<string, string>): string[] {
  const ix = plan.instruction;
  const lines = [`  program ${ix.programId.toBase58()} (Epoch) · instruction register_revenue_token`];
  ix.keys.forEach((meta, i) => {
    const flags = [meta.isSigner ? 'signer' : '', meta.isWritable ? 'writable' : ''].filter(Boolean).join(', ');
    const label = labels.get(meta.pubkey.toBase58());
    lines.push(
      `  ${String(i).padStart(2)} ${meta.pubkey.toBase58().padEnd(44)}  ${[label, flags].filter(Boolean).join(' · ')}`,
    );
  });
  lines.push(`  data (base64) ${Buffer.from(ix.data).toString('base64')}`);
  return lines;
}

/** A transaction for the registration alone (the operator is the fee payer). */
export function registrationTransaction(plan: RegistrationPlan): Transaction {
  const tx = new Transaction().add(plan.instruction);
  tx.feePayer = plan.operator;
  return tx;
}

/** After registration: the program's record of the token (start and end of the term, the commission snapshot). */
export async function readRegistered(
  connection: Connection,
  revenueToken: PublicKey,
): Promise<RevenueTokenAccount | null> {
  const info = await connection.getAccountInfo(revenueToken, 'confirmed');
  return info ? decodeRevenueToken(info.data) : null;
}
