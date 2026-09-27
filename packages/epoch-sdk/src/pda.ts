import { SEEDS } from '@epoch/common';
import { PublicKey } from '@solana/web3.js';

const seed = (value: string) => Buffer.from(value);

export const findPoolPda = (programId: PublicKey) => PublicKey.findProgramAddressSync([seed(SEEDS.pool)], programId);

export const findVaultPda = (programId: PublicKey) => PublicKey.findProgramAddressSync([seed(SEEDS.vault)], programId);

export const findValidatorPositionPda = (programId: PublicKey, vote: PublicKey) =>
  PublicKey.findProgramAddressSync([seed(SEEDS.validator), vote.toBuffer()], programId);

export const findVoteAuthorityPda = (programId: PublicKey, vote: PublicKey) =>
  PublicKey.findProgramAddressSync([seed(SEEDS.voteAuthority), vote.toBuffer()], programId);

export const findFeeIndexPda = (programId: PublicKey, epoch: bigint) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(epoch);
  return PublicKey.findProgramAddressSync([seed(SEEDS.feeIndex), buf], programId);
};
