/**
 * The SDK against the Anchor IDL (`programs/epoch/idl/epoch.json`, generated from the program with Anchor's
 * `idl-build`): every instruction, account and event discriminator, the account sizes and the error table.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { ACCOUNT_SIZES } from './accounts';
import { ACCOUNT_DISCRIMINATORS, EVENT_DISCRIMINATORS, INSTRUCTION_DISCRIMINATORS } from './discriminators';
import { EPOCH_ERRORS } from './errors';

// web3.js loads its websocket client at import time; the SDK never opens one.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

type IdlType =
  string | { array: [IdlType, number] } | { option: IdlType } | { defined: { name: string } } | { vec: IdlType };
interface IdlField {
  name: string;
  type: IdlType;
}
interface IdlTypeDef {
  name: string;
  type:
    | { kind: 'struct'; fields?: IdlField[] }
    | { kind: 'enum'; variants: { name: string; fields?: (IdlField | IdlType)[] }[] };
}
interface Idl {
  address: string;
  metadata: { name: string };
  instructions: { name: string; discriminator: number[]; accounts: { name: string }[] }[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string; msg: string }[];
  types: IdlTypeDef[];
}

const idl: Idl = JSON.parse(readFileSync(join(__dirname, '../../../programs/epoch/idl/epoch.json'), 'utf8'));
const types = new Map(idl.types.map((t) => [t.name, t]));
const PRIMITIVE: Record<string, number> = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  pubkey: 32,
};

/** Anchor's `InitSpace` for an IDL type: fixed-size Borsh, an enum takes its largest variant. */
function space(t: IdlType): number {
  if (typeof t === 'string') {
    if (!(t in PRIMITIVE)) throw new Error(`unsized type ${t}`);
    return PRIMITIVE[t];
  }
  if ('array' in t) return space(t.array[0]) * t.array[1];
  if ('option' in t) return 1 + space(t.option);
  if ('defined' in t) {
    const def = types.get(t.defined.name);
    if (!def) throw new Error(`type ${t.defined.name} missing from the IDL`);
    if (def.type.kind === 'struct') return (def.type.fields ?? []).reduce((n, f) => n + space(f.type), 0);
    return (
      1 +
      Math.max(
        0,
        ...def.type.variants.map((v) =>
          (v.fields ?? []).reduce<number>((n, f) => n + space(typeof f === 'object' && 'name' in f ? f.type : f), 0),
        ),
      )
    );
  }
  throw new Error(`unsized type ${JSON.stringify(t)}`);
}

const bytes = (d: Uint8Array | readonly number[]): number[] => Array.from(d);

describe('the SDK matches the Anchor IDL', () => {
  it('is the epoch program', () => {
    expect(idl.metadata.name).toBe('epoch');
  });

  it('instruction discriminators', () => {
    const fromIdl = Object.fromEntries(idl.instructions.map((ix) => [ix.name, ix.discriminator]));
    const fromSdk = Object.fromEntries(
      Object.entries(INSTRUCTION_DISCRIMINATORS).map(([name, d]) => [name, bytes(d as Uint8Array)]),
    );
    expect(fromSdk).toEqual(fromIdl);
  });

  it('account discriminators and sizes (8 + InitSpace)', () => {
    const fromIdl = Object.fromEntries(
      idl.accounts.map((a) => [
        a.name,
        { discriminator: a.discriminator, size: 8 + space({ defined: { name: a.name } }) },
      ]),
    );
    const fromSdk = Object.fromEntries(
      Object.entries(ACCOUNT_DISCRIMINATORS).map(([name, d]) => [
        name,
        { discriminator: bytes(d as Uint8Array), size: ACCOUNT_SIZES[name as keyof typeof ACCOUNT_SIZES] },
      ]),
    );
    expect(fromSdk).toEqual(fromIdl);
    // The sizes deployed decoders rely on.
    expect(fromIdl.ValidatorPosition.size).toBe(415);
    expect(fromIdl.RevenueToken.size).toBe(503);
  });

  it('event discriminators', () => {
    const fromIdl = Object.fromEntries(idl.events.map((e) => [e.name, e.discriminator]));
    const fromSdk = Object.fromEntries(
      Object.entries(EVENT_DISCRIMINATORS).map(([name, d]) => [name, bytes(d as Uint8Array)]),
    );
    expect(fromSdk).toEqual(fromIdl);
  });

  it('errors: codes, names and messages', () => {
    expect(EPOCH_ERRORS.map((e) => ({ code: e.code, name: e.name, msg: e.message }))).toEqual(idl.errors);
  });

  it('the revenue-token instructions take the accounts the security review added or removed', () => {
    const accounts = (name: string) => idl.instructions.find((ix) => ix.name === name)!.accounts.map((a) => a.name);
    expect(accounts('execute_buyback').slice(0, 3)).toEqual(['cranker', 'pool', 'revenue_token']);
    expect(accounts('close_revenue_token').slice(0, 5)).toEqual([
      'cranker',
      'operator',
      'pool',
      'vault',
      'revenue_token',
    ]);
    expect(accounts('redeem')).toEqual([
      'holder',
      'holder_tokens',
      'revenue_token',
      'buyback_escrow',
      'buyback_tokens',
      'mint',
      'treasury_tokens',
      'token_program',
      'system_program',
    ]);
  });
});
