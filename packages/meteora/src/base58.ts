/**
 * Base58 (Bitcoin alphabet) for instruction data in RPC transaction responses. web3.js does not export its codec and
 * this package stays browser-safe, so this is a small standalone one.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));

/** Decodes a base58 string to bytes; throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = INDEX.get(char);
    if (digit === undefined) throw new RangeError(`not base58: ${JSON.stringify(char)}`);
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

/** Encodes bytes as base58. */
export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let text = '';
  while (value > 0n) {
    text = ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + text;
}
