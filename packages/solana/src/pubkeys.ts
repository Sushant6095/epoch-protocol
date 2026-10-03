import { PublicKey } from '@solana/web3.js';

/** 32 raw bytes → base58 address. */
export const bytesToAddress = (bytes: Uint8Array): string => new PublicKey(bytes).toBase58();

/** Base58 address → its 32 raw bytes. Throws on an invalid address. */
export const addressToBytes = (address: string): Buffer => new PublicKey(address).toBuffer();

/** The program-derived address for `seeds` under `programId`, as base58. */
export const findProgramAddress = (seeds: (Buffer | Uint8Array)[], programId: string): string =>
  PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0].toBase58();
