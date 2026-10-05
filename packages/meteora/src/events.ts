/**
 * Meteora's programs emit their events as Anchor CPI events (`emit_cpi!`): a self-invocation whose data is the event tag,
 * the event's discriminator and its Borsh body, signed by the program's event authority. This module finds those inner
 * instructions in a transaction (any depth: a direct swap, a Jupiter route, Epoch's buyback CPI), decodes them with the
 * programs' IDLs from the SDKs, and maps the ones a launch needs to plain records: trades (DBC `EvtSwap`/`EvtSwap2`,
 * DAMM v2 `EvtSwap2`) and fee claims, graduation and migration events.
 */
import {
  CP_AMM_PROGRAM_ID,
  CpAmmIdl,
  getFeeMode as getDammFeeMode,
  TradeDirection as DammDirection,
} from '@meteora-ag/cp-amm-sdk';
import {
  deriveDammV2EventAuthority,
  deriveDbcEventAuthority,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
  getFeeMode,
  TradeDirection,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

import { base58Decode } from './base58';
import { SOL_DECIMALS } from './constants';
import { sqrtPriceX64ToPrice } from './curve';
import { type DecodedStruct, IdlCoder, type IdlLike } from './idlCoder';
import { fromBaseUnits } from './units';

export const DBC_PROGRAM = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58();
export const DAMM_V2_PROGRAM = CP_AMM_PROGRAM_ID.toBase58();
const DBC_EVENT_AUTHORITY = deriveDbcEventAuthority().toBase58();
const DAMM_V2_EVENT_AUTHORITY = deriveDammV2EventAuthority().toBase58();

/** Anchor's event-instruction tag: sha256("anchor:event")[..8], little-endian u64 0x1d9acb512ea545e4. */
export const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d] as const;

let coders: { dbc: IdlCoder; damm: IdlCoder } | undefined;
const getCoders = () =>
  (coders ??= {
    dbc: new IdlCoder(DynamicBondingCurveIdl as unknown as IdlLike),
    damm: new IdlCoder(CpAmmIdl as unknown as IdlLike),
  });

export type MeteoraProgram = 'dbc' | 'damm-v2';

/** One instruction of a transaction, top-level or inner, with its accounts resolved to base58. */
export interface NormalizedInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
  /** 1 for a top-level instruction, 2 for what it invokes, and so on. */
  stackHeight: number;
  /** The top-level instruction this one belongs to. */
  outerIndex: number;
}

/** A transaction as the decoders need it, from any RPC response shape (`normalizeTransaction`). */
export interface NormalizedTransaction {
  signature: string;
  slot: number;
  /** Unix seconds, or null when the node does not know. */
  blockTime: number | null;
  failed: boolean;
  feePayer: string;
  /** Every instruction in execution order: each top-level one followed by the instructions it invoked. */
  instructions: NormalizedInstruction[];
}

type KeyLike = string | { toBase58(): string };
const keyText = (key: KeyLike): string => (typeof key === 'string' ? key : key.toBase58());

interface RawInstruction {
  programIdIndex: number;
  accounts?: number[];
  accountKeyIndexes?: number[];
  data: string | Uint8Array;
  stackHeight?: number | null;
}

const instructionData = (data: string | Uint8Array): Uint8Array =>
  typeof data === 'string' ? base58Decode(data) : Uint8Array.from(data);

/**
 * Normalizes a `getTransaction` result: the raw JSON-RPC shape (`encoding: "json"`, keys as strings, data in base58) or
 * web3.js's `TransactionResponse` / `VersionedTransactionResponse` (keys as PublicKey, compiled instructions). Loaded
 * addresses from lookup tables are appended after the static keys, writable first, as the runtime orders them.
 */
export function normalizeTransaction(response: unknown, signature?: string): NormalizedTransaction {
  const tx = response as {
    slot: number;
    blockTime?: number | null;
    meta: {
      err: unknown;
      innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
      loadedAddresses?: { writable: KeyLike[]; readonly: KeyLike[] } | null;
    } | null;
    transaction: {
      signatures: KeyLike[];
      message: {
        accountKeys?: KeyLike[];
        staticAccountKeys?: KeyLike[];
        instructions?: RawInstruction[];
        compiledInstructions?: RawInstruction[];
      };
    };
  };
  const message = tx.transaction.message;
  const loaded = tx.meta?.loadedAddresses;
  const keys = [
    ...(message.staticAccountKeys ?? message.accountKeys ?? []).map(keyText),
    ...(loaded?.writable ?? []).map(keyText),
    ...(loaded?.readonly ?? []).map(keyText),
  ];
  const resolve = (raw: RawInstruction, stackHeight: number, outerIndex: number): NormalizedInstruction => ({
    programId: keys[raw.programIdIndex],
    accounts: (raw.accounts ?? raw.accountKeyIndexes ?? []).map((index) => keys[index]),
    data: instructionData(raw.data),
    stackHeight,
    outerIndex,
  });
  const outer = message.compiledInstructions ?? message.instructions ?? [];
  const inner = new Map((tx.meta?.innerInstructions ?? []).map((group) => [group.index, group.instructions]));
  const instructions: NormalizedInstruction[] = [];
  outer.forEach((raw, index) => {
    instructions.push(resolve(raw, 1, index));
    for (const child of inner.get(index) ?? []) instructions.push(resolve(child, child.stackHeight ?? 2, index));
  });
  const firstSignature = tx.transaction.signatures[0];
  return {
    signature: signature ?? (typeof firstSignature === 'string' ? firstSignature : String(firstSignature ?? '')),
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    failed: tx.meta?.err !== null && tx.meta?.err !== undefined,
    feePayer: keys[0],
    instructions,
  };
}

/** A decoded Meteora event and the instruction that emitted it. */
export interface MeteoraEvent {
  program: MeteoraProgram;
  /** The IDL's event name, e.g. `EvtSwap2`. */
  name: string;
  data: DecodedStruct;
  /** Position among this transaction's Meteora events (0-based), stable across re-reads. */
  index: number;
  /** The instruction that emitted the event (e.g. `swap2`) with its accounts by IDL name; null when not found. */
  parent: { name: string | null; accounts: Record<string, string>; index: number } | null;
}

const isEventInstruction = (ix: NormalizedInstruction): MeteoraProgram | null => {
  const program = ix.programId === DBC_PROGRAM ? 'dbc' : ix.programId === DAMM_V2_PROGRAM ? 'damm-v2' : null;
  if (!program || ix.data.length < 16) return null;
  for (let i = 0; i < EVENT_IX_TAG.length; i++) if (ix.data[i] !== EVENT_IX_TAG[i]) return null;
  const authority = program === 'dbc' ? DBC_EVENT_AUTHORITY : DAMM_V2_EVENT_AUTHORITY;
  return ix.accounts[0] === authority ? program : null;
};

/**
 * Every DBC and DAMM v2 event in a transaction, in execution order. Failed transactions have none (their inner
 * instructions are not recorded). The emitting instruction is the nearest earlier instruction of the same program one
 * level up the call stack.
 */
export function decodeMeteoraEvents(tx: NormalizedTransaction): MeteoraEvent[] {
  if (tx.failed) return [];
  const { dbc, damm } = getCoders();
  const events: MeteoraEvent[] = [];
  const lastAtHeight = new Map<number, { ix: NormalizedInstruction; index: number }>();
  tx.instructions.forEach((ix, position) => {
    if (ix.stackHeight === 1) lastAtHeight.clear();
    const program = isEventInstruction(ix);
    if (!program) {
      lastAtHeight.set(ix.stackHeight, { ix, index: position });
      return;
    }
    const coder = program === 'dbc' ? dbc : damm;
    let decoded;
    try {
      decoded = coder.decodeEvent(ix.data.subarray(8));
    } catch {
      decoded = null;
    }
    if (!decoded) return;
    const candidate = lastAtHeight.get(ix.stackHeight - 1);
    let parent: MeteoraEvent['parent'] = null;
    if (candidate && candidate.ix.programId === ix.programId) {
      const meta = coder.instruction(candidate.ix.data);
      const accounts: Record<string, string> = {};
      meta?.accounts.forEach((name, i) => {
        if (candidate.ix.accounts[i] !== undefined) accounts[name] = candidate.ix.accounts[i];
      });
      parent = { name: meta?.name ?? null, accounts, index: candidate.index };
    }
    events.push({ program, name: decoded.name, data: decoded.data, index: events.length, parent });
  });
  return events;
}

// ── Trades ──────────────────────────────────────────────────────────────────────────────────────────

/** What the trade decoder needs to know about each pool of a launch. */
export interface TradePoolInfo {
  venue: MeteoraProgram;
  /** The revenue token's decimals. */
  baseDecimals: number;
  quoteDecimals?: number;
  /** DBC: the config's collect-fee mode (0 = quote token, the Epoch preset). */
  collectFeeMode?: number;
  /** DAMM v2: whether the revenue token is the pool's token A (true for DBC graduations). */
  baseIsTokenA?: boolean;
}

/** One buy or sell of a revenue token, from a swap event. Amounts in base units; prices in SOL per token. */
export interface LaunchTradeEvent {
  signature: string;
  /** The event's position in the transaction (with the signature, a unique key). */
  ix: number;
  slot: number;
  blockTime: number | null;
  venue: MeteoraProgram;
  pool: string;
  side: 'buy' | 'sell';
  /** The swap's payer (the wallet that traded; Epoch's buyback escrow for buybacks); null when not found. */
  trader: string | null;
  /** SOL leg in lamports: paid, fees included, for a buy; received, after fees, for a sell. */
  solAmount: bigint;
  /** Token leg in base units: received for a buy, sold for a sell. */
  tokenAmount: bigint;
  /** Every fee of the swap (trading, protocol, referral), in `feeInToken` units. */
  fee: bigint;
  feeInToken: boolean;
  /** Execution price before fees, SOL per token. */
  priceSol: number;
  /** The pool's price after the trade, SOL per token. */
  postPriceSol: number;
  /** SOL in the pool after the trade (DBC: the curve's quote reserve; DAMM v2: the SOL reserve), lamports. */
  quoteReserve: bigint | null;
}

const big = (value: unknown): bigint => (typeof value === 'bigint' ? value : BigInt((value as number) ?? 0));
const field = (data: DecodedStruct, key: string): DecodedStruct => (data[key] ?? {}) as DecodedStruct;

const executionPrice = (sol: bigint, tokens: bigint, baseDecimals: number, quoteDecimals: number): number => {
  const tokenUi = fromBaseUnits(tokens, baseDecimals);
  return tokenUi > 0 ? fromBaseUnits(sol, quoteDecimals) / tokenUi : 0;
};

function dbcTrade(
  event: MeteoraEvent,
  pool: TradePoolInfo,
): Omit<LaunchTradeEvent, 'signature' | 'slot' | 'blockTime'> {
  const data = event.data;
  const direction = Number(data.tradeDirection);
  const side = direction === TradeDirection.QuoteToBase ? 'buy' : 'sell';
  const result = field(data, 'swapResult');
  const fee = big(result.tradingFee) + big(result.protocolFee) + big(result.referralFee);
  const quoteDecimals = pool.quoteDecimals ?? SOL_DECIMALS;
  const mode = getFeeMode(pool.collectFeeMode ?? 0, direction, Boolean(data.hasReferral));
  // EvtSwap2 carries included/excluded input amounts; the legacy EvtSwap has amount_in and actual_input_amount.
  const included = event.name === 'EvtSwap2' ? big(result.includedFeeInputAmount) : big(data.amountIn);
  const excluded = event.name === 'EvtSwap2' ? big(result.excludedFeeInputAmount) : big(result.actualInputAmount);
  const output = big(result.outputAmount);
  const grossOutput = output + (mode.feesOnInput ? 0n : fee);
  const [solAmount, tokenAmount] = side === 'buy' ? [included, output] : [output, included];
  const [solNet, tokensNet] = side === 'buy' ? [excluded, grossOutput] : [grossOutput, excluded];
  return {
    ix: event.index,
    venue: 'dbc',
    pool: String(data.pool),
    side,
    trader: event.parent?.accounts.payer ?? null,
    solAmount,
    tokenAmount,
    fee,
    feeInToken: mode.feesOnBaseToken,
    priceSol: executionPrice(solNet, tokensNet, pool.baseDecimals, quoteDecimals),
    postPriceSol: sqrtPriceX64ToPrice(big(result.nextSqrtPrice), pool.baseDecimals, quoteDecimals),
    quoteReserve: event.name === 'EvtSwap2' ? big(data.quoteReserveAmount) : null,
  };
}

function dammTrade(
  event: MeteoraEvent,
  pool: TradePoolInfo,
): Omit<LaunchTradeEvent, 'signature' | 'slot' | 'blockTime'> {
  const data = event.data;
  const baseIsA = pool.baseIsTokenA ?? true;
  const direction = Number(data.tradeDirection);
  const aToB = direction === DammDirection.AtoB;
  // Selling the token is A → B when the token is A.
  const side = aToB === baseIsA ? 'sell' : 'buy';
  const result = field(data, 'swapResult');
  const fee = big(result.claimingFee) + big(result.compoundingFee) + big(result.protocolFee) + big(result.referralFee);
  const quoteDecimals = pool.quoteDecimals ?? SOL_DECIMALS;
  const mode = getDammFeeMode(Number(data.collectFeeMode), direction, Boolean(data.hasReferral));
  const feeInToken = mode.feesOnTokenA === baseIsA;
  const included = big(result.includedFeeInputAmount);
  const excluded = big(result.excludedFeeInputAmount);
  const output = big(result.outputAmount);
  const grossOutput = output + (mode.feesOnInput ? 0n : fee);
  const [solAmount, tokenAmount] = side === 'buy' ? [included, output] : [output, included];
  const [solNet, tokensNet] = side === 'buy' ? [excluded, grossOutput] : [grossOutput, excluded];
  const priceAinB = sqrtPriceX64ToPrice(
    big(result.nextSqrtPrice),
    baseIsA ? pool.baseDecimals : quoteDecimals,
    baseIsA ? quoteDecimals : pool.baseDecimals,
  );
  return {
    ix: event.index,
    venue: 'damm-v2',
    pool: String(data.pool),
    side,
    trader: event.parent?.accounts.payer ?? null,
    solAmount,
    tokenAmount,
    fee,
    feeInToken,
    priceSol: executionPrice(solNet, tokensNet, pool.baseDecimals, quoteDecimals),
    postPriceSol: baseIsA ? priceAinB : priceAinB > 0 ? 1 / priceAinB : 0,
    quoteReserve: big(baseIsA ? data.reserveBAmount : data.reserveAAmount),
  };
}

/** The buys and sells of known pools in one transaction (other pools' swaps are ignored). */
export function launchTradesFromTransaction(
  tx: NormalizedTransaction,
  pools: ReadonlyMap<string, TradePoolInfo>,
  events: MeteoraEvent[] = decodeMeteoraEvents(tx),
): LaunchTradeEvent[] {
  const trades: LaunchTradeEvent[] = [];
  // DBC's swap2 emits the legacy EvtSwap next to EvtSwap2 for the same swap: count the EvtSwap2 and drop its twin.
  const swap2Parents = new Set(
    events
      .filter((event) => event.program === 'dbc' && event.name === 'EvtSwap2' && event.parent)
      .map((event) => event.parent?.index),
  );
  for (const event of events) {
    const poolAddress = String(event.data.pool ?? '');
    const pool = pools.get(poolAddress);
    if (!pool || pool.venue !== event.program) continue;
    if (event.name === 'EvtSwap' && event.parent && swap2Parents.has(event.parent.index)) continue;
    let trade;
    if (event.program === 'dbc' && (event.name === 'EvtSwap2' || event.name === 'EvtSwap')) {
      trade = dbcTrade(event, pool);
    } else if (event.program === 'damm-v2' && event.name === 'EvtSwap2') {
      trade = dammTrade(event, pool);
    }
    if (trade) trades.push({ signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, ...trade });
  }
  return trades;
}

// ── Fee claims, graduation, migration ───────────────────────────────────────────────────────────────

export type LaunchFeeEventKind =
  | 'partnerTradingFee'
  | 'creatorTradingFee'
  | 'partnerMigrationFee'
  | 'creatorMigrationFee'
  | 'partnerSurplus'
  | 'creatorSurplus'
  | 'leftover'
  | 'lpFee'
  | 'curveComplete'
  | 'dammPoolCreated';

/** A claim, withdrawal or lifecycle event of a launch's pools. */
export interface LaunchFeeEvent {
  signature: string;
  ix: number;
  slot: number;
  blockTime: number | null;
  kind: LaunchFeeEventKind;
  /** The pool the event names (the DBC pool, or the DAMM v2 pool for `lpFee` and `dammPoolCreated`). */
  pool: string;
  /** SOL moved (or the curve's quote reserve for `curveComplete`), lamports. */
  solAmount: bigint;
  /** Tokens moved, base units. */
  tokenAmount: bigint;
  /** Who received it, when the event or its instruction names them. */
  owner: string | null;
}

/**
 * The fee claims and lifecycle events of known pools in one transaction. `dammPools` maps each DAMM v2 pool to whether
 * the revenue token is its token A, so LP fees can be split into SOL and tokens.
 */
export function launchFeeEventsFromTransaction(
  tx: NormalizedTransaction,
  dbcPools: ReadonlySet<string>,
  dammPools: ReadonlyMap<string, { baseIsTokenA: boolean }>,
  events: MeteoraEvent[] = decodeMeteoraEvents(tx),
): LaunchFeeEvent[] {
  const out: LaunchFeeEvent[] = [];
  const push = (event: MeteoraEvent, kind: LaunchFeeEventKind, sol: bigint, tokens: bigint, owner: string | null) =>
    out.push({
      signature: tx.signature,
      ix: event.index,
      slot: tx.slot,
      blockTime: tx.blockTime,
      kind,
      pool: String(event.data.pool),
      solAmount: sol,
      tokenAmount: tokens,
      owner,
    });
  for (const event of events) {
    const data = event.data;
    const pool = String(data.pool ?? '');
    const accounts = event.parent?.accounts ?? {};
    if (event.program === 'dbc' && dbcPools.has(pool)) {
      switch (event.name) {
        case 'EvtClaimTradingFee':
          push(
            event,
            'partnerTradingFee',
            big(data.tokenQuoteAmount),
            big(data.tokenBaseAmount),
            accounts.fee_claimer ?? null,
          );
          break;
        case 'EvtClaimCreatorTradingFee':
          push(
            event,
            'creatorTradingFee',
            big(data.tokenQuoteAmount),
            big(data.tokenBaseAmount),
            accounts.creator ?? null,
          );
          break;
        case 'EvtWithdrawMigrationFee':
          push(
            event,
            Number(data.flag) === 1 ? 'creatorMigrationFee' : 'partnerMigrationFee',
            big(data.fee),
            0n,
            accounts.sender ?? null,
          );
          break;
        case 'EvtPartnerWithdrawSurplus':
          push(event, 'partnerSurplus', big(data.surplusAmount), 0n, accounts.fee_claimer ?? null);
          break;
        case 'EvtCreatorWithdrawSurplus':
          push(event, 'creatorSurplus', big(data.surplusAmount), 0n, accounts.creator ?? null);
          break;
        case 'EvtWithdrawLeftover':
          push(event, 'leftover', 0n, big(data.leftoverAmount), String(data.leftoverReceiver));
          break;
        case 'EvtCurveComplete':
          push(event, 'curveComplete', big(data.quoteReserve), big(data.baseReserve), null);
          break;
        default:
          break;
      }
    } else if (event.program === 'damm-v2' && dammPools.has(pool)) {
      const baseIsA = dammPools.get(pool)?.baseIsTokenA ?? true;
      if (event.name === 'EvtClaimPositionFee') {
        const [tokens, sol] = baseIsA
          ? [big(data.feeAClaimed), big(data.feeBClaimed)]
          : [big(data.feeBClaimed), big(data.feeAClaimed)];
        push(event, 'lpFee', sol, tokens, String(data.owner));
      } else if (event.name === 'EvtInitializePool') {
        const [tokens, sol] = baseIsA
          ? [big(data.tokenAAmount), big(data.tokenBAmount)]
          : [big(data.tokenBAmount), big(data.tokenAAmount)];
        push(event, 'dammPoolCreated', sol, tokens, String(data.creator));
      }
    }
  }
  return out;
}
