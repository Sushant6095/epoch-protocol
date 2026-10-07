/**
 * The program reads Meteora's accounts at fixed byte offsets (`programs/epoch/src/meteora_account.rs`, no Meteora crate):
 * the DBC `VirtualPool` and `PoolConfig`, the DAMM v2 `Pool`, `Config` and `Position`. The Rust tests pin those offsets
 * on real mainnet accounts; this test pins them to Meteora's IDLs, as bundled in the pinned SDKs (DBC 0.2.1 and cp_amm
 * 0.2.5, whose layout equals mainnet's 0.2.4). It walks each zero_copy account's type in the IDL to get every field's
 * offset, then checks that every literal read in each Rust `parse` lands on the IDL field of the same name and width, and
 * that the account sizes and discriminators match. An SDK bump that moves a field fails here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveIdl } from '@meteora-ag/dynamic-bonding-curve-sdk';

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } } | { option: IdlType };
interface IdlTypeDef {
  name: string;
  type: { kind: string; fields?: { name: string; type: IdlType }[] };
}
interface Idl {
  accounts: { name: string; discriminator: number[] }[];
  types: IdlTypeDef[];
}

const PRIMITIVE_SIZE: Record<string, number> = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  u64: 8,
  i64: 8,
  f64: 8,
  u128: 16,
  i128: 16,
  pubkey: 32,
};

interface Leaf {
  path: string;
  offset: number;
  size: number;
}

/** Size of an IDL type in a zero_copy (repr(C), explicitly padded) account. */
function sizeOf(idl: Idl, type: IdlType): number {
  if (typeof type === 'string') {
    const size = PRIMITIVE_SIZE[type];
    if (size === undefined) throw new Error(`no fixed size for ${type}`);
    return size;
  }
  if ('array' in type) return sizeOf(idl, type.array[0]) * type.array[1];
  if ('defined' in type) return structLeaves(idl, type.defined.name, 0, '').reduce((n, l) => n + l.size, 0);
  throw new Error(`zero_copy accounts have no ${JSON.stringify(type)}`);
}

/** Every primitive field of a struct (arrays as one leaf), with its offset. */
function structLeaves(idl: Idl, name: string, base: number, prefix: string): Leaf[] {
  const def = idl.types.find((t) => t.name === name);
  if (!def || def.type.kind !== 'struct' || !def.type.fields) throw new Error(`${name} is not a struct in the IDL`);
  const leaves: Leaf[] = [];
  let offset = base;
  for (const field of def.type.fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    if (typeof field.type === 'object' && 'defined' in field.type) {
      const inner = structLeaves(idl, field.type.defined.name, offset, path);
      leaves.push(...inner);
      offset += inner.reduce((n, l) => n + l.size, 0);
    } else {
      const size = sizeOf(idl, field.type);
      leaves.push({ path, offset, size });
      offset += size;
    }
  }
  return leaves;
}

/** Leaves of an account, offsets after the 8-byte discriminator. */
const accountLeaves = (idl: Idl, account: string): Leaf[] => structLeaves(idl, account, 8, '');
const accountSize = (idl: Idl, account: string): number =>
  8 + accountLeaves(idl, account).reduce((n, l) => n + l.size, 0);

const source = readFileSync(join(__dirname, '../../../programs/epoch/src/meteora_account.rs'), 'utf8');

/** The body of `impl <name> { pub fn parse(..) .. }`. */
function parseBody(implName: string): string {
  const start = source.indexOf(`impl ${implName} {`);
  if (start < 0) throw new Error(`impl ${implName} not found`);
  const fn = source.indexOf('pub fn parse(', start);
  const end = source.indexOf('pub fn load(', fn);
  return source.slice(fn, end);
}

interface RustRead {
  field: string;
  offset: number;
  size: number;
}

const READER_SIZE: Record<string, number> = { key: 32, u64_at: 8, u128_at: 16, u16_at: 2 };

/** Every `name: reader(d, N)` and `name: d[N]` with a literal offset. */
function rustReads(body: string): RustRead[] {
  const reads: RustRead[] = [];
  for (const m of body.matchAll(/(\w+): (key|u64_at|u128_at|u16_at)\(d, (\d+)\)/g)) {
    reads.push({ field: m[1], offset: Number(m[3]), size: READER_SIZE[m[2]] });
  }
  for (const m of body.matchAll(/(\w+): d\[(\d+)\]/g)) reads.push({ field: m[1], offset: Number(m[2]), size: 1 });
  return reads;
}

/** `pub const NAME: usize = N;` / `[u8; 8]` constants from meteora_account.rs. */
const usizeConst = (name: string): number => {
  const m = new RegExp(`pub const ${name}: usize = ([\\d_]+);`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return Number(m[1].replace(/_/g, ''));
};
const discriminatorConst = (name: string): number[] => {
  const m = new RegExp(`pub const ${name}: \\[u8; 8\\] = \\[([\\d,\\s]+)\\];`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1].split(',').map((s) => Number(s.trim()));
};

const dbc = DynamicBondingCurveIdl as unknown as Idl;
const cpAmm = CpAmmIdl as unknown as Idl;

/**
 * Each Rust reader, the IDL account it reads, and the IDL path of every Rust field whose name is not the IDL field's own
 * (the last path segment).
 */
const READERS: {
  impl: string;
  idl: Idl;
  account: string;
  lenConst: string;
  discriminatorConst: string;
  aliases?: Record<string, string>;
}[] = [
  {
    impl: 'DbcPool',
    idl: dbc,
    account: 'VirtualPool',
    lenConst: 'DBC_VIRTUAL_POOL_LEN',
    discriminatorConst: 'DBC_VIRTUAL_POOL_DISCRIMINATOR',
  },
  {
    impl: 'DbcConfig',
    idl: dbc,
    account: 'PoolConfig',
    lenConst: 'DBC_POOL_CONFIG_LEN',
    discriminatorConst: 'DBC_POOL_CONFIG_DISCRIMINATOR',
    aliases: {
      mode: 'pool_fees.base_fee.base_fee_mode',
      partner_permanent_locked: 'partner_permanent_locked_liquidity_percentage',
      partner_unlocked: 'partner_liquidity_percentage',
      partner_vesting: 'partner_liquidity_vesting_info.vesting_percentage',
      creator_permanent_locked: 'creator_permanent_locked_liquidity_percentage',
      creator_unlocked: 'creator_liquidity_percentage',
      creator_vesting: 'creator_liquidity_vesting_info.vesting_percentage',
      migrated_pool_fee_bps: 'migrated_pool_fee_bps',
    },
  },
  {
    impl: 'DbcPartnerTerms',
    idl: dbc,
    account: 'PoolConfig',
    lenConst: 'DBC_POOL_CONFIG_LEN',
    discriminatorConst: 'DBC_POOL_CONFIG_DISCRIMINATOR',
  },
  {
    impl: 'DammPool',
    idl: cpAmm,
    account: 'Pool',
    lenConst: 'DAMM_POOL_LEN',
    discriminatorConst: 'DAMM_POOL_DISCRIMINATOR',
  },
  {
    impl: 'DammConfig',
    idl: cpAmm,
    account: 'Config',
    lenConst: 'DAMM_CONFIG_LEN',
    discriminatorConst: 'DAMM_CONFIG_DISCRIMINATOR',
  },
  {
    impl: 'DammPosition',
    idl: cpAmm,
    account: 'Position',
    lenConst: 'DAMM_POSITION_LEN',
    discriminatorConst: 'DAMM_POSITION_DISCRIMINATOR',
  },
];

describe('meteora_account.rs offsets follow the pinned SDKs’ IDL layouts', () => {
  it.each(READERS)('$impl: size and discriminator of $account', (r) => {
    expect(usizeConst(r.lenConst)).toBe(accountSize(r.idl, r.account));
    expect(discriminatorConst(r.discriminatorConst)).toEqual(
      r.idl.accounts.find((a) => a.name === r.account)?.discriminator,
    );
  });

  it.each(READERS)('$impl: every literal read is the IDL field of that name and width', (r) => {
    const leaves = accountLeaves(r.idl, r.account);
    const reads = rustReads(parseBody(r.impl));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      const want = r.aliases?.[read.field];
      const leaf = want
        ? leaves.find((l) => l.path === want)
        : leaves.find((l) => l.path === read.field || l.path.endsWith(`.${read.field}`));
      expect({ field: read.field, path: leaf?.path, offset: leaf?.offset, size: leaf?.size }).toEqual({
        field: read.field,
        path: leaf?.path ?? want ?? read.field,
        offset: read.offset,
        size: read.size,
      });
    }
  });

  it('reads the DBC curve where the IDL puts it: 20 points of {sqrt_price u128, liquidity u128}', () => {
    const leaves = accountLeaves(dbc, 'PoolConfig');
    const curve = leaves.find((l) => l.path === 'curve');
    expect(curve).toEqual({ path: 'curve', offset: 408, size: usizeConst('DBC_CURVE_POINTS') * 32 });
    expect(parseBody('DbcConfig')).toMatch(
      /let at = 408 \+ i \* 32;[\s\S]*sqrt_price: u128_at\(d, at\),\s*liquidity: u128_at\(d, at \+ 16\)/,
    );
    const point = dbc.types.find((t) => t.name === 'LiquidityDistributionConfig');
    expect(point?.type.fields?.map((f) => [f.name, f.type])).toEqual([
      ['sqrt_price', 'u128'],
      ['liquidity', 'u128'],
    ]);
  });
});
