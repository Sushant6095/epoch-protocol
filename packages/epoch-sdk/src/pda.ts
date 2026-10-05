/**
 * Program-derived addresses, seed for seed as in the program's `#[account(seeds = …)]` constraints.
 * Each Epoch finder returns `[address, bump]` (`PublicKey.findProgramAddressSync`); the associated-token and DAMM v2
 * helpers the treasury claims use return the address only.
 */
import { PublicKey } from '@solana/web3.js';

import { u64ToLeBytes } from './borsh';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CP_AMM_POSITION_NFT_ACCOUNT_SEED,
  METEORA,
  NATIVE_MINT,
  SEEDS,
  TOKEN_PROGRAM_ID,
  TRANCHES,
  type Tranche,
} from './constants';

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
  revenueToken: ascii(SEEDS.revenueToken),
  buyback: ascii(SEEDS.buyback),
  buybackWsol: ascii(SEEDS.buybackWsol),
  buybackTokens: ascii(SEEDS.buybackTokens),
  partnerTreasury: ascii(SEEDS.partnerTreasury),
  treasuryWsol: ascii(SEEDS.treasuryWsol),
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

/** `["revenue_token", vote]`: a validator's revenue token. */
export function findRevenueTokenPda(programId: PublicKey, vote: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.revenueToken, vote.toBytes()], programId);
}

/** `["buyback", vote]`: the system-owned buyback escrow (sweeps pay the share into it; it pays the swaps). */
export function findBuybackEscrowPda(programId: PublicKey, vote: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.buyback, vote.toBytes()], programId);
}

/** `["buyback_wsol", vote]`: the wrapped-SOL account one buyback slice creates and closes. */
export function findBuybackWsolPda(programId: PublicKey, vote: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.buybackWsol, vote.toBytes()], programId);
}

/** `["buyback_tokens", vote]`: the escrow's token account the swaps pay into (burned every slice). */
export function findBuybackTokensPda(programId: PublicKey, vote: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.buybackTokens, vote.toBytes()], programId);
}

/**
 * `["treasury", pool]`: the Epoch partner treasury. It must be the `fee_claimer` (and should be the
 * `leftover_receiver`) of every revenue token's DBC config.
 */
export function findPartnerTreasuryPda(programId: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.partnerTreasury, pool.toBytes()], programId);
}

/** `["treasury_wsol", pool]`: the wrapped-SOL account one treasury claim creates and closes. */
export function findTreasuryWsolPda(programId: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.treasuryWsol, pool.toBytes()], programId);
}

/** `wallet`'s SPL Token associated token account for `mint`. */
export function findAssociatedTokenAddress(wallet: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [wallet.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * The partner treasury's token account for `mint`: its associated token account, where DBC sends the leftover and
 * where treasury claims receive (and burn) the token side.
 */
export function findTreasuryTokensAddress(programId: PublicKey, mint: PublicKey): PublicKey {
  const [pool] = findPoolPda(programId);
  return findAssociatedTokenAddress(findPartnerTreasuryPda(programId, pool)[0], mint);
}

const DBC_POOL_SEED = ascii('pool');

/** Byte-wise comparison of two keys, as Rust orders `Pubkey`s. */
function compareKeys(a: PublicKey, b: PublicKey): number {
  const x = a.toBytes();
  const y = b.toBytes();
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * A DBC curve's pool: `["pool", config, max(base, quote), min(base, quote)]` under the DBC program, so a launch's pool
 * follows from its mint and config (wrapped SOL is the quote of every revenue token).
 */
export function findDbcPoolPda(config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey = NATIVE_MINT): PublicKey {
  const [hi, lo] = compareKeys(baseMint, quoteMint) > 0 ? [baseMint, quoteMint] : [quoteMint, baseMint];
  return PublicKey.findProgramAddressSync(
    [DBC_POOL_SEED, config.toBytes(), hi.toBytes(), lo.toBytes()],
    METEORA.DBC_PROGRAM_ID,
  )[0];
}

const POSITION_NFT_ACCOUNT_SEED = ascii(CP_AMM_POSITION_NFT_ACCOUNT_SEED);
const DAMM_POSITION_SEED = ascii('position');

/** DAMM v2 `["position", nft_mint]`: the position a position NFT controls. */
export function findDammPositionPda(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([DAMM_POSITION_SEED, nftMint.toBytes()], METEORA.CP_AMM_PROGRAM_ID)[0];
}

/** DAMM v2 `["position_nft_account", nft_mint]`: the Token-2022 account holding a position NFT. */
export function findDammPositionNftAccount(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([POSITION_NFT_ACCOUNT_SEED, nftMint.toBytes()], METEORA.CP_AMM_PROGRAM_ID)[0];
}
