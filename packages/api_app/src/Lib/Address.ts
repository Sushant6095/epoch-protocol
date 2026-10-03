import { base58Decode } from '@epoch/epoch-sdk';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True for a base58 string that decodes to 32 bytes: a Solana address (wallet, vote or stake account). */
export function isAddress(value: string): boolean {
  if (!BASE58.test(value)) return false;
  try {
    return base58Decode(value).length === 32;
  } catch {
    return false;
  }
}
