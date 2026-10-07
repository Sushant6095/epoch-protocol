import { PublicKey } from '@solana/web3.js';

/** 32 raw bytes → base58 address. */
export const bytesToAddress = (bytes: Uint8Array): string => new PublicKey(bytes).toBase58();

/** Base58 address → its 32 raw bytes. Throws on an invalid address. */
export const addressToBytes = (address: string): Buffer => new PublicKey(address).toBuffer();

/** The program-derived address for `seeds` under `programId`, as base58. */
export const findProgramAddress = (seeds: (Buffer | Uint8Array)[], programId: string): string =>
  PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0].toBase58();

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_DIGITS = new Map([...BASE58_ALPHABET].map((char, i) => [char, i]));

/**
 * Base58 text of any length → bytes (instruction data in a JSON-encoded block, which RPC sends as base58). Throws on a
 * character outside the Bitcoin alphabet.
 */
export function base58ToBytes(text: string): Uint8Array {
  const littleEndian: number[] = [];
  for (const char of text) {
    let carry = BASE58_DIGITS.get(char);
    if (carry === undefined) throw new Error(`invalid base58 character '${char}'`);
    for (let i = 0; i < littleEndian.length; i++) {
      carry += littleEndian[i] * 58;
      littleEndian[i] = carry & 0xff;
      carry >>= 8;
    }
    for (; carry > 0; carry >>= 8) littleEndian.push(carry & 0xff);
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const out = new Uint8Array(zeros + littleEndian.length);
  for (let i = 0; i < littleEndian.length; i++) out[out.length - 1 - i] = littleEndian[i];
  return out;
}
