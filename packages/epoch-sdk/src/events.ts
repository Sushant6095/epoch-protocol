/**
 * The 26 `#[event]`s in `programs/epoch/src/events.rs`. Anchor's `emit!` logs each as
 * `Program data: <base64(discriminator ++ borsh(event))>`.
 */
import { type PublicKey } from '@solana/web3.js';

import { BorshReader } from './borsh';
import { SIDES, type Side, type Tranche, TRANCHES } from './constants';
import { type EventName, eventNameOf } from './discriminators';
import { base64Decode, bytesToHex } from './encoding';

/** Event name → `data` shape: the Rust fields in camelCase (u64/i64 → bigint, u8/u16 → number). */
export interface EpochEventMap {
  PoolInitialized: { pool: PublicKey; admin: PublicKey; treasury: PublicKey; scorer: PublicKey };
  ParamsUpdated: { pool: PublicKey };
  PauseToggled: { pool: PublicKey; paused: boolean };
  Deposited: {
    pool: PublicKey;
    owner: PublicKey;
    tranche: Tranche;
    assets: bigint;
    shares: bigint;
    sharePriceE9: bigint;
  };
  WithdrawRequested: { pool: PublicKey; owner: PublicKey; tranche: Tranche; shares: bigint; seq: bigint };
  /** `reason`: 0 = cancelled by the owner, 1 = bounced by the junior floor at the head of the queue. */
  WithdrawCancelled: { pool: PublicKey; owner: PublicKey; seq: bigint; reason: number };
  WithdrawProcessed: {
    pool: PublicKey;
    owner: PublicKey;
    tranche: Tranche;
    shares: bigint;
    assets: bigint;
    seq: bigint;
  };
  Accrued: {
    pool: PublicKey;
    epoch: bigint;
    income: bigint;
    protocolFee: bigint;
    seniorGain: bigint;
    juniorGain: bigint;
    seniorPriceE9: bigint;
    juniorPriceE9: bigint;
  };
  ValidatorOnboarded: {
    pool: PublicKey;
    vote: PublicKey;
    identity: PublicKey;
    operator: PublicKey;
    originalWithdrawer: PublicKey;
    epoch: bigint;
  };
  CollectorsSet: { vote: PublicKey; collector: PublicKey };
  ScoreUpdated: { vote: PublicKey; epoch: bigint; score: number; hedged: boolean };
  BondPosted: { vote: PublicKey; lamports: bigint; bondTotal: bigint };
  BondWithdrawn: { vote: PublicKey; lamports: bigint; bondTotal: bigint };
  AdvanceOpened: {
    pool: PublicKey;
    vote: PublicKey;
    advance: PublicKey;
    seq: bigint;
    principal: bigint;
    fee: bigint;
    remitBps: number;
    epoch: bigint;
  };
  Swept: {
    pool: PublicKey;
    vote: PublicKey;
    epoch: bigint;
    /** Withdrawn from the vote account this sweep. */
    fromVote: bigint;
    /** Total gross revenue processed (vote withdrawal + collector deposits). */
    gross: bigint;
    remitted: bigint;
    toOperator: bigint;
  };
  AdvanceRepaid: { vote: PublicKey; advance: PublicKey; epoch: bigint };
  AdvanceDefaulted: {
    pool: PublicKey;
    vote: PublicKey;
    advance: PublicKey;
    principalLost: bigint;
    bondApplied: bigint;
    epoch: bigint;
  };
  /** `kind`: 0 = inflation rewards, 1 = block revenue. */
  CommissionUpdated: { vote: PublicKey; kind: number; commissionBps: number };
  IdentityUpdated: { vote: PublicKey; newIdentity: PublicKey };
  ValidatorReleased: { pool: PublicKey; vote: PublicKey; newWithdrawer: PublicKey; epoch: bigint };
  IndexProposed: { epoch: bigint; value: bigint; inputsHash: Uint8Array; slot: bigint };
  IndexFinalized: { epoch: bigint; value: bigint; inputsHash: Uint8Array; slot: bigint };
  IndexVetoed: { epoch: bigint; value: bigint };
  QuotePosted: {
    quote: PublicKey;
    maker: PublicKey;
    epoch: bigint;
    fixedRate: bigint;
    maxNotional: bigint;
    maxMoveBps: number;
  };
  SwapOpened: {
    quote: PublicKey;
    swap: PublicKey;
    taker: PublicKey;
    epoch: bigint;
    side: Side;
    notional: bigint;
    fixedRate: bigint;
    collateral: bigint;
  };
  /** `takerPnl` is an `i64`: negative when the taker lost. */
  SwapSettled: { swap: PublicKey; epoch: bigint; indexValue: bigint; takerPnl: bigint };
}

/** One member per event, discriminated by `name`. */
export type EpochEvent = { [K in EventName]: { name: K; data: EpochEventMap[K] } }[EventName];

/** The JSON-safe form from `eventToJson`. */
export interface EpochEventJson {
  name: EventName;
  data: Record<string, string | number | boolean>;
}

const DECODERS: { [K in EventName]: (r: BorshReader) => EpochEventMap[K] } = {
  PoolInitialized: (r) => ({ pool: r.pubkey(), admin: r.pubkey(), treasury: r.pubkey(), scorer: r.pubkey() }),
  ParamsUpdated: (r) => ({ pool: r.pubkey() }),
  PauseToggled: (r) => ({ pool: r.pubkey(), paused: r.bool('paused') }),
  Deposited: (r) => ({
    pool: r.pubkey(),
    owner: r.pubkey(),
    tranche: r.variant(TRANCHES, 'tranche'),
    assets: r.u64(),
    shares: r.u64(),
    sharePriceE9: r.u64(),
  }),
  WithdrawRequested: (r) => ({
    pool: r.pubkey(),
    owner: r.pubkey(),
    tranche: r.variant(TRANCHES, 'tranche'),
    shares: r.u64(),
    seq: r.u64(),
  }),
  WithdrawCancelled: (r) => ({ pool: r.pubkey(), owner: r.pubkey(), seq: r.u64(), reason: r.u8() }),
  WithdrawProcessed: (r) => ({
    pool: r.pubkey(),
    owner: r.pubkey(),
    tranche: r.variant(TRANCHES, 'tranche'),
    shares: r.u64(),
    assets: r.u64(),
    seq: r.u64(),
  }),
  Accrued: (r) => ({
    pool: r.pubkey(),
    epoch: r.u64(),
    income: r.u64(),
    protocolFee: r.u64(),
    seniorGain: r.u64(),
    juniorGain: r.u64(),
    seniorPriceE9: r.u64(),
    juniorPriceE9: r.u64(),
  }),
  ValidatorOnboarded: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    identity: r.pubkey(),
    operator: r.pubkey(),
    originalWithdrawer: r.pubkey(),
    epoch: r.u64(),
  }),
  CollectorsSet: (r) => ({ vote: r.pubkey(), collector: r.pubkey() }),
  ScoreUpdated: (r) => ({ vote: r.pubkey(), epoch: r.u64(), score: r.u16(), hedged: r.bool('hedged') }),
  BondPosted: (r) => ({ vote: r.pubkey(), lamports: r.u64(), bondTotal: r.u64() }),
  BondWithdrawn: (r) => ({ vote: r.pubkey(), lamports: r.u64(), bondTotal: r.u64() }),
  AdvanceOpened: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    advance: r.pubkey(),
    seq: r.u64(),
    principal: r.u64(),
    fee: r.u64(),
    remitBps: r.u16(),
    epoch: r.u64(),
  }),
  Swept: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    epoch: r.u64(),
    fromVote: r.u64(),
    gross: r.u64(),
    remitted: r.u64(),
    toOperator: r.u64(),
  }),
  AdvanceRepaid: (r) => ({ vote: r.pubkey(), advance: r.pubkey(), epoch: r.u64() }),
  AdvanceDefaulted: (r) => ({
    pool: r.pubkey(),
    vote: r.pubkey(),
    advance: r.pubkey(),
    principalLost: r.u64(),
    bondApplied: r.u64(),
    epoch: r.u64(),
  }),
  CommissionUpdated: (r) => ({ vote: r.pubkey(), kind: r.u8(), commissionBps: r.u16() }),
  IdentityUpdated: (r) => ({ vote: r.pubkey(), newIdentity: r.pubkey() }),
  ValidatorReleased: (r) => ({ pool: r.pubkey(), vote: r.pubkey(), newWithdrawer: r.pubkey(), epoch: r.u64() }),
  IndexProposed: (r) => ({ epoch: r.u64(), value: r.u64(), inputsHash: r.bytes(32), slot: r.u64() }),
  IndexFinalized: (r) => ({ epoch: r.u64(), value: r.u64(), inputsHash: r.bytes(32), slot: r.u64() }),
  IndexVetoed: (r) => ({ epoch: r.u64(), value: r.u64() }),
  QuotePosted: (r) => ({
    quote: r.pubkey(),
    maker: r.pubkey(),
    epoch: r.u64(),
    fixedRate: r.u64(),
    maxNotional: r.u64(),
    maxMoveBps: r.u16(),
  }),
  SwapOpened: (r) => ({
    quote: r.pubkey(),
    swap: r.pubkey(),
    taker: r.pubkey(),
    epoch: r.u64(),
    side: r.variant(SIDES, 'side'),
    notional: r.u64(),
    fixedRate: r.u64(),
    collateral: r.u64(),
  }),
  SwapSettled: (r) => ({ swap: r.pubkey(), epoch: r.u64(), indexValue: r.u64(), takerPnl: r.i64() }),
};

/**
 * Decode `discriminator ++ borsh(event)` (the bytes inside a `Program data:` line). Returns null for an unknown
 * discriminator; throws if a known event's bytes are malformed. Trailing bytes are ignored.
 */
export function decodeEvent(data: Uint8Array): EpochEvent | null {
  const name = eventNameOf(data);
  if (name === null) return null;
  const reader = new BorshReader(data, 8);
  return { name, data: DECODERS[name](reader) } as EpochEvent;
}

// Program ids are base58, so `Program log: …` / `Program data: …` lines can never match these.
const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const EXIT = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success$|failed)/;
const DATA_PREFIX = 'Program data: ';

/**
 * Epoch events in a transaction's log messages, in log order. Only `Program data:` lines written while `programId`
 * is the innermost executing program count: the invocation stack is tracked from `Program X invoke [n]` and
 * `Program X success` / `Program X failed: …` lines (`Program X consumed …` and `Program log:` lines leave it
 * unchanged), so data logged by other programs — including programs this one calls — is ignored.
 */
export function parseEventsFromLogs(logs: readonly string[], programId: PublicKey): EpochEvent[] {
  const target = programId.toBase58();
  const stack: string[] = [];
  const events: EpochEvent[] = [];
  for (const line of logs) {
    if (line.startsWith(DATA_PREFIX)) {
      if (stack.length === 0 || stack[stack.length - 1] !== target) continue;
      const payload = line.slice(DATA_PREFIX.length).trim();
      // `emit!` logs one base64 field; several space-separated fields are a raw `sol_log_data`, not an event.
      if (payload.length === 0 || payload.includes(' ')) continue;
      const event = decodeEvent(base64Decode(payload));
      if (event) events.push(event);
      continue;
    }
    const invoke = INVOKE.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth >= 1 && depth - 1 < stack.length) stack.length = depth - 1;
      stack.push(invoke[1]);
      continue;
    }
    const exit = EXIT.exec(line);
    if (exit) {
      const at = stack.lastIndexOf(exit[1]);
      if (at >= 0) stack.length = at;
    }
  }
  return events;
}

function isPublicKeyLike(value: unknown): value is PublicKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toBase58?: unknown }).toBase58 === 'function' &&
    typeof (value as { toBytes?: unknown }).toBytes === 'function'
  );
}

/** JSON-safe copy: pubkeys → base58, bigints → decimal strings, byte arrays → hex; numbers, booleans, enums as-is. */
export function eventToJson(event: EpochEvent): EpochEventJson {
  const data: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event.data) as [string, unknown][]) {
    if (isPublicKeyLike(value)) data[key] = value.toBase58();
    else if (typeof value === 'bigint') data[key] = value.toString();
    else if (value instanceof Uint8Array) data[key] = bytesToHex(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') data[key] = value;
    else throw new TypeError(`eventToJson: unsupported value for ${event.name}.${key}`);
  }
  return { name: event.name, data };
}
