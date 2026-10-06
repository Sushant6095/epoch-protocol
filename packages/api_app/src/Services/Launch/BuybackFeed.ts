import {
  accountFilters,
  decodeRevenueToken,
  type EventName,
  fieldFilter,
  findBuybackEscrowPda,
  findPartnerTreasuryPda,
  findPoolPda,
  type RevenueTokenAccount,
  revenueTokenBuybacksPaused,
  revenueTokenInTerm,
  revenueTokenRedeemOpen,
  sliceDueSlot,
} from '@epoch/epoch-sdk';
import { BadRequestException } from '@epoch/exceptions';
import { BUYBACK_SLICES_PER_EPOCH } from '@epoch/meteora';
import { PublicKey } from '@solana/web3.js';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { isoIst, LAMPORTS_PER_SOL } from '../../Lib/Stats';
import { type EpochProgramSource, type ProgramEpochInfo } from '../../Sources/EpochProgramSource';
import { type LaunchBuyback } from '../../types/Launch.types';
import {
  type BuybackSchedule,
  type LaunchBuybackFeed,
  type LaunchRevenueTokenClosed,
  type LaunchTreasuryClaims,
  type TreasuryClaimKind,
  type TreasuryClaimTotals,
} from '../../types/Buyback.types';
import { type EventReader } from '../Program/ProgramSources';

/** Average slot time used for the next slice's ETA. */
const SLOT_SECONDS = 0.4;
const BUYBACK_EVENTS: readonly EventName[] = ['BuybackExecuted'];
const TREASURY_EVENTS: readonly EventName[] = ['TreasuryClaimed'];
/** A closed token's history: everything the program said about the mint once its account is gone. */
const CLOSED_HISTORY_EVENTS: readonly EventName[] = [
  'RevenueTokenRegistered',
  'RevenueTokenConfigured',
  'BuybackExecuted',
  'RevenueTokenRedeemed',
  'RevenueTokenClosed',
];
/** Treasury totals add up the newest claims up to the event store's maximum page. */
const TREASURY_TOTALS_LIMIT = 10_000;
const TREASURY_CLAIM_KINDS: readonly TreasuryClaimKind[] = [
  'tradingFee',
  'surplus',
  'migrationFee',
  'leftover',
  'lpFee',
];

/** What the feed reads from the program's cluster; `RpcBuybackChainReader` is the real one. */
export interface BuybackChainReader {
  readonly network: string;
  revenueTokenByMint(mint: PublicKey): Promise<{ address: PublicKey; account: RevenueTokenAccount } | null>;
  /** Escrow lamports above its rent-exempt minimum. */
  escrowAvailable(address: PublicKey): Promise<bigint>;
  decimals(mint: PublicKey): Promise<number>;
  epochInfo(): Promise<ProgramEpochInfo>;
  escrowAddress(vote: PublicKey): PublicKey;
  /** The partner treasury PDA (`["treasury", pool]`); null without a program id. */
  treasuryAddress(): PublicKey | null;
}

export interface BuybackFeedDeps {
  chain: BuybackChainReader;
  events: EventReader;
  /** Buybacks listed, newest first (default 200). */
  limit?: number;
  now?: () => Date;
}

const sol = (lamports: bigint): number => Number(lamports) / LAMPORTS_PER_SOL;
const ui = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

/**
 * `GET /v1/launches/:mint/buybacks`: the revenue token's escrow, schedule and every `BuybackExecuted` for the mint
 * (from the ingested program events), with totals from the account itself; and every `TreasuryClaimed` for the mint
 * (the partner treasury's Meteora fees to lenders, its tokens burned).
 */
export class BuybackFeed {
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(private readonly deps: BuybackFeedDeps) {
    this.limit = deps.limit ?? 200;
    this.now = deps.now ?? (() => new Date());
  }

  async get(mintText: string): Promise<LaunchBuybackFeed> {
    let mint: PublicKey;
    try {
      mint = new PublicKey(mintText);
    } catch {
      throw new BadRequestException('Not a base58 mint', { mint: mintText });
    }
    const { chain } = this.deps;
    const found = await chain.revenueTokenByMint(mint);
    const meta = {
      schemaVersion: 1 as const,
      kind: 'real' as const,
      asOf: isoIst(this.now()),
      source: `Epoch program (${chain.network})`,
      network: chain.network,
      mint: mint.toBase58(),
    };
    // Treasury claims need no revenue token account: any launch naming the treasury has them.
    const treasuryEvents = queryTreasuryClaims(this.deps.events, mint.toBase58());
    if (!found) {
      const [decimals, claims, history] = await Promise.all([
        chain.decimals(mint),
        treasuryEvents,
        this.deps.events.query({
          names: CLOSED_HISTORY_EVENTS,
          where: { mint: mint.toBase58() },
          limit: TREASURY_TOTALS_LIMIT,
        }),
      ]);
      const treasury = treasuryClaims(claims, decimals, mint.toBase58(), chain.treasuryAddress(), this.limit);
      // Closed after its term: the account is gone, the program's events still tell its story.
      const closed = closedFeed(history, decimals, this.limit);
      if (closed) return { ...meta, ...closed, treasury };
      return {
        ...meta,
        note: 'No validator has registered this mint as a revenue token.',
        revenueToken: null,
        vote: null,
        venue: null,
        term: null,
        escrow: { address: null, balanceSol: 0, mode: 'buyback' },
        schedule: null,
        totals: { escrowedSol: 0, spentSol: 0, burned: 0, redeemed: 0, redeemedSol: 0, buybacks: 0 },
        buybacks: [],
        treasury,
        closed: null,
      };
    }
    const { address, account: rt } = found;
    const escrow = chain.escrowAddress(rt.vote);
    const [escrowAvailable, decimals, epochInfo, events, claims] = await Promise.all([
      chain.escrowAvailable(escrow),
      chain.decimals(mint),
      chain.epochInfo(),
      this.deps.events.query({ names: BUYBACK_EVENTS, where: { mint: mint.toBase58() }, limit: this.limit }),
      treasuryEvents,
    ]);
    const epoch = BigInt(epochInfo.epoch);
    return {
      ...meta,
      revenueToken: address.toBase58(),
      vote: rt.vote.toBase58(),
      venue: rt.dammPool ? 'damm-v2' : 'dbc',
      term: {
        shareBps: rt.shareBps,
        termEpochs: rt.termEpochs,
        startEpoch: Number(rt.startEpoch),
        endEpoch: Number(rt.termEndEpoch) - 1,
      },
      escrow: {
        address: escrow.toBase58(),
        balanceSol: sol(escrowAvailable),
        mode: revenueTokenRedeemOpen(rt, epoch) ? 'redeem' : 'buyback',
      },
      schedule: buybackSchedule(rt, epochInfo, escrowAvailable),
      totals: {
        escrowedSol: sol(rt.totalEscrowed),
        spentSol: sol(rt.totalSpent),
        burned: ui(rt.totalBurned, decimals),
        redeemed: ui(rt.totalRedeemed, decimals),
        redeemedSol: sol(rt.totalRedeemedLamports),
        buybacks: rt.buybackCount,
      },
      buybacks: events.map((event) => toLaunchBuyback(event, rt.slicesPerEpoch, decimals)),
      treasury: treasuryClaims(claims, decimals, mint.toBase58(), chain.treasuryAddress(), this.limit),
      closed: null,
    };
  }
}

const u64 = (value: string | number | boolean | undefined): bigint => BigInt(String(value ?? 0));

/** A feed without the fields `get` adds around it (meta and the treasury section). */
type FeedBody = Omit<LaunchBuybackFeed, 'schemaVersion' | 'kind' | 'asOf' | 'source' | 'network' | 'mint' | 'treasury'>;

/**
 * A closed revenue token's feed (pure), from its events (newest first): the term from `RevenueTokenRegistered`, the
 * totals from `RevenueTokenClosed` (the account's last state) and the redemptions' SOL, the slices as before. Null when
 * the mint has no `RevenueTokenClosed`. Only the last registration's history counts, should a mint have had two.
 */
export function closedFeed(history: readonly StoredProgramEvent[], decimals: number, limit: number): FeedBody | null {
  const closedEvent = history.find((event) => event.name === 'RevenueTokenClosed');
  if (!closedEvent) return null;
  const vote = String(closedEvent.data.vote);
  const registered = history.find(
    (event) => event.name === 'RevenueTokenRegistered' && event.data.vote === vote && event.slot <= closedEvent.slot,
  );
  const ofThisTerm = (event: StoredProgramEvent) =>
    event.data.vote === vote && event.slot <= closedEvent.slot && (!registered || event.slot >= registered.slot);
  const configured = history.find((event) => event.name === 'RevenueTokenConfigured' && ofThisTerm(event));
  const slices = Number(configured?.data.slicesPerEpoch ?? 0) || BUYBACK_SLICES_PER_EPOCH;
  const buybacks = history.filter((event) => event.name === 'BuybackExecuted' && ofThisTerm(event));
  const redeemedLamports = history
    .filter((event) => event.name === 'RevenueTokenRedeemed' && ofThisTerm(event))
    .reduce((sum, event) => sum + u64(event.data.lamportsOut), 0n);
  const toPool = u64(closedEvent.data.lamportsToPool);
  const closed: LaunchRevenueTokenClosed = {
    epoch: closedEvent.epoch,
    at: closedEvent.blockTime ? isoIst(new Date(closedEvent.blockTime)) : null,
    signature: closedEvent.signature,
    unclaimedToPoolSol: sol(toPool),
  };
  const when = closedEvent.epoch === null ? '' : ` (epoch ${closedEvent.epoch})`;
  return {
    note:
      `Closed after its term${when}: ` +
      (toPool > 0n
        ? `the ${sol(toPool)} SOL holders had not redeemed went to the Epoch pool as income.`
        : 'the escrow was spent; its rent went back to the operator.'),
    revenueToken: registered ? String(registered.data.revenueToken) : null,
    vote,
    venue: null,
    term: registered
      ? {
          shareBps: Number(registered.data.shareBps),
          termEpochs: Number(registered.data.termEpochs),
          startEpoch: Number(registered.data.startEpoch),
          endEpoch: Number(registered.data.termEndEpoch) - 1,
        }
      : null,
    // The account and its escrow are gone: nothing left to buy back or redeem.
    escrow: { address: null, balanceSol: 0, mode: 'buyback' },
    schedule: null,
    totals: {
      escrowedSol: sol(u64(closedEvent.data.totalEscrowed)),
      spentSol: sol(u64(closedEvent.data.totalSpent)),
      burned: ui(u64(closedEvent.data.totalBurned), decimals),
      redeemed: ui(u64(closedEvent.data.totalRedeemed), decimals),
      redeemedSol: sol(redeemedLamports),
      buybacks: buybacks.length,
    },
    buybacks: buybacks.slice(0, limit).map((event) => toLaunchBuyback(event, slices, decimals)),
    closed,
  };
}

/**
 * Every `TreasuryClaimed` for the mint, newest first (up to the event store's maximum page): the one query behind the
 * treasury section of `/buybacks` and the lenders' figures of the Launch page's `/fees`, so the two always agree.
 */
export function queryTreasuryClaims(events: EventReader, mint: string): Promise<StoredProgramEvent[]> {
  return events.query({ names: TREASURY_EVENTS, where: { mint }, limit: TREASURY_TOTALS_LIMIT });
}

/**
 * The treasury section (pure): totals over every `TreasuryClaimed` given (newest first), by kind, and the newest
 * `listed` claims. SOL is what reached the pool (`lamportsToPool`), tokens what was burned. Sums are exact (lamports and
 * raw token units), converted once.
 */
export function treasuryClaims(
  events: readonly StoredProgramEvent[],
  decimals: number,
  mint: string,
  treasury: PublicKey | null,
  listed: number,
): LaunchTreasuryClaims {
  const raw = () => ({ lamports: 0n, tokens: 0n, claims: 0 });
  const sums = Object.fromEntries(TREASURY_CLAIM_KINDS.map((kind) => [kind, raw()])) as Record<
    TreasuryClaimKind,
    ReturnType<typeof raw>
  >;
  const total = raw();
  const units = (value: string | number | boolean | undefined): bigint =>
    typeof value === 'string' || typeof value === 'number' ? BigInt(value) : 0n;
  const claims = events.map((event) => {
    const { data } = event;
    const kind = (TREASURY_CLAIM_KINDS as readonly string[]).includes(String(data.kind))
      ? (data.kind as TreasuryClaimKind)
      : 'tradingFee';
    const lamports = units(data.lamportsToPool);
    const tokens = units(data.tokensBurned);
    for (const bucket of [total, sums[kind]]) {
      bucket.lamports += lamports;
      bucket.tokens += tokens;
      bucket.claims += 1;
    }
    const position = String(data.position ?? '');
    return {
      kind,
      epoch: event.epoch,
      source: String(data.source ?? ''),
      position: kind === 'lpFee' && position ? position : null,
      toLendersSol: sol(lamports),
      tokensBurned: ui(tokens, decimals),
      signature: event.signature,
    };
  });
  const totals = (sum: ReturnType<typeof raw>): TreasuryClaimTotals => ({
    toLendersSol: sol(sum.lamports),
    tokensBurned: ui(sum.tokens, decimals),
    claims: sum.claims,
  });
  return {
    address: treasury?.toBase58() ?? null,
    totals: totals(total),
    byKind: Object.fromEntries(TREASURY_CLAIM_KINDS.map((kind) => [kind, totals(sums[kind])])) as Record<
      TreasuryClaimKind,
      TreasuryClaimTotals
    >,
    claims: claims.slice(0, listed),
    claimable: `/v1/launches/${mint}/fees`,
  };
}

/** One `BuybackExecuted` as the contract's `LaunchBuyback` (pure). */
export function toLaunchBuyback(event: StoredProgramEvent, slices: number, decimals: number): LaunchBuyback {
  const { data } = event;
  const solIn = Number(data.lamportsIn) / LAMPORTS_PER_SOL;
  const tokensBurned = Number(data.tokensBurned) / 10 ** decimals;
  return {
    epoch: Number(data.epoch),
    slice: Number(data.slice),
    slices,
    solIn,
    tokensBurned,
    priceSol: tokensBurned > 0 ? solIn / tokensBurned : 0,
    venue: data.venue === 'dammV2' ? 'damm-v2' : 'dbc',
    signature: event.signature,
  };
}

/**
 * When the next slice can buy (pure), as the program decides it (`execute_buyback`): slices run in the first
 * `windowSlots` slots of an epoch, each from its due slot; in the term (`startEpoch` to `endEpoch`) only after that
 * epoch's sweep paid the share into the escrow; and only while the escrow holds SOL. So:
 * - before the term with an empty escrow: slice 0 of `startEpoch`, after its sweep;
 * - in the term, once this epoch's share is spent (swept, escrow empty): slice 0 of the next epoch, while it is in term;
 * - otherwise the first slice not done this epoch, from its due slot while the window is open, else slice 0 of the
 *   next epoch.
 * Null once nothing is left to buy: the term ended (or its last share is spent) and the escrow is empty.
 */
export function buybackSchedule(
  rt: RevenueTokenAccount,
  info: ProgramEpochInfo,
  escrowAvailable: bigint,
): BuybackSchedule {
  const epoch = BigInt(info.epoch);
  const done = rt.buybackEpoch === epoch ? rt.slicesDone : 0;
  let slicesDone = 0;
  for (let i = 0; i < rt.slicesPerEpoch; i++) if ((done >>> i) & 1) slicesDone++;
  const base = { slicesPerEpoch: rt.slicesPerEpoch, windowSlots: rt.windowSlots, slicesDoneThisEpoch: slicesDone };
  const paused = revenueTokenBuybacksPaused(rt);
  const empty = escrowAvailable === 0n;
  const none = { ...base, paused, nextSlice: null };
  // Slot 0 of a later epoch, `epochsAhead` from now (epochs keep their length).
  const epochStart = (target: bigint) =>
    info.slotsInEpoch - info.slotIndex + Number(target - epoch - 1n) * info.slotsInEpoch;
  const at = (slotsAhead: number, target: bigint, slice: number) => ({
    ...base,
    paused,
    nextSlice: {
      epoch: Number(target),
      slice,
      inSlots: slotsAhead,
      etaSeconds: Math.round(slotsAhead * SLOT_SECONDS),
      waitsForSweep: revenueTokenInTerm(rt, target) && rt.lastShareEpoch !== target,
    },
  });
  // The next epoch can only buy with a share (in the term) or with what the escrow still holds.
  const nextEpoch = () => {
    const next = epoch + 1n;
    return revenueTokenInTerm(rt, next) || !empty ? at(epochStart(next), next, 0) : none;
  };

  if (empty) {
    // Before the term: nothing to spend until the first share, swept in `startEpoch`.
    if (epoch < rt.startEpoch) return at(epochStart(rt.startEpoch), rt.startEpoch, 0);
    // The term is over (or this epoch's share is spent): the next share, if any.
    if (!revenueTokenInTerm(rt, epoch) || rt.lastShareEpoch === epoch) return nextEpoch();
  }
  if (info.slotIndex < rt.windowSlots) {
    for (let i = 0; i < rt.slicesPerEpoch; i++) {
      if ((done >>> i) & 1) continue;
      const due = Number(sliceDueSlot(i, rt.slicesPerEpoch, rt.windowSlots) ?? 0);
      return at(Math.max(0, due - info.slotIndex), epoch, i);
    }
  }
  return nextEpoch();
}

/** The feed's reads on the program's cluster, through the API's `EpochProgramSource` connections. */
export class RpcBuybackChainReader implements BuybackChainReader {
  private readonly decimalsCache = new Map<string, number>();
  private rent?: bigint;

  constructor(private readonly program: EpochProgramSource) {}

  get network(): string {
    return this.program.cluster;
  }

  escrowAddress(vote: PublicKey): PublicKey {
    return findBuybackEscrowPda(this.program.requireProgramId(), vote)[0];
  }

  treasuryAddress(): PublicKey | null {
    const programId = this.program.programId;
    return programId ? findPartnerTreasuryPda(programId, findPoolPda(programId)[0])[0] : null;
  }

  async revenueTokenByMint(mint: PublicKey): Promise<{ address: PublicKey; account: RevenueTokenAccount } | null> {
    const programId = this.program.requireProgramId();
    const accounts = await this.program.connections.withFailover((c) =>
      c.getProgramAccounts(programId, {
        commitment: 'confirmed',
        filters: [...accountFilters('RevenueToken'), fieldFilter('RevenueToken', 'mint', mint)],
      }),
    );
    const first = accounts[0];
    return first ? { address: first.pubkey, account: decodeRevenueToken(first.account.data) } : null;
  }

  async escrowAvailable(address: PublicKey): Promise<bigint> {
    this.rent ??= BigInt(await this.program.connections.withFailover((c) => c.getMinimumBalanceForRentExemption(0)));
    const lamports = BigInt(await this.program.connections.withFailover((c) => c.getBalance(address, 'confirmed')));
    return lamports > this.rent ? lamports - this.rent : 0n;
  }

  async decimals(mint: PublicKey): Promise<number> {
    const cached = this.decimalsCache.get(mint.toBase58());
    if (cached !== undefined) return cached;
    const info = await this.program.connections.withFailover((c) => c.getAccountInfo(mint, 'confirmed'));
    // SPL mint: decimals at byte 44.
    const decimals = info && info.data.length >= 45 ? info.data[44] : 0;
    this.decimalsCache.set(mint.toBase58(), decimals);
    return decimals;
  }

  epochInfo(): Promise<ProgramEpochInfo> {
    return this.program.epochInfo();
  }
}
