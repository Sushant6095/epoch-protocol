/**
 * Test-only: a tiny in-memory Epoch program. Each method mirrors one instruction's ledger math from
 * `programs/epoch/src/instructions/**` with epoch-sdk's exact integer functions, keeps the decoded accounts the
 * services read (`ProgramReader`) and emits the events the ingester would store (`eventToJson` payloads), so the
 * services under test see a world that obeys the program's rules. Excluded from the build (tsconfig).
 */
import { createHash } from 'crypto';

import { type EpochProgramConfig } from '@epoch/config-sdk';
import {
  type AdvanceAccount,
  assetsToShares,
  attributeRepayment,
  absorbLoss,
  bpsOf,
  distributeIncome,
  type EpochEvent,
  type EpochEventMap,
  eventToJson,
  type EventName,
  type FeeIndexAccount,
  type FeeQuoteAccount,
  feeIndexValueFor,
  HISTORY_SCORE_FLAGS,
  HISTORY_SOURCES,
  type HistoryEntry,
  juniorRatioBps,
  type LenderSharesAccount,
  type PoolAccount,
  type PoolParams,
  PROGRAM_CONSTANTS,
  type ScoreConfigAccount,
  sharePriceE9,
  sharesToAssets,
  type Side,
  splitSweep,
  type SwapPositionAccount,
  takerPnl,
  type Tranche,
  type ValidatorHistoryAccount,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { ServiceUnavailableException } from '@epoch/exceptions';
import { PublicKey } from '@solana/web3.js';

import { type StoredProgramEvent } from '../Lib/EventBus';
import { PLANNED_POOL_PARAMS } from '../Services/Program/PoolParamsView';
import { MemoryEventStore } from '../Services/Program/ProgramEventStore';
import { type ProgramReader } from '../Services/Program/ProgramSources';
import { type ProgramAccount, type ProgramEpochInfo } from '../Sources/EpochProgramSource';

export const SLOTS_PER_EPOCH = 432_000;

/** A deterministic public key for a label. */
export const key = (label: string): PublicKey => new PublicKey(createHash('sha256').update(label).digest());

/** SOL → lamports (exact for up to 9 decimals). */
export const sol = (amount: number): bigint => BigInt(Math.round(amount * 1e9));

const POOL = key('pool');

export class ProgramSim implements ProgramReader {
  cluster: EpochProgramConfig['EPOCH_CLUSTER'] = 'devnet';
  configured = true;
  marketMaker?: PublicKey;

  epoch: number;
  slot: number;
  poolState: PoolAccount | null = null;
  feeIndexAccount: FeeIndexAccount | null = null;
  readonly positionMap = new Map<string, ValidatorPositionAccount>();
  readonly advanceMap = new Map<string, AdvanceAccount>();
  readonly lenderMap = new Map<string, LenderSharesAccount>();
  readonly requestMap = new Map<bigint, WithdrawRequestAccount>();
  readonly quoteMap = new Map<string, FeeQuoteAccount>();
  readonly swapMap = new Map<string, SwapPositionAccount>();
  readonly historyMap = new Map<string, ValidatorHistoryAccount>();
  scoreConfigAccount: ScoreConfigAccount | null = null;
  readonly stored: StoredProgramEvent[] = [];
  /** Ground truth recorded at every accrual. */
  readonly accruals: { epoch: number; utilizationBps: number; couponMet: boolean; epochs: number }[] = [];
  private txCounter = 0;

  constructor(epoch: number) {
    this.epoch = epoch;
    this.slot = epoch * SLOTS_PER_EPOCH + 5_000;
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  /** Emits events as one transaction (same signature and slot, ix in order). */
  private tx(...events: EpochEvent[]): string {
    this.slot += 10;
    const signature = `sig-${++this.txCounter}`;
    events.forEach((event, ix) =>
      this.stored.push({
        signature,
        ix,
        slot: this.slot,
        epoch: this.epoch,
        blockTime: null,
        name: event.name,
        data: eventToJson(event).data,
      }),
    );
    return signature;
  }

  private event<N extends EventName>(name: N, data: EpochEventMap[N]): EpochEvent {
    return { name, data } as EpochEvent;
  }

  nextEpoch(count = 1): void {
    this.epoch += count;
    this.slot = this.epoch * SLOTS_PER_EPOCH + 5_000;
  }

  /** A MemoryEventStore holding every event emitted so far. */
  async store(): Promise<MemoryEventStore> {
    const store = new MemoryEventStore(100_000);
    await store.insert(this.stored);
    return store;
  }

  get poolAddress(): string {
    return POOL.toBase58();
  }

  private requirePoolState(): PoolAccount {
    if (!this.poolState) throw new Error('initialize first');
    return this.poolState;
  }

  // ── Pool ──────────────────────────────────────────────────────────────────

  initialize(params: PoolParams = { ...PLANNED_POOL_PARAMS }): void {
    this.poolState = {
      admin: key('admin'),
      treasury: key('treasury'),
      scorer: key('scorer'),
      params,
      bump: 255,
      vaultBump: 255,
      paused: false,
      cash: 0n,
      outstandingPrincipal: 0n,
      expectedFees: 0n,
      incomeUnallocated: 0n,
      bondTotal: 0n,
      seniorAssets: 0n,
      seniorShares: 0n,
      juniorAssets: 0n,
      juniorShares: 0n,
      seniorPendingShares: 0n,
      juniorPendingShares: 0n,
      withdrawHead: 0n,
      withdrawTail: 0n,
      lastAccruedEpoch: 0n,
      validators: 0,
      openAdvances: 0,
      totalAdvanced: 0n,
      totalRepaid: 0n,
      totalDefaulted: 0n,
    };
    this.tx(
      this.event('PoolInitialized', {
        pool: POOL,
        admin: key('admin'),
        treasury: key('treasury'),
        scorer: key('scorer'),
      }),
    );
  }

  private tranche(t: Tranche): { assets: bigint; shares: bigint } {
    const p = this.requirePoolState();
    return t === 'senior'
      ? { assets: p.seniorAssets, shares: p.seniorShares }
      : { assets: p.juniorAssets, shares: p.juniorShares };
  }

  private setTranche(t: Tranche, assets: bigint, shares: bigint): void {
    const p = this.requirePoolState();
    if (t === 'senior') {
      p.seniorAssets = assets;
      p.seniorShares = shares;
    } else {
      p.juniorAssets = assets;
      p.juniorShares = shares;
    }
  }

  private addPending(t: Tranche, delta: bigint): void {
    const p = this.requirePoolState();
    if (t === 'senior') p.seniorPendingShares += delta;
    else p.juniorPendingShares += delta;
  }

  lender(owner: string, tranche: Tranche): LenderSharesAccount | undefined {
    return this.lenderMap.get(`${owner}:${tranche}`);
  }

  deposit(owner: string, tranche: Tranche, lamports: bigint): void {
    const p = this.requirePoolState();
    const { assets, shares } = this.tranche(tranche);
    const minted = assetsToShares(lamports, assets, shares);
    p.cash += lamports;
    this.setTranche(tranche, assets + lamports, shares + minted);
    const id = `${owner}:${tranche}`;
    const lender = this.lenderMap.get(id) ?? {
      pool: POOL,
      owner: new PublicKey(owner),
      tranche,
      shares: 0n,
      pendingShares: 0n,
      lastDepositEpoch: 0n,
      totalDeposited: 0n,
      totalWithdrawn: 0n,
      bump: 254,
    };
    lender.shares += minted;
    lender.lastDepositEpoch = BigInt(this.epoch);
    lender.totalDeposited += lamports;
    this.lenderMap.set(id, lender);
    const after = this.tranche(tranche);
    this.tx(
      this.event('Deposited', {
        pool: POOL,
        owner: new PublicKey(owner),
        tranche,
        assets: lamports,
        shares: minted,
        sharePriceE9: sharePriceE9(after.assets, after.shares),
      }),
    );
  }

  requestWithdraw(owner: string, tranche: Tranche, shares: bigint): bigint {
    const p = this.requirePoolState();
    const lender = this.lender(owner, tranche);
    if (!lender || lender.shares < shares) throw new Error('InsufficientShares');
    lender.shares -= shares;
    lender.pendingShares += shares;
    this.addPending(tranche, shares);
    const seq = p.withdrawTail;
    p.withdrawTail += 1n;
    this.requestMap.set(seq, {
      pool: POOL,
      owner: new PublicKey(owner),
      tranche,
      shares,
      seq,
      requestedEpoch: BigInt(this.epoch),
      cancelled: false,
      bump: 253,
    });
    this.tx(this.event('WithdrawRequested', { pool: POOL, owner: new PublicKey(owner), tranche, shares, seq }));
    return seq;
  }

  cancelWithdraw(seq: bigint): void {
    const request = this.requestMap.get(seq);
    if (!request || request.cancelled) throw new Error('RequestCancelled');
    const lender = this.lender(request.owner.toBase58(), request.tranche);
    if (!lender) throw new Error('no lender');
    lender.pendingShares -= request.shares;
    lender.shares += request.shares;
    this.addPending(request.tranche, -request.shares);
    request.cancelled = true;
    this.tx(this.event('WithdrawCancelled', { pool: POOL, owner: request.owner, seq, reason: 0 }));
  }

  /** process_withdrawal on the head request; returns what happened. */
  processWithdrawal(): 'skipped' | 'bounced' | 'paid' | 'no-cash' {
    const p = this.requirePoolState();
    const seq = p.withdrawHead;
    const request = this.requestMap.get(seq);
    if (!request) throw new Error('NotHeadOfQueue');
    if (request.cancelled) {
      p.withdrawHead += 1n;
      this.requestMap.delete(seq);
      return 'skipped';
    }
    const lender = this.lender(request.owner.toBase58(), request.tranche);
    if (!lender) throw new Error('no lender');
    const { assets, shares } = this.tranche(request.tranche);
    const value = sharesToAssets(request.shares, assets, shares);
    if (request.tranche === 'junior' && p.params.minJuniorBps > 0 && p.seniorAssets > 0n) {
      const junior = p.juniorAssets > value ? p.juniorAssets - value : 0n;
      if (juniorRatioBps(p.seniorAssets, junior) < BigInt(p.params.minJuniorBps)) {
        lender.pendingShares -= request.shares;
        lender.shares += request.shares;
        this.addPending('junior', -request.shares);
        p.withdrawHead += 1n;
        this.requestMap.delete(seq);
        this.tx(this.event('WithdrawCancelled', { pool: POOL, owner: request.owner, seq, reason: 1 }));
        return 'bounced';
      }
    }
    if (p.cash < value) return 'no-cash';
    p.cash -= value;
    this.setTranche(request.tranche, assets - value, shares - request.shares);
    this.addPending(request.tranche, -request.shares);
    lender.pendingShares -= request.shares;
    lender.totalWithdrawn += value;
    p.withdrawHead += 1n;
    this.requestMap.delete(seq);
    this.tx(
      this.event('WithdrawProcessed', {
        pool: POOL,
        owner: request.owner,
        tranche: request.tranche,
        shares: request.shares,
        assets: value,
        seq,
      }),
    );
    return 'paid';
  }

  accrue(): void {
    const p = this.requirePoolState();
    const epochs = p.lastAccruedEpoch === 0n ? 1n : BigInt(this.epoch) - p.lastAccruedEpoch;
    const income = p.incomeUnallocated;
    const d = distributeIncome(income, p.seniorAssets, p.params.seniorRateBpsPerEpoch, epochs, p.params.protocolFeeBps);
    const due = bpsOf(p.seniorAssets, p.params.seniorRateBpsPerEpoch) * epochs;
    p.incomeUnallocated = 0n;
    p.cash -= d.protocolFee;
    p.seniorAssets += d.seniorGain;
    p.juniorAssets += d.juniorGain;
    p.lastAccruedEpoch = BigInt(this.epoch);
    const total = p.seniorAssets + p.juniorAssets;
    this.accruals.push({
      epoch: this.epoch,
      utilizationBps: total > 0n ? Number((p.outstandingPrincipal * 10_000n) / total) : 0,
      couponMet: d.seniorGain === due,
      epochs: Number(epochs),
    });
    this.tx(
      this.event('Accrued', {
        pool: POOL,
        epoch: BigInt(this.epoch),
        income,
        protocolFee: d.protocolFee,
        seniorGain: d.seniorGain,
        juniorGain: d.juniorGain,
        seniorPriceE9: sharePriceE9(p.seniorAssets, p.seniorShares),
        juniorPriceE9: sharePriceE9(p.juniorAssets, p.juniorShares),
      }),
    );
  }

  // ── Credit ────────────────────────────────────────────────────────────────

  onboard(vote: string, operator: string, opts: { score?: number; hedged?: boolean; bond?: bigint } = {}): void {
    const p = this.requirePoolState();
    this.positionMap.set(vote, {
      pool: POOL,
      vote: new PublicKey(vote),
      identity: key(`identity:${vote}`),
      operator: new PublicKey(operator),
      payout: new PublicKey(operator),
      originalWithdrawer: new PublicKey(operator),
      bump: 250,
      voteAuthBump: 250,
      escrowBump: 250,
      status: 'active',
      hedged: opts.hedged ?? false,
      score: opts.score ?? 9_000,
      lastScoredEpoch: BigInt(this.epoch),
      revenue: Array.from({ length: 10 }, () => 0n),
      revenueHead: 0,
      revenueCount: 0,
      lastSweptEpoch: BigInt(this.epoch),
      totalSwept: 0n,
      totalRemitted: 0n,
      bondLamports: 0n,
      openAdvance: null,
      advanceSeq: 0n,
      lateEpochs: 0,
      inflationCommissionBps: 500,
      blockCommissionBps: 0,
      onboardedEpoch: BigInt(this.epoch),
      revenueToken: null,
    });
    p.validators += 1;
    this.tx(
      this.event('ValidatorOnboarded', {
        pool: POOL,
        vote: new PublicKey(vote),
        identity: key(`identity:${vote}`),
        operator: new PublicKey(operator),
        originalWithdrawer: new PublicKey(operator),
        epoch: BigInt(this.epoch),
      }),
    );
    if (opts.bond) this.postBond(vote, opts.bond);
  }

  positionState(vote: string): ValidatorPositionAccount {
    const position = this.positionMap.get(vote);
    if (!position) throw new Error(`no position ${vote}`);
    return position;
  }

  postBond(vote: string, lamports: bigint): void {
    const position = this.positionState(vote);
    position.bondLamports += lamports;
    this.requirePoolState().bondTotal += lamports;
    this.tx(this.event('BondPosted', { vote: new PublicKey(vote), lamports, bondTotal: position.bondLamports }));
  }

  requestAdvance(vote: string, amount: bigint): string {
    const p = this.requirePoolState();
    const position = this.positionState(vote);
    if (position.openAdvance) throw new Error('AdvanceAlreadyOpen');
    const fee = bpsOf(amount, p.params.feeBps);
    p.cash -= amount;
    p.outstandingPrincipal += amount;
    p.expectedFees += fee;
    p.openAdvances += 1;
    p.totalAdvanced += amount;
    const seq = position.advanceSeq;
    position.advanceSeq += 1n;
    const address = key(`advance:${vote}:${seq}`);
    position.openAdvance = address;
    position.lateEpochs = 0;
    this.advanceMap.set(address.toBase58(), {
      pool: POOL,
      vote: new PublicKey(vote),
      position: key(`position:${vote}`),
      seq,
      principal: amount,
      fee,
      totalDue: amount + fee,
      repaid: 0n,
      principalRepaid: 0n,
      feeRepaid: 0n,
      remitBps: p.params.remitBps,
      openedEpoch: BigInt(this.epoch),
      closedEpoch: 0n,
      state: 'open',
      bump: 249,
    });
    this.tx(
      this.event('AdvanceOpened', {
        pool: POOL,
        vote: new PublicKey(vote),
        advance: address,
        seq,
        principal: amount,
        fee,
        remitBps: p.params.remitBps,
        epoch: BigInt(this.epoch),
      }),
    );
    return address.toBase58();
  }

  sweep(vote: string, gross: bigint): void {
    const p = this.requirePoolState();
    const position = this.positionState(vote);
    if (position.lastSweptEpoch >= BigInt(this.epoch)) throw new Error('AlreadySweptThisEpoch');
    const advance = position.openAdvance ? this.advanceMap.get(position.openAdvance.toBase58()) : undefined;
    const outstanding = advance ? advance.totalDue - advance.repaid : 0n;
    const split = splitSweep(gross, outstanding, advance?.remitBps ?? 0, position.status === 'defaulted');
    const events: EpochEvent[] = [];
    if (advance && split.remit > 0n) {
      if (advance.state === 'open') {
        const parts = attributeRepayment(
          split.remit,
          advance.principal - advance.principalRepaid,
          advance.fee - advance.feeRepaid,
        );
        advance.principalRepaid += parts.principal;
        advance.feeRepaid += parts.fee;
        p.outstandingPrincipal -= parts.principal;
        p.expectedFees -= parts.fee;
        p.incomeUnallocated += parts.fee;
      } else {
        p.incomeUnallocated += split.remit;
      }
      advance.repaid += split.remit;
      p.cash += split.remit;
      p.totalRepaid += split.remit;
      position.totalRemitted += split.remit;
      if (advance.totalDue - advance.repaid === 0n) {
        advance.state = 'repaid';
        advance.closedEpoch = BigInt(this.epoch);
        position.openAdvance = null;
        position.status = 'active';
        position.lateEpochs = 0;
        p.openAdvances -= 1;
        events.push(
          this.event('AdvanceRepaid', {
            vote: new PublicKey(vote),
            advance: key(`advance:${vote}:${advance.seq}`),
            epoch: BigInt(this.epoch),
          }),
        );
      }
    }
    if (advance && advance.state === 'open') {
      if (gross === 0n) {
        position.lateEpochs += 1;
        position.status = 'late';
      } else if (position.status === 'late') {
        position.lateEpochs = 0;
        position.status = 'active';
      }
    }
    const head = position.revenueHead % 10;
    position.revenue[head] = gross;
    position.revenueHead = (head + 1) % 10;
    if (position.revenueCount < 10) position.revenueCount += 1;
    position.lastSweptEpoch = BigInt(this.epoch);
    position.totalSwept += gross;
    events.push(
      this.event('Swept', {
        pool: POOL,
        vote: new PublicKey(vote),
        epoch: BigInt(this.epoch),
        fromVote: gross,
        gross,
        remitted: split.remit,
        toOperator: split.toOperator,
      }),
    );
    this.tx(...events);
  }

  markDefault(vote: string): void {
    const p = this.requirePoolState();
    const position = this.positionState(vote);
    const advance = position.openAdvance ? this.advanceMap.get(position.openAdvance.toBase58()) : undefined;
    if (!advance || advance.state !== 'open') throw new Error('AdvanceStateInvalid');
    const principalLost = advance.principal - advance.principalRepaid;
    const feeLost = advance.fee - advance.feeRepaid;
    const bondApplied = position.bondLamports < principalLost ? position.bondLamports : principalLost;
    position.bondLamports -= bondApplied;
    p.bondTotal -= bondApplied;
    p.cash += bondApplied;
    advance.repaid += bondApplied;
    advance.principalRepaid += bondApplied;
    const loss = principalLost - bondApplied;
    p.outstandingPrincipal -= principalLost;
    p.expectedFees -= feeLost;
    const absorbed = absorbLoss(loss, p.seniorAssets, p.juniorAssets);
    p.seniorAssets = absorbed.seniorAssets;
    p.juniorAssets = absorbed.juniorAssets;
    p.totalDefaulted += loss;
    advance.state = 'defaulted';
    position.status = 'defaulted';
    this.tx(
      this.event('AdvanceDefaulted', {
        pool: POOL,
        vote: new PublicKey(vote),
        advance: key(`advance:${vote}:${advance.seq}`),
        principalLost: loss,
        bondApplied,
        epoch: BigInt(this.epoch),
      }),
    );
  }

  setScore(vote: string, score: number, hedged: boolean): void {
    const position = this.positionState(vote);
    position.score = score;
    position.hedged = hedged;
    position.lastScoredEpoch = BigInt(this.epoch);
    this.tx(this.event('ScoreUpdated', { vote: new PublicKey(vote), epoch: BigInt(this.epoch), score, hedged }));
  }

  // ── Validator history (P1) ────────────────────────────────────────────────

  /** `init_validator_history`: an empty history (every entry unknown). */
  initHistory(vote: string): void {
    this.historyMap.set(vote, {
      vote: new PublicKey(vote),
      createdEpoch: BigInt(this.epoch),
      lastVoteCopySlot: 0n,
      refreshedEpoch: 0n,
      refreshedSlot: 0n,
      hedgeRequiredNotional: 0n,
      epochsVoted: 0,
      score: 0,
      creditsRatioBps: 0,
      creditsRatioRawBps: 0,
      commissionBps: 0,
      epochsActive: 0,
      bump: 254,
      version: 1,
      scoreFlags: 0,
      entries: [],
    });
    const history = new PublicKey(Buffer.alloc(32, 7));
    this.tx(
      this.event('HistoryInitialized', {
        vote: new PublicKey(vote),
        history,
        payer: key('crank'),
        epoch: BigInt(this.epoch),
      }),
    );
  }

  private historyEntry(history: ValidatorHistoryAccount, epoch: number): HistoryEntry {
    let entry = history.entries.find((e) => e.epoch === BigInt(epoch));
    if (!entry) {
      entry = {
        epoch: BigInt(epoch),
        epochCredits: null,
        maxCredits: null,
        voteLamports: null,
        revenueLamports: null,
        mevEarnedLamports: null,
        priorityFeesLamports: null,
        activatedStakeLamports: null,
        lastVotedSlot: null,
        updatedSlot: null,
        rank: null,
        inflationCommissionBps: null,
        blockCommissionBps: null,
        mevCommissionBps: null,
        priorityFeeCommissionBps: null,
        superminority: null,
        sources: 0,
      };
      // The ring keeps HISTORY_LEN epochs: an older epoch's slot is overwritten.
      history.entries = history.entries.filter((e) => e.epoch > BigInt(epoch - PROGRAM_CONSTANTS.HISTORY_LEN));
      history.entries.push(entry);
      history.entries.sort((a, b) => Number(a.epoch - b.epoch));
    }
    return entry;
  }

  /**
   * `copy_vote_account`: credits for the last `backfill` finished epochs (`creditsPerSlot` of 16 per slot) and the
   * current epoch's commission, lamports, revenue and newest vote (`votedSlotsAgo` before this slot; null = empty tower).
   */
  copyVoteAccount(
    vote: string,
    opts: { backfill?: number; creditsPerSlot?: number; votedSlotsAgo?: number | null; revenue?: bigint } = {},
  ): void {
    const history = this.historyMap.get(vote);
    if (!history) throw new Error('init the history first');
    const perSlot = BigInt(opts.creditsPerSlot ?? 16);
    const backfill = opts.backfill ?? 10;
    for (let e = this.epoch - backfill; e <= this.epoch; e++) {
      const entry = this.historyEntry(history, e);
      entry.maxCredits = BigInt(SLOTS_PER_EPOCH) * PROGRAM_CONSTANTS.TVC_CREDITS_PER_SLOT;
      entry.epochCredits =
        e === this.epoch ? perSlot * BigInt(this.slot - e * SLOTS_PER_EPOCH) : perSlot * BigInt(SLOTS_PER_EPOCH);
      entry.sources |= HISTORY_SOURCES.credits;
    }
    const now = this.historyEntry(history, this.epoch);
    const position = this.positionMap.get(vote);
    now.inflationCommissionBps = position?.inflationCommissionBps ?? 500;
    now.blockCommissionBps = 10_000;
    now.voteLamports = sol(1);
    now.revenueLamports = opts.revenue ?? sol(0.5);
    now.lastVotedSlot = opts.votedSlotsAgo === null ? null : BigInt(this.slot - (opts.votedSlotsAgo ?? 1));
    now.updatedSlot = BigInt(this.slot);
    now.sources |= HISTORY_SOURCES.vote;
    history.lastVoteCopySlot = BigInt(this.slot);
    history.epochsVoted = Math.max(history.epochsVoted, backfill + 1);
    this.tx(
      this.event('VoteAccountCopied', {
        vote: new PublicKey(vote),
        epoch: BigInt(this.epoch),
        slot: BigInt(this.slot),
        epochCredits: now.epochCredits ?? 0n,
        epochsBackfilled: backfill,
        lastVotedSlot: now.lastVotedSlot,
        inflationCommissionBps: now.inflationCommissionBps,
        blockCommissionBps: now.blockCommissionBps,
        voteLamports: now.voteLamports,
        revenueLamports: now.revenueLamports,
      }),
    );
  }

  /** `update_stake_info` (the scorer) for the current epoch. */
  postStakeInfo(vote: string, rank: number, superminority: boolean, stake = sol(250_000)): void {
    const history = this.historyMap.get(vote);
    if (!history) throw new Error('init the history first');
    const now = this.historyEntry(history, this.epoch);
    now.activatedStakeLamports = stake;
    now.rank = rank;
    now.superminority = superminority;
    now.sources |= HISTORY_SOURCES.stake;
    this.tx(
      this.event('StakeInfoUpdated', {
        vote: new PublicKey(vote),
        epoch: BigInt(this.epoch),
        activatedStakeLamports: stake,
        rank,
        superminority,
      }),
    );
  }

  /** `configure_scoring` (the admin), the program's defaults unless given. */
  configureScoring(over: Partial<ScoreConfigAccount> = {}): void {
    this.scoreConfigAccount = {
      pool: POOL,
      marketMaker: this.marketMaker ?? null,
      creditsWindowEpochs: PROGRAM_CONSTANTS.DEFAULT_CREDITS_WINDOW_EPOCHS,
      countBlockCommission: false,
      creditsReferenceBps: PROGRAM_CONSTANTS.DEFAULT_CREDITS_REFERENCE_BPS,
      maxCopyAgeSlots: PROGRAM_CONSTANTS.DEFAULT_MAX_COPY_AGE_SLOTS,
      bump: 253,
      ...over,
    };
    const config = this.scoreConfigAccount;
    this.tx(
      this.event('ScoringConfigured', {
        pool: POOL,
        marketMaker: config.marketMaker ?? PublicKey.default,
        creditsWindowEpochs: config.creditsWindowEpochs,
        countBlockCommission: config.countBlockCommission,
        creditsReferenceBps: config.creditsReferenceBps,
        maxCopyAgeSlots: config.maxCopyAgeSlots,
      }),
    );
  }

  /**
   * `refresh_score`'s result (the formula is the program's, tested in Rust): the position's score and hedge flag, the
   * history's breakdown, `ScoreRefreshed` and the `ScoreUpdated` the indexer already knows.
   */
  refreshScore(
    vote: string,
    result: {
      score: number;
      creditsRatioBps: number;
      creditsRatioRawBps: number;
      commissionBps: number;
      epochsActive: number;
      delinquent?: boolean;
      superminority?: boolean;
      hedged?: boolean;
      hedgeRequiredNotional?: bigint;
    },
  ): void {
    const position = this.positionState(vote);
    const history = this.historyMap.get(vote);
    if (!history) throw new Error('init the history first');
    const flags = { delinquent: false, superminority: false, hedged: false, ...result };
    position.score = result.score;
    position.hedged = flags.hedged;
    position.lastScoredEpoch = BigInt(this.epoch);
    Object.assign(history, {
      refreshedEpoch: BigInt(this.epoch),
      refreshedSlot: BigInt(this.slot),
      hedgeRequiredNotional: result.hedgeRequiredNotional ?? 0n,
      score: result.score,
      creditsRatioBps: result.creditsRatioBps,
      creditsRatioRawBps: result.creditsRatioRawBps,
      commissionBps: result.commissionBps,
      epochsActive: result.epochsActive,
      scoreFlags:
        HISTORY_SCORE_FLAGS.scored |
        (flags.delinquent ? HISTORY_SCORE_FLAGS.delinquent : 0) |
        (flags.superminority ? HISTORY_SCORE_FLAGS.superminority : 0) |
        (flags.hedged ? HISTORY_SCORE_FLAGS.hedged : 0),
    });
    const voteKey = new PublicKey(vote);
    this.tx(
      this.event('ScoreRefreshed', {
        pool: POOL,
        vote: voteKey,
        epoch: BigInt(this.epoch),
        score: result.score,
        creditsRatioBps: result.creditsRatioBps,
        creditsRatioRawBps: result.creditsRatioRawBps,
        commissionBps: result.commissionBps,
        epochsActive: result.epochsActive,
        delinquent: flags.delinquent,
        superminority: flags.superminority,
        hedged: flags.hedged,
        hedgeRequiredNotional: result.hedgeRequiredNotional ?? 0n,
      }),
      this.event('ScoreUpdated', {
        vote: voteKey,
        epoch: BigInt(this.epoch),
        score: result.score,
        hedged: flags.hedged,
      }),
    );
  }

  // ── Fee index and market ──────────────────────────────────────────────────

  initializeIndex(disputeWindowSlots = 1_000n): void {
    this.feeIndexAccount = {
      pool: POOL,
      publisher: key('publisher'),
      bump: 248,
      epoch: 0n,
      value: 0n,
      inputsHash: new Uint8Array(32),
      finalizedSlot: 0n,
      hasProposal: false,
      proposedEpoch: 0n,
      proposedValue: 0n,
      proposedInputsHash: new Uint8Array(32),
      proposedSlot: 0n,
      disputeWindowSlots,
      maxMoveBps: 5_000,
      history: Array.from({ length: 16 }, () => ({ epoch: 0n, value: 0n })),
      historyHead: 0,
      historyCount: 0,
    };
  }

  private requireIndex(): FeeIndexAccount {
    if (!this.feeIndexAccount) throw new Error('initializeIndex first');
    return this.feeIndexAccount;
  }

  postIndex(epoch: number, value: bigint): void {
    const index = this.requireIndex();
    if (index.hasProposal) throw new Error('DisputeWindowOpen');
    index.hasProposal = true;
    index.proposedEpoch = BigInt(epoch);
    index.proposedValue = value;
    index.proposedSlot = BigInt(this.slot + 10);
    this.tx(
      this.event('IndexProposed', {
        epoch: BigInt(epoch),
        value,
        inputsHash: new Uint8Array(32),
        slot: index.proposedSlot,
      }),
    );
  }

  finalizeIndex(): void {
    const index = this.requireIndex();
    if (!index.hasProposal) throw new Error('NoProposal');
    if (index.finalizedSlot > 0n) {
      const head = index.historyHead % 16;
      index.history[head] = { epoch: index.epoch, value: index.value };
      index.historyHead = (head + 1) % 16;
      if (index.historyCount < 16) index.historyCount += 1;
    }
    index.epoch = index.proposedEpoch;
    index.value = index.proposedValue;
    index.finalizedSlot = BigInt(this.slot + 10);
    index.hasProposal = false;
    this.tx(
      this.event('IndexFinalized', {
        epoch: index.epoch,
        value: index.value,
        inputsHash: new Uint8Array(32),
        slot: index.finalizedSlot,
      }),
    );
  }

  vetoIndex(): void {
    const index = this.requireIndex();
    const [epoch, value] = [index.proposedEpoch, index.proposedValue];
    index.hasProposal = false;
    index.proposedEpoch = 0n;
    index.proposedValue = 0n;
    index.proposedSlot = 0n;
    this.tx(this.event('IndexVetoed', { epoch, value }));
  }

  postQuote(maker: string, epoch: number, fixedRate: bigint, maxNotional: bigint, maxMoveBps = 2_000): string {
    const address = key(`quote:${maker}:${epoch}`);
    const collateral = bpsOf(maxNotional, maxMoveBps);
    this.quoteMap.set(address.toBase58(), {
      pool: POOL,
      maker: new PublicKey(maker),
      epoch: BigInt(epoch),
      fixedRate,
      maxNotional,
      filledNotional: 0n,
      maxMoveBps,
      expirySlot: BigInt(epoch * SLOTS_PER_EPOCH),
      collateral,
      lockedCollateral: 0n,
      openSwaps: 0,
      bump: 247,
    });
    this.tx(
      this.event('QuotePosted', {
        quote: address,
        maker: new PublicKey(maker),
        epoch: BigInt(epoch),
        fixedRate,
        maxNotional,
        maxMoveBps,
      }),
    );
    return address.toBase58();
  }

  openSwap(taker: string, quoteAddress: string, notional: bigint, side: Side): string {
    const quote = this.quoteMap.get(quoteAddress);
    if (!quote) throw new Error('no quote');
    if (BigInt(this.epoch) >= quote.epoch || BigInt(this.slot) >= quote.expirySlot) throw new Error('QuoteExpired');
    if (quote.filledNotional + notional > quote.maxNotional) throw new Error('QuoteCapacityExceeded');
    const collateral = bpsOf(notional, quote.maxMoveBps);
    const address = key(`swap:${quoteAddress}:${taker}`);
    if (this.swapMap.has(address.toBase58())) throw new Error('already in use');
    quote.filledNotional += notional;
    quote.lockedCollateral += collateral;
    quote.openSwaps += 1;
    this.swapMap.set(address.toBase58(), {
      quote: new PublicKey(quoteAddress),
      taker: new PublicKey(taker),
      epoch: quote.epoch,
      side,
      notional,
      fixedRate: quote.fixedRate,
      maxMoveBps: quote.maxMoveBps,
      collateral,
      settled: false,
      pnl: 0n,
      bump: 246,
    });
    this.tx(
      this.event('SwapOpened', {
        quote: new PublicKey(quoteAddress),
        swap: address,
        taker: new PublicKey(taker),
        epoch: quote.epoch,
        side,
        notional,
        fixedRate: quote.fixedRate,
        collateral,
      }),
    );
    return address.toBase58();
  }

  settleSwap(swapAddress: string): bigint {
    const swap = this.swapMap.get(swapAddress);
    if (!swap) throw new Error('AccountNotInitialized');
    const value = feeIndexValueFor(this.requireIndex(), swap.epoch);
    if (value === null) throw new Error('IndexMissing');
    const pnl = takerPnl(swap.side, swap.notional, swap.fixedRate, value, swap.collateral);
    const quote = this.quoteMap.get(swap.quote.toBase58());
    if (!quote) throw new Error('no quote');
    quote.lockedCollateral -= swap.collateral;
    quote.collateral -= pnl;
    quote.openSwaps -= 1;
    this.swapMap.delete(swapAddress);
    this.tx(
      this.event('SwapSettled', {
        swap: new PublicKey(swapAddress),
        epoch: swap.epoch,
        indexValue: value,
        takerPnl: pnl,
      }),
    );
    return pnl;
  }

  withdrawQuote(quoteAddress: string): void {
    const quote = this.quoteMap.get(quoteAddress);
    if (!quote || quote.openSwaps > 0) throw new Error('QuoteHasOpenSwaps');
    this.quoteMap.delete(quoteAddress);
  }

  // ── ProgramReader ─────────────────────────────────────────────────────────

  async pool(): Promise<ProgramAccount<PoolAccount> | null> {
    if (!this.configured) throw new ServiceUnavailableException('not configured', 'PROGRAM_NOT_CONFIGURED');
    return this.poolState ? { address: POOL.toBase58(), account: this.poolState } : null;
  }

  async requirePool(): Promise<ProgramAccount<PoolAccount>> {
    const pool = await this.pool();
    if (!pool) throw new ServiceUnavailableException('no pool', 'POOL_NOT_INITIALIZED');
    return pool;
  }

  async position(vote: string): Promise<ProgramAccount<ValidatorPositionAccount> | null> {
    if (!this.configured) throw new ServiceUnavailableException('not configured', 'PROGRAM_NOT_CONFIGURED');
    const account = this.positionMap.get(vote);
    return account ? { address: `position:${vote}`, account } : null;
  }

  async feeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null> {
    return this.feeIndexAccount ? { address: key('fee_index').toBase58(), account: this.feeIndexAccount } : null;
  }

  async positions(): Promise<ProgramAccount<ValidatorPositionAccount>[]> {
    return [...this.positionMap.values()].map((account) => ({
      address: `position:${account.vote.toBase58()}`,
      account,
    }));
  }

  async positionsByOperator(address: string): Promise<ProgramAccount<ValidatorPositionAccount>[]> {
    return (await this.positions()).filter((p) => p.account.operator.toBase58() === address);
  }

  async advances(): Promise<ProgramAccount<AdvanceAccount>[]> {
    return [...this.advanceMap.entries()].map(([address, account]) => ({ address, account }));
  }

  async lenders(): Promise<ProgramAccount<LenderSharesAccount>[]> {
    return [...this.lenderMap.entries()].map(([address, account]) => ({ address, account }));
  }

  async lenderAccounts(owner: string): Promise<Record<Tranche, ProgramAccount<LenderSharesAccount> | null>> {
    const read = (t: Tranche) => {
      const account = this.lender(owner, t);
      return account ? { address: `lender:${owner}:${t}`, account } : null;
    };
    return { senior: read('senior'), junior: read('junior') };
  }

  async withdrawRequests(): Promise<ProgramAccount<WithdrawRequestAccount>[]> {
    return [...this.requestMap.values()].map((account) => ({ address: `withdraw:${account.seq}`, account }));
  }

  async quotes(): Promise<ProgramAccount<FeeQuoteAccount>[]> {
    return [...this.quoteMap.entries()].map(([address, account]) => ({ address, account }));
  }

  async swaps(): Promise<ProgramAccount<SwapPositionAccount>[]> {
    return [...this.swapMap.entries()].map(([address, account]) => ({ address, account }));
  }

  async validatorHistory(vote: string): Promise<ProgramAccount<ValidatorHistoryAccount> | null> {
    if (!this.configured) throw new ServiceUnavailableException('not configured', 'PROGRAM_NOT_CONFIGURED');
    const account = this.historyMap.get(vote);
    return account ? { address: `history:${vote}`, account } : null;
  }

  async scoreConfig(): Promise<ProgramAccount<ScoreConfigAccount> | null> {
    return this.scoreConfigAccount
      ? { address: key('score_config').toBase58(), account: this.scoreConfigAccount }
      : null;
  }

  async epochInfo(): Promise<ProgramEpochInfo> {
    return {
      epoch: this.epoch,
      slotIndex: this.slot - this.epoch * SLOTS_PER_EPOCH,
      slotsInEpoch: SLOTS_PER_EPOCH,
      absoluteSlot: this.slot,
    };
  }

  async firstSlotOfEpoch(epoch: number): Promise<number> {
    return epoch * SLOTS_PER_EPOCH;
  }

  async epochOfSlot(slot: number): Promise<number> {
    return Math.floor(slot / SLOTS_PER_EPOCH);
  }
}
