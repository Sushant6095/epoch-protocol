/**
 * Test-only loader for `rust-vectors.json`, written by `packages/epoch-sdk/vectors` from the real program crate.
 * Excluded from the build (tsconfig) — never import this from SDK source.
 */
import { PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface RustMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface RustAccountExample {
  label: string;
  serializedLen: number;
  data: string;
  fields: Record<string, unknown>;
  pushedRevenue?: string[];
  trailingRevenue?: string;
  pushedHistory?: { epoch: string; value: string }[];
  valueFor?: { epoch: string; value: string | null }[];
}

export interface RustAccountEntry {
  discriminator: string;
  initSpace: number;
  size: number;
  examples: RustAccountExample[];
}

export interface RustInstruction {
  name: string;
  label: string;
  programId: string;
  discriminator: string;
  data: string;
  args: Record<string, unknown>;
  accounts: Record<string, string | null>;
  context: Record<string, unknown>;
  metas: RustMeta[];
}

export interface RustEvent {
  name: string;
  label: string;
  discriminator: string;
  data: string;
  fields: Record<string, unknown>;
}

export interface RustPda {
  kind: string;
  inputs: Record<string, string>;
  address: string;
  bump: number;
}

export interface RustError {
  name: string;
  code: number;
  message: string;
}

export interface RustCase {
  args: unknown[];
  result: unknown;
}

export interface RustVectors {
  anchorLang: string;
  programId: string;
  declaredProgramId: string;
  errorCodeOffset: number;
  seeds: Record<string, string>;
  constants: Record<string, string | number>;
  accounts: Record<string, RustAccountEntry>;
  instructions: RustInstruction[];
  events: RustEvent[];
  pdas: RustPda[];
  errors: RustError[];
  math: Record<string, RustCase[]>;
}

export const vectors: RustVectors = JSON.parse(readFileSync(join(__dirname, 'rust-vectors.json'), 'utf8'));

export const key = (base58: string): PublicKey => new PublicKey(base58);

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));

/** `Junior` → `junior`, `ReceiveFixed` → `receiveFixed`: Rust variant name → SDK spelling. */
export const sdkEnum = <T extends string>(rustVariant: unknown): T =>
  `${String(rustVariant).charAt(0).toLowerCase()}${String(rustVariant).slice(1)}` as T;

const snake = (camel: string): string => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * An SDK value in the harness's JSON form: snake_case keys, Rust variant names, base58 pubkeys, decimal-string
 * 64-bit integers, hex byte arrays. Compared with `toEqual`, so missing or extra fields fail the test.
 */
export function toRustJson(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return hex(value);
  if (Array.isArray(value)) return value.map(toRustJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [snake(k), toRustJson(v)]));
  }
  throw new TypeError(`toRustJson: unsupported ${typeof value}`);
}
