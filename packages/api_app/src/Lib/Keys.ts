import { base58Decode, base58Encode } from '@epoch/epoch-sdk';

/** The 32 raw bytes of a base58 public key, or null when `text` is not exactly one canonical 32-byte key. */
export function decodePublicKey(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length < 32 || text.length > 44) return null;
  try {
    const bytes = base58Decode(text);
    // Canonical only: no extra leading '1's (zero bytes) that would decode to the same 32 bytes.
    return bytes.length === 32 && base58Encode(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

/** True for a base58 32-byte key: a wallet, vote or stake account address. */
export const isPublicKey = (text: string): boolean => decodePublicKey(text) !== null;

/**
 * A 64-byte ed25519 signature sent as base58 (what most Solana tools print) or base64 (standard or URL-safe,
 * padding optional). The two never collide: 64 bytes are 87–88 base58 characters but 86 base64 characters plus
 * optional `==`, and 86 base58 characters hold at most 63 bytes.
 */
export function decodeSignature(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 100) return null;
  try {
    const bytes = base58Decode(text);
    if (bytes.length === 64) return bytes;
  } catch {
    // not base58: try base64 below
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === 64 ? new Uint8Array(bytes) : null;
}
