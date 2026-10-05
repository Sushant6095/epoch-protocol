/**
 * A small Borsh reader driven by an Anchor (0.30+) IDL, enough to decode the events Meteora's programs emit: structs of
 * integers, bools, public keys, fixed arrays, options, vectors and nested defined types. The IDLs come from the SDKs
 * (`DynamicBondingCurveIdl`, `CpAmmIdl`), so the layouts follow the deployed programs without hand-written offsets.
 * Field names come out in camelCase; 64- and 128-bit integers as bigint, smaller ones as numbers, keys as base58.
 */
import { PublicKey } from '@solana/web3.js';

/** The parts of an Anchor IDL this reader uses. */
export interface IdlLike {
  instructions: readonly { name: string; discriminator: readonly number[]; accounts: readonly { name: string }[] }[];
  events?: readonly { name: string; discriminator: readonly number[] }[];
  types?: readonly IdlTypeDef[];
}

interface IdlTypeDef {
  name: string;
  type:
    | { kind: 'struct'; fields?: readonly IdlField[] }
    | { kind: 'enum'; variants: readonly { name: string; fields?: readonly unknown[] }[] }
    | { kind: string };
}

interface IdlField {
  name: string;
  type: unknown;
}

export type DecodedValue = number | bigint | boolean | string | null | DecodedValue[] | { [key: string]: DecodedValue };
export type DecodedStruct = { [key: string]: DecodedValue };

const camel = (name: string): string => name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());

const sameBytes = (a: Uint8Array, b: readonly number[], offset = 0): boolean => {
  if (a.length < offset + b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[offset + i] !== b[i]) return false;
  return true;
};

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private take(length: number): number {
    if (this.offset + length > this.data.length) throw new RangeError('event data ended early');
    const at = this.offset;
    this.offset += length;
    return at;
  }

  u8 = () => this.view.getUint8(this.take(1));
  i8 = () => this.view.getInt8(this.take(1));
  u16 = () => this.view.getUint16(this.take(2), true);
  i16 = () => this.view.getInt16(this.take(2), true);
  u32 = () => this.view.getUint32(this.take(4), true);
  i32 = () => this.view.getInt32(this.take(4), true);
  u64 = () => this.view.getBigUint64(this.take(8), true);
  i64 = () => this.view.getBigInt64(this.take(8), true);
  u128 = (): bigint => {
    const low = this.u64();
    return (this.u64() << 64n) + low;
  };
  i128 = (): bigint => {
    const value = this.u128();
    return value >= 1n << 127n ? value - (1n << 128n) : value;
  };
  f32 = () => this.view.getFloat32(this.take(4), true);
  f64 = () => this.view.getFloat64(this.take(8), true);
  bytes = (length: number): Uint8Array => {
    const at = this.take(length);
    return this.data.subarray(at, at + length);
  };
}

/** Decodes Borsh data against an IDL's types. */
export class IdlCoder {
  private readonly types = new Map<string, IdlTypeDef>();

  constructor(readonly idl: IdlLike) {
    for (const type of idl.types ?? []) this.types.set(type.name, type);
  }

  /** The event whose discriminator starts `data`, decoded; null for any other data. */
  decodeEvent(data: Uint8Array): { name: string; data: DecodedStruct } | null {
    const event = this.idl.events?.find((candidate) => sameBytes(data, candidate.discriminator));
    if (!event) return null;
    const value = this.decodeDefined(event.name, new Reader(data.subarray(8)));
    return { name: event.name, data: value as DecodedStruct };
  }

  /** The instruction whose discriminator starts `data` (its IDL name and account names), or null. */
  instruction(data: Uint8Array): { name: string; accounts: string[] } | null {
    const ix = this.idl.instructions.find((candidate) => sameBytes(data, candidate.discriminator));
    return ix ? { name: ix.name, accounts: ix.accounts.map((account) => account.name) } : null;
  }

  private decodeDefined(name: string, reader: Reader): DecodedValue {
    const def = this.types.get(name);
    if (!def) throw new RangeError(`unknown IDL type ${name}`);
    const type = def.type;
    if (type.kind === 'struct') {
      const out: DecodedStruct = {};
      for (const field of (type as { fields?: readonly IdlField[] }).fields ?? []) {
        out[camel(field.name)] = this.decode(field.type, reader);
      }
      return out;
    }
    if (type.kind === 'enum') {
      const variants = (type as { variants: readonly { name: string; fields?: readonly unknown[] }[] }).variants;
      const index = reader.u8();
      const variant = variants[index];
      if (!variant) throw new RangeError(`enum ${name}: no variant ${index}`);
      if (variant.fields?.length) throw new RangeError(`enum ${name}: variants with fields are not supported`);
      return variant.name;
    }
    throw new RangeError(`IDL type ${name}: kind ${type.kind} is not supported`);
  }

  private decode(type: unknown, reader: Reader): DecodedValue {
    if (typeof type === 'string') {
      switch (type) {
        case 'u8':
          return reader.u8();
        case 'i8':
          return reader.i8();
        case 'u16':
          return reader.u16();
        case 'i16':
          return reader.i16();
        case 'u32':
          return reader.u32();
        case 'i32':
          return reader.i32();
        case 'u64':
          return reader.u64();
        case 'i64':
          return reader.i64();
        case 'u128':
          return reader.u128();
        case 'i128':
          return reader.i128();
        case 'f32':
          return reader.f32();
        case 'f64':
          return reader.f64();
        case 'bool':
          return reader.u8() !== 0;
        case 'pubkey':
        case 'publicKey':
          return new PublicKey(reader.bytes(32)).toBase58();
        case 'string':
          return new TextDecoder().decode(reader.bytes(reader.u32()));
        case 'bytes':
          return Array.from(reader.bytes(reader.u32()));
        default:
          throw new RangeError(`IDL type ${type} is not supported`);
      }
    }
    const shape = type as Record<string, unknown>;
    if ('defined' in shape) {
      const defined = shape.defined;
      return this.decodeDefined(typeof defined === 'string' ? defined : (defined as { name: string }).name, reader);
    }
    if ('array' in shape) {
      const [inner, length] = shape.array as [unknown, number];
      return Array.from({ length }, () => this.decode(inner, reader));
    }
    if ('option' in shape) return reader.u8() === 0 ? null : this.decode(shape.option, reader);
    if ('vec' in shape) {
      const length = reader.u32();
      return Array.from({ length }, () => this.decode(shape.vec, reader));
    }
    throw new RangeError(`IDL type ${JSON.stringify(type)} is not supported`);
  }
}
