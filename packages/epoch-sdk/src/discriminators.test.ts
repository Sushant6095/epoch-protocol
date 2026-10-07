import { createHash } from 'crypto';

import { hex, vectors } from './__fixtures__/vectors';
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_NAMES,
  accountNameOf,
  EVENT_DISCRIMINATORS,
  EVENT_NAMES,
  eventNameOf,
  INSTRUCTION_DISCRIMINATORS,
  INSTRUCTION_NAMES,
  instructionNameOf,
} from './discriminators';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

const sighash = (namespace: string, name: string): string =>
  createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8).toString('hex');

describe('precomputed discriminators', () => {
  it.each(ACCOUNT_NAMES)('account %s = sha256("account:%s")[0..8]', (name) => {
    expect(hex(ACCOUNT_DISCRIMINATORS[name])).toBe(sighash('account', name));
  });

  it.each(INSTRUCTION_NAMES)('instruction %s = sha256("global:%s")[0..8]', (name) => {
    expect(hex(INSTRUCTION_DISCRIMINATORS[name])).toBe(sighash('global', name));
  });

  it.each(EVENT_NAMES)('event %s = sha256("event:%s")[0..8]', (name) => {
    expect(hex(EVENT_DISCRIMINATORS[name])).toBe(sighash('event', name));
  });

  it('covers exactly the program: 13 accounts, 57 instructions, 52 events', () => {
    expect(ACCOUNT_NAMES).toHaveLength(13);
    expect(INSTRUCTION_NAMES).toHaveLength(57);
    expect(EVENT_NAMES).toHaveLength(52);
    expect([...ACCOUNT_NAMES].sort()).toEqual(Object.keys(vectors.accounts).sort());
    expect([...INSTRUCTION_NAMES].sort()).toEqual([...new Set(vectors.instructions.map((i) => i.name))].sort());
    expect([...EVENT_NAMES].sort()).toEqual([...new Set(vectors.events.map((e) => e.name))].sort());
  });

  it('matches the discriminators the program itself reports', () => {
    for (const [name, entry] of Object.entries(vectors.accounts)) {
      expect(hex(ACCOUNT_DISCRIMINATORS[name as keyof typeof ACCOUNT_DISCRIMINATORS])).toBe(entry.discriminator);
    }
    for (const ix of vectors.instructions) {
      expect(hex(INSTRUCTION_DISCRIMINATORS[ix.name as keyof typeof INSTRUCTION_DISCRIMINATORS])).toBe(
        ix.discriminator,
      );
    }
    for (const event of vectors.events) {
      expect(hex(EVENT_DISCRIMINATORS[event.name as keyof typeof EVENT_DISCRIMINATORS])).toBe(event.discriminator);
    }
  });

  it('are unique across all three namespaces', () => {
    const all = [
      ...Object.values(ACCOUNT_DISCRIMINATORS),
      ...Object.values(INSTRUCTION_DISCRIMINATORS),
      ...Object.values(EVENT_DISCRIMINATORS),
    ].map(hex);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('name lookup by leading discriminator', () => {
  it('finds each name and ignores trailing bytes', () => {
    for (const name of ACCOUNT_NAMES) {
      expect(accountNameOf(Uint8Array.from([...ACCOUNT_DISCRIMINATORS[name], 1, 2, 3]))).toBe(name);
    }
    for (const name of INSTRUCTION_NAMES) expect(instructionNameOf(INSTRUCTION_DISCRIMINATORS[name])).toBe(name);
    for (const name of EVENT_NAMES) expect(eventNameOf(EVENT_DISCRIMINATORS[name])).toBe(name);
  });

  it('returns null for short or unknown data, and does not cross namespaces', () => {
    expect(accountNameOf(new Uint8Array(7))).toBeNull();
    expect(accountNameOf(new Uint8Array(8))).toBeNull();
    expect(eventNameOf(ACCOUNT_DISCRIMINATORS.Pool)).toBeNull();
    expect(accountNameOf(EVENT_DISCRIMINATORS.Deposited)).toBeNull();
    expect(instructionNameOf(ACCOUNT_DISCRIMINATORS.Pool)).toBeNull();
  });
});
