import {
  type FeeQuoteAccount,
  type PoolParams,
  type Side,
  type SwapPositionAccount,
  swapCollateral,
  takerPnl,
  trailingRevenue,
} from '@epoch/epoch-sdk';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { isoIst, shortKey } from '../../Lib/Stats';
import { type ProgramAccount } from '../../Sources/EpochProgramSource';
import {
  type EpochIndexValue,
  type FeeMarketSnapshot,
  type FeeQuote,
  type QuoteStatus,
  type SwapPosition,
} from '../../types/Program.types';
import { averageRevenue } from './AdvanceView';
import { type FeeIndexView, loadFeeIndexView } from './FeeIndexView';
import { big, bpsText, ceilDiv, payload, toSol } from './ProgramFormat';
import { type ProgramServiceDeps } from './ProgramSources';
import { loadValidatorNames } from './ValidatorNames';

/** We disclose that Epoch seeds the other side of every swap (ADR 0004). */
export const MAKER_LABEL = 'Epoch market maker (seeded)';
/** The hedged rule (plan F7, request #21, decision 21). */
export const HEDGE_EPOCHS_AHEAD = 5;
export const HEDGE_MIN_SHARE_PCT = 50;
/** Quotes the maker already closed are rebuilt from events this far back (the program keeps 16 final values). */
const CLOSED_QUOTE_EPOCHS = 16;
const RECENT_SWAPS = 30;
const MY_POSITIONS = 100;
const EVENT_LIMIT = 10_000;

/** A taker's payoff in lamports at an index value: the program's `taker_pnl`, clipped to ± the collateral. */
export const swapPnlLamports = (
  side: Side,
  notional: bigint,
  fixedRate: bigint,
  indexValue: bigint,
  maxMoveBps: number,
): bigint => takerPnl(side, notional, fixedRate, indexValue, swapCollateral(notional, maxMoveBps));

/** Where a quote is in its life: trading, its epoch running, waiting to settle, or done. */
export function quoteStatus(
  quoteEpoch: number,
  expirySlot: number | null,
  openSwaps: number,
  epoch: number,
  slot: number,
): QuoteStatus {
  if (epoch < quoteEpoch) return expirySlot !== null && slot >= expirySlot ? 'live' : 'open';
  if (epoch === quoteEpoch) return 'live';
  return openSwaps > 0 ? 'settling' : 'settled';
}

/** One quote with the events of its swaps. */
interface QuoteState {
  address: string;
  maker: string;
  epoch: number;
  fixedRate: bigint;
  maxNotional: bigint;
  filledNotional: bigint;
  maxMoveBps: number;
  /** Null for a quote rebuilt from events (`QuotePosted` has no expiry). */
  expirySlot: number | null;
  /** Maker collateral on the quote now (at close for a closed one). */
  collateral: bigint;
  locked: bigint;
  openSwaps: number;
  /** SwapOpened events on this quote. */
  opened: StoredProgramEvent[];
  /** SwapSettled events of those swaps, by swap address. */
  settled: Map<string, StoredProgramEvent>;
}

const hedgeRuleText = (params: PoolParams | undefined): string =>
  `A validator counts as hedged while it holds Receive-fixed swaps on each of the next ${HEDGE_EPOCHS_AHEAD} epochs, each at least half its average revenue per epoch.` +
  (params
    ? ` Hedged validators borrow up to ${bpsText(params.advanceBpsHedged)}% of 10 epochs' swept revenue instead of ${bpsText(params.advanceBpsUnhedged)}%.`
    : '');

/** `GET /v1/market` (request #19): Epoch's quotes, the Fee Index, stats and the session wallet's swaps. */
export class FeeMarketService {
  constructor(private readonly deps: ProgramServiceDeps) {}

  async snapshot(sessionAddress?: string): Promise<FeeMarketSnapshot> {
    const { program, events } = this.deps;
    const { account: pool } = await program.requirePool();
    const maker = program.marketMaker?.toBase58() ?? null;
    const [info, accounts, swaps, positions, index, names] = await Promise.all([
      program.epochInfo(),
      program.quotes(),
      program.swaps(),
      program.positions(),
      loadFeeIndexView(program, events),
      loadValidatorNames(this.deps.validators),
    ]);
    const epoch = info.epoch;

    // ── Quotes: only Epoch's maker (post_quote is open to any key) ──
    let states: QuoteState[] = [];
    let makerQuotes = new Set<string>();
    /** max_move_bps of every quote the maker posted, for settled swaps whose quote is gone. */
    const maxMoveByQuote = new Map<string, number>();
    if (maker) {
      const current = accounts.filter((a) => a.account.maker.toBase58() === maker);
      const posted = await events.query({ names: ['QuotePosted'], where: { maker }, limit: EVENT_LIMIT });
      makerQuotes = new Set([
        ...current.map((a) => a.address),
        ...posted.map((e) => String(payload(e, 'QuotePosted').quote)),
      ]);
      const live = new Set(current.map((a) => a.address));
      const latestPost = new Map<string, StoredProgramEvent>();
      for (const event of posted) {
        const fields = payload(event, 'QuotePosted');
        const address = String(fields.quote);
        if (!latestPost.has(address)) latestPost.set(address, event);
        if (!maxMoveByQuote.has(address)) maxMoveByQuote.set(address, Number(fields.maxMoveBps));
      }
      const closed = [...latestPost.entries()].filter(([address, event]) => {
        const quoteEpoch = Number(payload(event, 'QuotePosted').epoch);
        return !live.has(address) && quoteEpoch <= epoch && quoteEpoch >= epoch - CLOSED_QUOTE_EPOCHS;
      });
      states = await Promise.all([
        ...current.map((a) => this.fromAccount(a)),
        ...closed.map(([address, event]) => this.fromEvents(address, event)),
      ]);
      states.sort((a, b) => a.epoch - b.epoch);
    }
    const quotes = await Promise.all(states.map((q) => this.quoteOut(q, index, epoch, info.absoluteSlot)));
    const quoteByAddress = new Map(quotes.map((q) => [q.address ?? '', q]));
    const settledBySwap = new Map<string, StoredProgramEvent>();
    const openedBySwap = new Map<string, StoredProgramEvent>();
    for (const q of states) {
      for (const [swap, event] of q.settled) settledBySwap.set(swap, event);
      for (const event of q.opened) openedBySwap.set(String(payload(event, 'SwapOpened').swap), event);
    }

    // ── Stats ──
    const openOnEpoch = swaps.filter((s) => !s.account.settled && quoteByAddress.has(s.account.quote.toBase58()));
    const lastSettled = [...quotes].reverse().find((q) => q.status === 'settled' && q.swaps > 0);

    // ── The session wallet ──
    const operators = new Map(positions.map((p) => [p.account.operator.toBase58(), p.account.vote.toBase58()]));
    let myHedge: FeeMarketSnapshot['myHedge'] = null;
    let myPositions: SwapPosition[] = [];
    if (sessionAddress) {
      const mine = swaps.filter((s) => s.account.taker.toBase58() === sessionAddress);
      const operated = positions.find((p) => p.account.operator.toBase58() === sessionAddress);
      if (operated) {
        const p = operated.account;
        const vote = p.vote.toBase58();
        // Each swap must be at least half the average revenue: notional × 2 × count ≥ trailing revenue.
        const minNotional = p.revenueCount > 0 ? ceilDiv(trailingRevenue(p), 2n * BigInt(p.revenueCount)) : 0n;
        const byQuote = new Map(mine.map((s) => [s.account.quote.toBase58(), s.account]));
        const open = quotes.filter((q) => q.status === 'open');
        myHedge = {
          vote,
          name: names.nameOf(vote),
          averageRevenuePerEpochSol: toSol(averageRevenue(p)),
          minNotionalSol: toSol(minNotional),
          hedgedEpochs: open
            .filter((q) => {
              const held = byQuote.get(q.address ?? '');
              return held !== undefined && held.side === 'receiveFixed' && held.notional >= minNotional;
            })
            .map((q) => q.epoch),
          epochsToHedge: open.filter((q) => !byQuote.has(q.address ?? '')).map((q) => q.epoch),
        };
      }
      myPositions = await this.myPositions(sessionAddress, epoch, mine, makerQuotes, quoteByAddress, index, {
        openedBySwap,
        settledBySwap,
        maxMoveByQuote,
      });
    }

    // ── Recent swaps on Epoch's quotes, newest first ──
    const recent = (await events.query({ names: ['SwapOpened'], limit: 1_000 }))
      .filter((e) => makerQuotes.has(String(payload(e, 'SwapOpened').quote)))
      .slice(0, RECENT_SWAPS);
    const recentSwaps: FeeMarketSnapshot['recentSwaps'] = recent.map((event) => {
      const fields = payload(event, 'SwapOpened');
      const taker = String(fields.taker);
      const vote = operators.get(taker) ?? null;
      const settled = settledBySwap.get(String(fields.swap));
      return {
        epoch: Number(fields.epoch),
        side: fields.side as Side,
        notionalSol: toSol(big(fields.notional)),
        fixedRate: Number(big(fields.fixedRate)),
        who: taker === sessionAddress ? 'You' : vote ? names.nameOf(vote) : shortKey(taker),
        vote: taker === sessionAddress ? null : vote,
        // A quote missing from the list closed more than 16 epochs ago: every swap on it settled.
        status: quoteByAddress.get(String(fields.quote))?.status ?? 'settled',
        pnlSol: settled ? toSol(big(payload(settled, 'SwapSettled').takerPnl)) : null,
        signature: event.signature,
      };
    });

    const notes: string[] = [];
    if (!maker) {
      notes.push(
        "EPOCH_MARKET_MAKER isn't set on this API, so no quotes are listed: post_quote is open to any key and only Epoch's maker may show as Epoch's.",
      );
    }
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(this.deps.now?.()),
      source: `Epoch program on ${program.cluster}: FeeQuote, SwapPosition, FeeIndex accounts and swap events`,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      network: program.cluster,
      currentEpoch: epoch,
      index: {
        finalEpoch: index.final?.epoch ?? null,
        finalValue: index.final?.value ?? null,
        proposed: index.proposed,
        avg8: index.avg8,
      },
      quotes,
      stats: {
        openInterestSol: toSol(openOnEpoch.reduce((total, s) => total + s.account.notional, 0n)),
        openSwaps: openOnEpoch.length,
        hedgedValidators: positions.filter((p) => p.account.hedged && p.account.status !== 'released').length,
        lastSettled: lastSettled
          ? {
              epoch: lastSettled.epoch,
              swaps: lastSettled.swaps,
              notionalSol: lastSettled.filledNotionalSol,
              netToTakersSol: lastSettled.netToTakersSol ?? 0,
            }
          : null,
      },
      hedgeRule: {
        epochsAhead: HEDGE_EPOCHS_AHEAD,
        minNotionalShareOfRevenuePct: HEDGE_MIN_SHARE_PCT,
        text: hedgeRuleText(pool.params),
      },
      myHedge,
      myPositions,
      recentSwaps,
    };
  }

  private async swapEvents(address: string, quoteEpoch: number): Promise<Pick<QuoteState, 'opened' | 'settled'>> {
    const [opened, settledOnEpoch] = await Promise.all([
      this.deps.events.query({ names: ['SwapOpened'], where: { quote: address }, limit: EVENT_LIMIT }),
      // SwapSettled carries no quote: take the epoch's settlements and keep this quote's swaps.
      this.deps.events.query({ names: ['SwapSettled'], where: { epoch: String(quoteEpoch) }, limit: EVENT_LIMIT }),
    ]);
    const ours = new Set(opened.map((e) => String(payload(e, 'SwapOpened').swap)));
    const settled = new Map<string, StoredProgramEvent>();
    for (const event of settledOnEpoch) {
      const swap = String(payload(event, 'SwapSettled').swap);
      if (ours.has(swap) && !settled.has(swap)) settled.set(swap, event);
    }
    return { opened, settled };
  }

  private async fromAccount({ address, account }: ProgramAccount<FeeQuoteAccount>): Promise<QuoteState> {
    const epoch = Number(account.epoch);
    return {
      address,
      maker: account.maker.toBase58(),
      epoch,
      fixedRate: account.fixedRate,
      maxNotional: account.maxNotional,
      filledNotional: account.filledNotional,
      maxMoveBps: account.maxMoveBps,
      expirySlot: Number(account.expirySlot),
      collateral: account.collateral,
      locked: account.lockedCollateral,
      openSwaps: account.openSwaps,
      ...(await this.swapEvents(address, epoch)),
    };
  }

  /** A quote the maker closed (`withdraw_quote` needs no open swap), rebuilt from QuotePosted and its swaps' events. */
  private async fromEvents(address: string, posted: StoredProgramEvent): Promise<QuoteState> {
    const fields = payload(posted, 'QuotePosted');
    const epoch = Number(fields.epoch);
    const maxNotional = big(fields.maxNotional);
    const maxMoveBps = Number(fields.maxMoveBps);
    const swapEvents = await this.swapEvents(address, epoch);
    const paidToTakers = [...swapEvents.settled.values()].reduce(
      (total, e) => total + big(payload(e, 'SwapSettled').takerPnl),
      0n,
    );
    return {
      address,
      maker: String(fields.maker),
      epoch,
      fixedRate: big(fields.fixedRate),
      maxNotional,
      filledNotional: swapEvents.opened.reduce((total, e) => total + big(payload(e, 'SwapOpened').notional), 0n),
      maxMoveBps,
      expirySlot: null,
      // post_quote locks bps_of(max_notional, max_move_bps); each settlement moves the taker's payoff out (or in).
      collateral: swapCollateral(maxNotional, maxMoveBps) - paidToTakers,
      locked: 0n,
      openSwaps: 0,
      ...swapEvents,
    };
  }

  private async quoteOut(q: QuoteState, index: FeeIndexView, epoch: number, slot: number): Promise<FeeQuote> {
    const epochStartSlot = await this.deps.program.firstSlotOfEpoch(q.epoch);
    const settledPnl = [...q.settled.values()].map((e) => big(payload(e, 'SwapSettled').takerPnl));
    return {
      address: q.address,
      maker: q.maker,
      makerLabel: MAKER_LABEL,
      epoch: q.epoch,
      fixedRate: Number(q.fixedRate),
      maxNotionalSol: toSol(q.maxNotional),
      filledNotionalSol: toSol(q.filledNotional),
      maxMoveBps: q.maxMoveBps,
      expirySlot: q.expirySlot ?? epochStartSlot,
      epochStartSlot,
      makerCollateralSol: toSol(q.collateral),
      lockedCollateralSol: toSol(q.locked),
      openSwaps: q.openSwaps,
      swaps: Math.max(q.opened.length, q.openSwaps),
      status: quoteStatus(q.epoch, q.expirySlot, q.openSwaps, epoch, slot),
      index: index.valueFor(q.epoch),
      netToTakersSol: settledPnl.length > 0 ? toSol(settledPnl.reduce((total, pnl) => total + pnl, 0n)) : null,
    };
  }

  /** Open SwapPosition accounts of the wallet, then its settled swaps (SwapSettled joined with SwapOpened). */
  private async myPositions(
    wallet: string,
    currentEpoch: number,
    open: ProgramAccount<SwapPositionAccount>[],
    makerQuotes: Set<string>,
    quoteByAddress: Map<string, FeeQuote>,
    index: FeeIndexView,
    known: {
      openedBySwap: Map<string, StoredProgramEvent>;
      settledBySwap: Map<string, StoredProgramEvent>;
      maxMoveByQuote: Map<string, number>;
    },
  ): Promise<SwapPosition[]> {
    const { events } = this.deps;
    const out: SwapPosition[] = [];
    const openAddresses = new Set<string>();
    for (const { address, account } of open) {
      const quote = account.quote.toBase58();
      if (!makerQuotes.has(quote)) continue;
      openAddresses.add(address);
      const epoch = Number(account.epoch);
      const value: EpochIndexValue | null = index.valueFor(epoch);
      // Final: what settle_swap will pay; proposed: an estimate; vetoed or none: unknown.
      const pnl =
        value && value.status !== 'vetoed'
          ? takerPnl(account.side, account.notional, account.fixedRate, BigInt(value.value), account.collateral)
          : null;
      out.push({
        address,
        quote,
        epoch,
        side: account.side,
        notionalSol: toSol(account.notional),
        fixedRate: Number(account.fixedRate),
        maxMoveBps: account.maxMoveBps,
        collateralSol: toSol(account.collateral),
        // An open position keeps its quote account alive, so the quote is listed; the fallback is defensive.
        status: quoteByAddress.get(quote)?.status ?? quoteStatus(epoch, null, 1, currentEpoch, 0),
        index: value,
        pnlSol: pnl === null ? null : toSol(pnl),
        openedSignature: known.openedBySwap.get(address)?.signature ?? null,
        settledSignature: null,
      });
    }

    const opened = await events.query({ names: ['SwapOpened'], where: { taker: wallet }, limit: 500 });
    const closed = opened.filter((e) => {
      const fields = payload(e, 'SwapOpened');
      return makerQuotes.has(String(fields.quote)) && !openAddresses.has(String(fields.swap));
    });
    const missing = closed
      .map((e) => String(payload(e, 'SwapOpened').swap))
      .filter((swap) => !known.settledBySwap.has(swap))
      .slice(0, 50);
    const lookups = await Promise.all(
      missing.map((swap) => events.query({ names: ['SwapSettled'], where: { swap }, limit: 1 })),
    );
    const settledBySwap = new Map(known.settledBySwap);
    lookups.forEach((list, i) => {
      if (list[0]) settledBySwap.set(missing[i], list[0]);
    });
    for (const event of closed) {
      const fields = payload(event, 'SwapOpened');
      const swap = String(fields.swap);
      const settled = settledBySwap.get(swap);
      // A closed position without its SwapSettled event has no payoff we can show truthfully.
      if (!settled) continue;
      const result = payload(settled, 'SwapSettled');
      const notional = big(fields.notional);
      out.push({
        address: swap,
        quote: String(fields.quote),
        epoch: Number(fields.epoch),
        side: fields.side as Side,
        notionalSol: toSol(notional),
        fixedRate: Number(big(fields.fixedRate)),
        maxMoveBps: known.maxMoveByQuote.get(String(fields.quote)) ?? maxMoveOf(notional, big(fields.collateral)),
        collateralSol: toSol(big(fields.collateral)),
        status: 'settled',
        index: { value: Number(big(result.indexValue)), status: 'final' },
        pnlSol: toSol(big(result.takerPnl)),
        openedSignature: event.signature,
        settledSignature: settled.signature,
      });
    }
    return out.sort((a, b) => b.epoch - a.epoch).slice(0, MY_POSITIONS);
  }
}

/** A swap's max move in bps from its collateral, when its quote is gone (collateral = notional × bps ÷ 10,000). */
const maxMoveOf = (notional: bigint, collateral: bigint): number =>
  notional > 0n ? Number(ceilDiv(collateral * 10_000n, notional)) : 0;
