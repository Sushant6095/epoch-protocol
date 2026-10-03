import { z } from '@epoch/common/pkg/zod';
import { PublicKey } from '@solana/web3.js';

/** True for a base58 string that decodes to a 32-byte public key (wallets, vote accounts, PDAs). */
export function isPublicKey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

const publicKey = (what: string) => z.string().refine(isPublicKey, { message: `${what} must be a base58 public key` });

export const VoteParamsDto = z.object({ vote: publicKey('vote') });
export type VoteParams = z.infer<typeof VoteParamsDto>;

export const AddressParamsDto = z.object({ address: publicKey('address') });
export type AddressParams = z.infer<typeof AddressParamsDto>;
