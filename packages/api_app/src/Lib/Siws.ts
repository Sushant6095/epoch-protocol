import { createPublicKey, verify } from 'crypto';

/**
 * Sign-In With Solana (request #7): the message format of Wallet Standard `solana:signIn` and Phantom's SIWS spec
 * (EIP-4361 style). Every line after the address is optional, the statement too, but the lines that are there must
 * come in this order:
 *
 *   ${domain} wants you to sign in with your Solana account:
 *   ${address}
 *
 *   ${statement}
 *
 *   URI: ${uri}
 *   Version: ${version}
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   Expiration Time: ${expirationTime}
 *   Not Before: ${notBefore}
 *   Request ID: ${requestId}
 *   Resources:
 *   - ${resources[0]}
 */
export interface SiwsFields {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

/** A message that is not a well-formed SIWS message. `message` says which line and why. */
export class SiwsParseError extends Error {}

export const SIWS_MAX_MESSAGE_LENGTH = 4_096;

type FieldKey = 'uri' | 'version' | 'chainId' | 'nonce' | 'issuedAt' | 'expirationTime' | 'notBefore' | 'requestId';

/** The optional fields in the order the spec writes them; `Resources:` always comes last. */
const FIELDS: readonly { key: FieldKey; label: string }[] = [
  { key: 'uri', label: 'URI' },
  { key: 'version', label: 'Version' },
  { key: 'chainId', label: 'Chain ID' },
  { key: 'nonce', label: 'Nonce' },
  { key: 'issuedAt', label: 'Issued At' },
  { key: 'expirationTime', label: 'Expiration Time' },
  { key: 'notBefore', label: 'Not Before' },
  { key: 'requestId', label: 'Request ID' },
];
const RESOURCES_LINE = 'Resources:';

const HEADER = /^(\S+) wants you to sign in with your Solana account:$/;
/** An RFC 3986 authority as the app sends it (`window.location.host`): a host name or IPv4 and an optional port. */
const DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;
/** EIP-4361 / SIWS: at least 8 alphanumeric characters. */
const NONCE = /^[A-Za-z0-9]{8,128}$/;
const CHAIN_ID = /^(?:solana:)?(?:mainnet|devnet|testnet|localnet)$/;
/** RFC 3339 date-time (ISO 8601 with an offset or Z). */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** True when `text` has a C0 control character other than the line feed, or DEL. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

function fail(reason: string): never {
  throw new SiwsParseError(reason);
}

const isFieldLine = (line: string): boolean =>
  line === RESOURCES_LINE || FIELDS.some((field) => line.startsWith(`${field.label}: `));

function checkUri(value: string, what: string): void {
  try {
    new URL(value);
  } catch {
    fail(`${what} is not a valid URI`);
  }
}

function checkDateTime(value: string, label: string): void {
  if (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) fail(`${label} is not an ISO 8601 date-time`);
}

function checkField(key: FieldKey, label: string, value: string): void {
  if (value.trim() !== value || value === '') fail(`${label} is empty or has extra spaces`);
  switch (key) {
    case 'uri':
      return checkUri(value, 'URI');
    case 'version':
      if (value !== '1') fail('Version must be 1');
      return;
    case 'chainId':
      if (!CHAIN_ID.test(value)) fail('Chain ID must be mainnet, devnet, testnet or localnet (optionally solana:…)');
      return;
    case 'nonce':
      if (!NONCE.test(value)) fail('Nonce must be 8 to 128 letters and digits');
      return;
    case 'issuedAt':
    case 'expirationTime':
    case 'notBefore':
      return checkDateTime(value, label);
    case 'requestId':
      return;
  }
}

/** Parses a SIWS message strictly: exact header, blank lines where the spec puts them, known fields in order. */
export function parseSiwsMessage(text: string): SiwsFields {
  if (typeof text !== 'string' || text.length === 0) fail('message is empty');
  if (text.length > SIWS_MAX_MESSAGE_LENGTH) fail(`message is longer than ${SIWS_MAX_MESSAGE_LENGTH} characters`);
  if (hasControlCharacter(text)) fail('message has control characters (only \\n line breaks are allowed)');

  const lines = text.split('\n');
  const header = HEADER.exec(lines[0]);
  if (!header) fail('line 1 must be "<domain> wants you to sign in with your Solana account:"');
  const domain = header[1];
  if (!DOMAIN.test(domain)) fail('the domain must be a host with an optional port, e.g. localhost:3000');
  if (lines.length < 2 || !/^\S+$/.test(lines[1])) fail('line 2 must be the address');
  const out: SiwsFields = { domain, address: lines[1] };

  let i = 2;
  if (i === lines.length) return out;
  if (lines[i] !== '') fail('line 3 must be blank');
  i++;
  if (i === lines.length) fail('the message ends with a blank line');
  if (!isFieldLine(lines[i])) {
    if (lines[i].trim() === '') fail(`line ${i + 1} must be the statement or the first field`);
    out.statement = lines[i];
    i++;
    if (i === lines.length) return out;
    if (lines[i] !== '') fail(`line ${i + 1} must be blank after the statement`);
    i++;
    if (i === lines.length) fail('the message ends with a blank line');
  }

  let previous = -1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === RESOURCES_LINE) {
      const resources: string[] = [];
      for (i++; i < lines.length; i++) {
        const item = /^- (.+)$/.exec(lines[i]);
        if (!item) fail(`line ${i + 1} must be "- <resource URI>" (Resources is the last field)`);
        checkUri(item[1], `resource on line ${i + 1}`);
        resources.push(item[1]);
      }
      out.resources = resources;
      break;
    }
    const index = FIELDS.findIndex((field) => line.startsWith(`${field.label}: `));
    if (index < 0) fail(`line ${i + 1} is not a SIWS field`);
    const { key, label } = FIELDS[index];
    if (index === previous) fail(`${label} appears twice`);
    if (index < previous) fail(`${label} is out of order (after ${FIELDS[previous].label})`);
    previous = index;
    const value = line.slice(label.length + 2);
    checkField(key, label, value);
    out[key] = value;
  }
  return out;
}

/** Builds the message text exactly as Wallet Standard's `createSignInMessageText` does (tests, docs). */
export function buildSiwsMessage(fields: SiwsFields): string {
  let message = `${fields.domain} wants you to sign in with your Solana account:\n${fields.address}`;
  if (fields.statement) message += `\n\n${fields.statement}`;
  const lines: string[] = [];
  for (const { key, label } of FIELDS) {
    const value = fields[key];
    if (value) lines.push(`${label}: ${value}`);
  }
  if (fields.resources) {
    lines.push(RESOURCES_LINE);
    for (const resource of fields.resources) lines.push(`- ${resource}`);
  }
  if (lines.length > 0) message += `\n\n${lines.join('\n')}`;
  return message;
}

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Checks a 64-byte ed25519 signature over `message` with a 32-byte public key (Node crypto, no dependency). */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
