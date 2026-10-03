import { generateKeyPairSync, sign } from 'crypto';

import { base58Encode } from '@epoch/epoch-sdk';

import { decodePublicKey, decodeSignature, isPublicKey } from './Keys';
import { buildSiwsMessage, parseSiwsMessage, SiwsParseError, type SiwsFields, verifyEd25519 } from './Siws';

/** A fresh ed25519 wallet: raw 32-byte public key, its base58 address and a signer. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return {
    raw,
    address: base58Encode(raw),
    sign: (text: string) => new Uint8Array(sign(null, Buffer.from(text, 'utf8'), privateKey)),
  };
}

const ADDRESS = '3oi7bCYXnkuyZ5UnUc7JRUJMe69jnVMcpggHN3RjZLDE';
const FULL: SiwsFields = {
  domain: 'localhost:3000',
  address: ADDRESS,
  statement: 'Sign in to Epoch. This request will not send a transaction or cost any SOL.',
  uri: 'http://localhost:3000',
  version: '1',
  chainId: 'mainnet',
  nonce: 'Q8m3yJwV2kX9pL4t',
  issuedAt: '2026-10-03T01:05:00+05:30',
  expirationTime: '2026-10-03T01:15:00+05:30',
  notBefore: '2026-10-03T01:04:00+05:30',
  requestId: 'req-42',
  resources: ['https://epoch.app/terms', 'https://epoch.app/privacy'],
};

const FULL_TEXT = [
  'localhost:3000 wants you to sign in with your Solana account:',
  ADDRESS,
  '',
  'Sign in to Epoch. This request will not send a transaction or cost any SOL.',
  '',
  'URI: http://localhost:3000',
  'Version: 1',
  'Chain ID: mainnet',
  'Nonce: Q8m3yJwV2kX9pL4t',
  'Issued At: 2026-10-03T01:05:00+05:30',
  'Expiration Time: 2026-10-03T01:15:00+05:30',
  'Not Before: 2026-10-03T01:04:00+05:30',
  'Request ID: req-42',
  'Resources:',
  '- https://epoch.app/terms',
  '- https://epoch.app/privacy',
].join('\n');

const reason = (text: string): string => {
  try {
    parseSiwsMessage(text);
  } catch (error) {
    if (error instanceof SiwsParseError) return error.message;
    throw error;
  }
  throw new Error('expected a parse error');
};

describe('parseSiwsMessage', () => {
  it('parses a message with every field, and builds the same text back', () => {
    expect(buildSiwsMessage(FULL)).toBe(FULL_TEXT);
    expect(parseSiwsMessage(FULL_TEXT)).toEqual(FULL);
  });

  it('accepts just the header and the address', () => {
    const text = `epoch.vercel.app wants you to sign in with your Solana account:\n${ADDRESS}`;
    expect(parseSiwsMessage(text)).toEqual({ domain: 'epoch.vercel.app', address: ADDRESS });
  });

  it('accepts a statement without fields, and fields without a statement', () => {
    const header = `localhost:3000 wants you to sign in with your Solana account:\n${ADDRESS}`;
    expect(parseSiwsMessage(`${header}\n\nHello`)).toEqual({
      domain: 'localhost:3000',
      address: ADDRESS,
      statement: 'Hello',
    });
    expect(parseSiwsMessage(`${header}\n\nNonce: abcdefgh12`)).toEqual({
      domain: 'localhost:3000',
      address: ADDRESS,
      nonce: 'abcdefgh12',
    });
  });

  it('accepts each optional field on its own', () => {
    const optional: (keyof SiwsFields)[] = [
      'statement',
      'uri',
      'version',
      'chainId',
      'nonce',
      'issuedAt',
      'expirationTime',
      'notBefore',
      'requestId',
      'resources',
    ];
    for (const key of optional) {
      const fields = { domain: FULL.domain, address: FULL.address, [key]: FULL[key] } as SiwsFields;
      expect(parseSiwsMessage(buildSiwsMessage(fields))).toEqual(fields);
    }
  });

  it('accepts devnet and solana:-prefixed chains, UTC times with fractions, and an empty Resources list', () => {
    const fields: SiwsFields = {
      domain: 'app.epoch.test',
      address: ADDRESS,
      chainId: 'solana:devnet',
      issuedAt: '2026-10-02T19:35:00.123Z',
      resources: [],
    };
    expect(parseSiwsMessage(buildSiwsMessage(fields))).toEqual(fields);
  });

  it('rejects a wrong or missing header and a missing address', () => {
    expect(reason(FULL_TEXT.replace('Solana account', 'Ethereum account'))).toMatch(/line 1/);
    expect(reason(`Sign in please\n${ADDRESS}`)).toMatch(/line 1/);
    expect(reason('localhost:3000 wants you to sign in with your Solana account:')).toMatch(/line 2/);
    expect(reason('localhost:3000 wants you to sign in with your Solana account:\n')).toMatch(/line 2/);
    expect(reason(`http://localhost:3000/x wants you to sign in with your Solana account:\n${ADDRESS}`)).toMatch(
      /domain/,
    );
  });

  it('rejects missing and extra lines', () => {
    const lines = FULL_TEXT.split('\n');
    // no blank line between the address and the statement
    expect(reason([...lines.slice(0, 2), ...lines.slice(3)].join('\n'))).toMatch(/line 3 must be blank/);
    // no blank line between the statement and the fields
    expect(reason([...lines.slice(0, 4), ...lines.slice(5)].join('\n'))).toMatch(/blank after the statement/);
    // an unknown field
    expect(reason([...lines.slice(0, 7), 'Chain: mainnet', ...lines.slice(7)].join('\n'))).toMatch(
      /line 8 is not a SIWS field/,
    );
    // a blank line among the fields, a trailing newline, a dangling blank line
    expect(reason([...lines.slice(0, 7), '', ...lines.slice(7)].join('\n'))).toMatch(/not a SIWS field/);
    expect(reason(`${FULL_TEXT}\n`)).toMatch(/must be "- <resource URI>"/);
    expect(reason(`localhost:3000 wants you to sign in with your Solana account:\n${ADDRESS}\n`)).toMatch(
      /ends with a blank line/,
    );
    // a second statement line
    expect(reason([...lines.slice(0, 4), 'More words', '', ...lines.slice(5)].join('\n'))).toMatch(
      /blank after the statement/,
    );
    // Windows line breaks and other control characters
    expect(reason(FULL_TEXT.replace(/\n/g, '\r\n'))).toMatch(/control characters/);
    expect(reason(FULL_TEXT.replace('Sign in to', 'Sign in\tto'))).toMatch(/control characters/);
    expect(reason(FULL_TEXT.replace('req-42', 'req-42\u0000'))).toMatch(/control characters/);
  });

  it('rejects fields out of order or repeated, and anything after Resources', () => {
    const lines = FULL_TEXT.split('\n');
    const nonce = lines.indexOf('Nonce: Q8m3yJwV2kX9pL4t');
    const swapped = [...lines];
    [swapped[nonce], swapped[nonce - 1]] = [swapped[nonce - 1], swapped[nonce]];
    expect(reason(swapped.join('\n'))).toMatch(/Chain ID is out of order \(after Nonce\)/);
    expect(reason([...lines.slice(0, nonce + 1), lines[nonce], ...lines.slice(nonce + 1)].join('\n'))).toMatch(
      /Nonce appears twice/,
    );
    expect(reason(`${FULL_TEXT}\nVersion: 1`)).toMatch(/must be "- <resource URI>"/);
  });

  it('rejects bad field values', () => {
    const swap = (from: string, to: string) => reason(FULL_TEXT.replace(from, to));
    expect(swap('Version: 1', 'Version: 2')).toMatch(/Version must be 1/);
    expect(swap('Chain ID: mainnet', 'Chain ID: ethereum')).toMatch(/Chain ID/);
    expect(swap('Nonce: Q8m3yJwV2kX9pL4t', 'Nonce: short')).toMatch(/Nonce/);
    expect(swap('Nonce: Q8m3yJwV2kX9pL4t', 'Nonce: has-dashes-1234')).toMatch(/Nonce/);
    expect(swap('Issued At: 2026-10-03T01:05:00+05:30', 'Issued At: yesterday')).toMatch(/Issued At/);
    expect(swap('Expiration Time: 2026-10-03T01:15:00+05:30', 'Expiration Time: 2026-13-45T99:00:00Z')).toMatch(
      /Expiration Time/,
    );
    expect(swap('Not Before: 2026-10-03T01:04:00+05:30', 'Not Before: 2026-10-03 01:04')).toMatch(/Not Before/);
    expect(swap('URI: http://localhost:3000', 'URI: not a uri')).toMatch(/URI/);
    expect(swap('- https://epoch.app/terms', '- terms')).toMatch(/resource/);
    expect(swap('Request ID: req-42', 'Request ID:  req-42')).toMatch(/extra spaces/);
  });
});

describe('keys and signatures', () => {
  it('accepts canonical 32-byte base58 keys only', () => {
    expect(isPublicKey(ADDRESS)).toBe(true);
    expect(decodePublicKey(ADDRESS)).toHaveLength(32);
    expect(isPublicKey('11111111111111111111111111111111')).toBe(true); // the system program: 32 zero bytes
    expect(isPublicKey(`1${ADDRESS}`)).toBe(false); // an extra leading zero byte
    expect(isPublicKey(ADDRESS.slice(0, 40))).toBe(false);
    expect(isPublicKey(ADDRESS.replace('o', '0'))).toBe(false); // 0 is not base58
    expect(isPublicKey('')).toBe(false);
    // The handover's demo wallet is not a real key: it decodes to 33 bytes.
    expect(isPublicKey('tFPVqpVspft3xEmA9cEYZ23zNt4aCKTkK9maKoVDBDFt')).toBe(false);
  });

  it('decodes 64-byte signatures in base58, base64 and base64url, and nothing else', () => {
    const bytes = new Uint8Array(64).map((_, i) => (i * 37 + 11) % 256);
    expect(decodeSignature(base58Encode(bytes))).toEqual(bytes);
    const b64 = Buffer.from(bytes).toString('base64');
    expect(decodeSignature(b64)).toEqual(bytes);
    expect(decodeSignature(b64.replace(/=+$/, ''))).toEqual(bytes);
    expect(decodeSignature(Buffer.from(bytes).toString('base64url'))).toEqual(bytes);
    expect(decodeSignature(Buffer.from(bytes.subarray(0, 63)).toString('base64'))).toBeNull();
    expect(decodeSignature(base58Encode(bytes.subarray(0, 32)))).toBeNull();
    expect(decodeSignature('not a signature!')).toBeNull();
    expect(decodeSignature('')).toBeNull();
  });

  it('verifies an ed25519 signature over the UTF-8 message with Node crypto', () => {
    const alice = wallet();
    const bob = wallet();
    const text = buildSiwsMessage({ ...FULL, address: alice.address, statement: 'Sign in ✓ — no SOL moves' });
    const signature = alice.sign(text);
    expect(decodePublicKey(alice.address)).toEqual(alice.raw);
    expect(verifyEd25519(Buffer.from(text, 'utf8'), signature, alice.raw)).toBe(true);
    expect(verifyEd25519(Buffer.from(`${text} `, 'utf8'), signature, alice.raw)).toBe(false);
    expect(verifyEd25519(Buffer.from(text, 'utf8'), signature, bob.raw)).toBe(false);
    expect(verifyEd25519(Buffer.from(text, 'utf8'), signature.subarray(0, 63), alice.raw)).toBe(false);
    expect(verifyEd25519(Buffer.from(text, 'utf8'), signature, alice.raw.subarray(0, 31))).toBe(false);
  });
});
