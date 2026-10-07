/**
 * Reading the upgradeable BPF loader's accounts (public layout of `UpgradeableLoaderState`, bincode):
 *   Program     = u32 tag 2 · programdata address (32)                         → 36 bytes
 *   ProgramData = u32 tag 3 · slot u64 · Option<Pubkey> (1 + 32) · program bytes → 45-byte header
 *   Buffer      = u32 tag 1 · Option<Pubkey> (1 + 32) · program bytes           → 37-byte header
 */
import { createHash } from 'node:crypto';

import { PublicKey } from '@solana/web3.js';

export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
}

export interface ProgramDataInfo {
  slot: bigint;
  authority: PublicKey | null;
  /** Program bytes after the header (the account may be longer than the program: max-len). */
  bytes: Uint8Array;
}

export function parseProgramAccount(data: Uint8Array): PublicKey {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 36 || view.getUint32(0, true) !== 2) throw new Error('not an upgradeable Program account');
  return new PublicKey(data.subarray(4, 36));
}

export function parseProgramData(data: Uint8Array): ProgramDataInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 45 || view.getUint32(0, true) !== 3) throw new Error('not an upgradeable ProgramData account');
  const hasAuthority = data[12] === 1;
  return {
    slot: view.getBigUint64(4, true),
    authority: hasAuthority ? new PublicKey(data.subarray(13, 45)) : null,
    bytes: data.subarray(45),
  };
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Does the deployed program equal `so`? The program-data account holds the ELF followed by zeros up to max-len, so the
 * prefix must match and the rest must be zero.
 */
export function deployedMatches(programBytes: Uint8Array, so: Uint8Array): boolean {
  if (programBytes.length < so.length) return false;
  if (sha256(programBytes.subarray(0, so.length)) !== sha256(so)) return false;
  return programBytes.subarray(so.length).every((b) => b === 0);
}

/**
 * Was this build made for `programId`? `declare_id!` compiles the id into the binary. SBF code normally loads it as
 * four `lddw` 64-bit immediates (opcode 0x18; each immediate's low and high 32-bit halves sit 8 bytes apart in the
 * 16-byte instruction), so the 32 bytes are not contiguous; checked on the 7 Oct build. Rodata may also hold them raw.
 * A build for another id contains neither.
 */
export function soDeclaresId(so: Uint8Array, programId: PublicKey): boolean {
  const bin = Buffer.from(so.buffer, so.byteOffset, so.byteLength);
  const id = programId.toBuffer();
  if (bin.indexOf(id) >= 0) return true;
  for (let w = 0; w < 4; w++) {
    const lo = id.subarray(w * 8, w * 8 + 4);
    const hi = id.subarray(w * 8 + 4, w * 8 + 8);
    let found = false;
    for (let i = 0; i + 16 <= bin.length && !found; i += 8) {
      found = bin[i] === 0x18 && bin.subarray(i + 4, i + 8).equals(lo) && bin.subarray(i + 12, i + 16).equals(hi);
    }
    if (!found) return false;
  }
  return true;
}
