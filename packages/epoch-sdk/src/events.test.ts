import { PublicKey } from '@solana/web3.js';

import { fromHex, key, sdkEnum, toRustJson, vectors } from './__fixtures__/vectors';
import { EVENT_DISCRIMINATORS } from './discriminators';
import { base64Encode } from './encoding';
import { decodeEvent, type EpochEvent, eventToJson, parseEventsFromLogs } from './events';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

const programId = key(vectors.programId);
const OTHER = 'ComputeBudget111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const EPOCH = programId.toBase58();

const rustEvent = (name: string, label = 'a') => vectors.events.find((e) => e.name === name && e.label === label)!;
const programData = (hexData: string) => `Program data: ${base64Encode(fromHex(hexData))}`;

describe('decodeEvent reproduces every event the program emits', () => {
  it.each(vectors.events.map((e) => [`${e.name} (${e.label})`, e] as const))('%s', (_label, rust) => {
    const event = decodeEvent(fromHex(rust.data));
    expect(event?.name).toBe(rust.name);
    expect(toRustJson(event?.data)).toEqual(rust.fields);
  });

  it('decodes negative i64 P&L and both enum sides', () => {
    const lost = decodeEvent(fromHex(rustEvent('SwapSettled', 'a').data));
    expect(lost?.name === 'SwapSettled' && lost.data.takerPnl < 0n).toBe(true);
    const opened = decodeEvent(fromHex(rustEvent('SwapOpened', 'a').data));
    expect(opened?.name === 'SwapOpened' && opened.data.side).toBe('receiveFixed');
    const deposited = decodeEvent(fromHex(rustEvent('Deposited', 'b').data));
    expect(deposited?.name === 'Deposited' && deposited.data.tranche).toBe('senior');
    const onCurve = decodeEvent(fromHex(rustEvent('BuybackExecuted', 'a').data));
    expect(onCurve?.name === 'BuybackExecuted' && onCurve.data.venue).toBe('dbc');
    const graduated = decodeEvent(fromHex(rustEvent('BuybackExecuted', 'b').data));
    expect(graduated?.name === 'BuybackExecuted' && graduated.data.venue).toBe('dammV2');
  });

  it('decodes every treasury claim kind, with a position only for LP fees', () => {
    const kinds = ['trading_fee', 'surplus', 'migration_fee', 'leftover', 'lp_fee'].map((label) => {
      const event = decodeEvent(fromHex(rustEvent('TreasuryClaimed', label).data));
      if (event?.name !== 'TreasuryClaimed') throw new Error(label);
      expect(event.data.position.equals(PublicKey.default)).toBe(label !== 'lp_fee');
      return event.data.kind;
    });
    expect(kinds).toEqual(['tradingFee', 'surplus', 'migrationFee', 'leftover', 'lpFee']);
    const json = eventToJson(decodeEvent(fromHex(rustEvent('TreasuryClaimed', 'lp_fee').data))!);
    expect(json.data.kind).toBe('lpFee');
    expect(json.data.lamportsToPool).toBe(rustEvent('TreasuryClaimed', 'lp_fee').fields.lamports_to_pool);
  });

  it('returns null for unknown discriminators and short data, throws for a truncated known event', () => {
    expect(decodeEvent(new Uint8Array(40))).toBeNull();
    expect(decodeEvent(EVENT_DISCRIMINATORS.Deposited.subarray(0, 7))).toBeNull();
    expect(() => decodeEvent(fromHex(rustEvent('Deposited').data).subarray(0, 50))).toThrow(RangeError);
  });

  it('ignores trailing bytes (forward compatible with appended fields)', () => {
    const data = fromHex(rustEvent('ParamsUpdated').data);
    const longer = new Uint8Array(data.length + 9);
    longer.set(data);
    expect(toRustJson(decodeEvent(longer)?.data)).toEqual(rustEvent('ParamsUpdated').fields);
  });
});

describe('eventToJson', () => {
  it.each(vectors.events.filter((e) => e.label === 'a').map((e) => [e.name, e] as const))('%s', (_name, rust) => {
    const json = eventToJson(decodeEvent(fromHex(rust.data))!);
    expect(json.name).toBe(rust.name);
    const expected = Object.fromEntries(
      Object.entries(rust.fields).map(([k, v]) => {
        const camel = k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
        const isEnum = ['tranche', 'side', 'venue'].includes(k);
        return [camel, isEnum ? sdkEnum(v) : v];
      }),
    );
    expect(json.data).toEqual(expected);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('turns the operator snapshot of IndexBallotOpened into a list of flat records', () => {
    const three = rustEvent('IndexBallotOpened', 'a');
    const json = eventToJson(decodeEvent(fromHex(three.data))!);
    expect(json.data.operators).toEqual(three.fields.operators);
    expect((json.data.operators as unknown[]).length).toBe(3);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    const none = eventToJson(decodeEvent(fromHex(rustEvent('IndexBallotOpened', 'b').data))!);
    expect(none.data.operators).toEqual([]);
    expect(none.data.reset).toBe(true);
  });
});

describe('eventToJson with None options (validator history)', () => {
  it('leaves a None field out and keeps the rest', () => {
    const rust = vectors.events.find((e) => e.name === 'TipDistributionCopied' && e.label === 'b')!;
    const event = decodeEvent(fromHex(rust.data))!;
    expect(event.name).toBe('TipDistributionCopied');
    const json = eventToJson(event);
    expect(json.data).toEqual({ vote: rust.fields.vote, epoch: rust.fields.epoch, found: false });
    const copied = vectors.events.find((e) => e.name === 'VoteAccountCopied' && e.label === 'b')!;
    expect('lastVotedSlot' in eventToJson(decodeEvent(fromHex(copied.data))!).data).toBe(false);
  });
});

describe('parseEventsFromLogs', () => {
  const swept = rustEvent('Swept');
  const repaid = rustEvent('AdvanceRepaid');
  const deposited = rustEvent('Deposited');
  const scored = rustEvent('ScoreUpdated');

  it('keeps only data logged while the Epoch program is the innermost frame, in order', () => {
    const logs = [
      `Program ${OTHER} invoke [1]`,
      `Program ${OTHER} success`,
      `Program ${EPOCH} invoke [1]`,
      'Program log: Instruction: Sweep',
      `Program ${SYSTEM} invoke [2]`,
      programData(deposited.data), // logged by the system program frame: not ours
      `Program ${SYSTEM} success`,
      programData(swept.data),
      `Program ${OTHER} invoke [2]`,
      programData(scored.data), // inner CPI into another program: not ours
      `Program ${OTHER} consumed 120 of 180000 compute units`,
      `Program ${OTHER} success`,
      programData(repaid.data),
      'Program data: AAAAAAAAAAA=', // unknown discriminator from our program: skipped
      `Program data: ${base64Encode(fromHex(swept.data))} ${base64Encode(fromHex(swept.data))}`, // raw multi-field log
      `Program ${EPOCH} consumed 61234 of 200000 compute units`,
      `Program ${EPOCH} success`,
      programData(deposited.data), // no frame: not ours
      `Program ${OTHER} invoke [1]`,
      programData(deposited.data),
      `Program ${OTHER} success`,
    ];
    const events = parseEventsFromLogs(logs, programId);
    expect(events.map((e) => e.name)).toEqual(['Swept', 'AdvanceRepaid']);
    expect(toRustJson(events[0].data)).toEqual(swept.fields);
    expect(toRustJson(events[1].data)).toEqual(repaid.fields);
  });

  it('picks up the Epoch program when another program invokes it (CPI)', () => {
    const logs = [
      `Program ${OTHER} invoke [1]`,
      `Program ${EPOCH} invoke [2]`,
      programData(deposited.data),
      `Program ${EPOCH} success`,
      programData(swept.data), // back in the caller
      `Program ${OTHER} success`,
    ];
    expect(parseEventsFromLogs(logs, programId).map((e) => e.name)).toEqual(['Deposited']);
  });

  it('pops frames on failure and resynchronises from invoke depth', () => {
    const logs = [
      `Program ${EPOCH} invoke [1]`,
      `Program ${OTHER} invoke [2]`,
      `Program ${OTHER} failed: custom program error: 0x0`,
      programData(swept.data),
      `Program ${EPOCH} failed: custom program error: 0x1770`,
      `Program ${EPOCH} invoke [1]`,
      `Program ${OTHER} invoke [2]`,
      // the inner frame's exit line is missing (log truncation); the next depth-2 invoke replaces it
      `Program ${SYSTEM} invoke [2]`,
      `Program ${SYSTEM} success`,
      programData(repaid.data),
      `Program ${EPOCH} success`,
    ];
    expect(parseEventsFromLogs(logs, programId).map((e) => e.name)).toEqual(['Swept', 'AdvanceRepaid']);
  });

  it('is not confused by log text that looks like frame lines', () => {
    const logs = [
      `Program ${EPOCH} invoke [1]`,
      'Program log: failed to do something',
      'Program log: success',
      `Program return: ${EPOCH} AQID`,
      programData(swept.data),
      `Program ${EPOCH} success`,
    ];
    expect(parseEventsFromLogs(logs, programId).map((e) => e.name)).toEqual(['Swept']);
  });

  it('returns an empty list for other programs and empty logs', () => {
    const logs = [`Program ${EPOCH} invoke [1]`, programData(swept.data), `Program ${EPOCH} success`];
    expect(parseEventsFromLogs(logs, new PublicKey(OTHER))).toEqual([]);
    expect(parseEventsFromLogs([], programId)).toEqual([]);
  });

  it('narrows by name in TypeScript', () => {
    const [event] = parseEventsFromLogs(
      [`Program ${EPOCH} invoke [1]`, programData(swept.data), `Program ${EPOCH} success`],
      programId,
    );
    const gross = (e: EpochEvent): bigint | undefined => (e.name === 'Swept' ? e.data.gross : undefined);
    expect(gross(event)?.toString()).toBe(swept.fields.gross);
  });
});
