/**
 * Program-derived addresses, seed for seed as in the program's `#[account(seeds = …)]` constraints.
 * Each finder returns `[address, bump]` (`PublicKey.findProgramAddressSync`).
 */
import { PublicKey } from '@solana/web3.js';

import { u64ToLeBytes } from './borsh';
import { SEEDS, TRANCHES, type Tranche } from './constants';

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

const SEED = {
  pool: ascii(SEEDS.pool),
  vault: ascii(SEEDS.vault),
  lender: ascii(SEEDS.lender),
  withdraw: ascii(SEEDS.withdraw),
  position: ascii(SEEDS.position),
  voteAuth: ascii(SEEDS.voteAuth),
  escrow: ascii(SEEDS.escrow),
  advance: ascii(SEEDS.advance),
  feeIndex: ascii(SEEDS.feeIndex),
  quote: ascii(SEEDS.quote),
  swap: ascii(SEEDS.swap),
};

function trancheSeed(tranche: Tranche): Uint8Array {
  const index = TRANCHES.indexOf(tranche);
  if (index < 0) throw new TypeError(`Invalid tranche '${String(tranche)}'; expected 'senior' or 'junior'`);
  return Uint8Array.of(index);
}

/** `["pool"]`: the single lending pool. */
export function findPoolPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.pool], programId);
}

/** `["vault", pool]`: the pool's system-owned SOL vault. */
export function findVaultPda(programId: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.vault, pool.toBytes()], programId);
}

/** `["lender", pool, owner, [tranche]]`: a lender's shares in one tranche (senior = 0, junior = 1). */
export function findLenderPda(
  programId: PublicKey,
  pool: PublicKey,
  owner: PublicKey,
  tranche: Tranche,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED.lender, pool.toBytes(), owner.toBytes(), trancheSeed(tranche)],
    programId,
  );
}

/** `["withdraw", pool, seq_le_u64]`: a queued withdrawal; `seq` is `pool.withdraw_tail` when it was requested. */
export function findWithdrawRequestPda(
  programId: PublicKey,
  pool: PublicKey,
  seq: bigint | number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.withdraw, pool.toBytes(), u64ToLeBytes(seq, 'seq')], programId);
}

/** `["position", vote]`: an onboarded validator. */
export function findPositionPda(programId: PublicKey, vote: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.position, vote.toBytes()], programId);
}

/** `["vote_auth", vote]`: the program signer that holds the vote account's withdraw authority. */
export function findVoteAuthPda(programId: PublicKey, vote: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.voteAuth, vote.toBytes()], programId);
}

/** `["escrow", vote]`: the system-owned account both commission collectors point at. */
export function findEscrowPda(programId: PublicKey, vote: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.escrow, vote.toBytes()], programId);
}

/** `["advance", vote, seq_le_u64]`: one advance; `seq` is `position.advance_seq` when it was opened. */
export function findAdvancePda(programId: PublicKey, vote: PublicKey, seq: bigint | number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.advance, vote.toBytes(), u64ToLeBytes(seq, 'seq')], programId);
}

/** `["fee_index", pool]`: the Solana Fee Index. */
export function findFeeIndexPda(programId: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.feeIndex, pool.toBytes()], programId);
}

/** `["quote", maker, epoch_le_u64]`: a maker's quote for one epoch. */
export function findQuotePda(programId: PublicKey, maker: PublicKey, epoch: bigint | number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.quote, maker.toBytes(), u64ToLeBytes(epoch, 'epoch')], programId);
}

/** `["swap", quote, taker]`: a taker's position against one quote. */
export function findSwapPda(programId: PublicKey, quote: PublicKey, taker: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.swap, quote.toBytes(), taker.toBytes()], programId);
}
