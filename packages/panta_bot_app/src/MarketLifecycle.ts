import { TransactionFailedException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import {
  baseToUsdc,
  baseUnits,
  isRetryablePantaError,
  type PantaApi,
  PantaApiError,
  PantaConfigError,
  PantaError,
} from '@epoch/panta';

import { type BotChain, SpendGuardError } from './Chain/BotChain';
import { type ClockSnapshot, marketWindow, type MarketWindow, type ScheduleOptions } from './Markets/EpochSchedule';
import { type FeeIndexAccountRef, marketText, type MarketText, marketTitle } from './Markets/MarketText';
import { ladderThresholds } from './Markets/Thresholds';
import { isoIst } from './Markets/Time';
import { type IndexHistory, type MarketRecord, type MarketStatus, type MarketStore } from './Store/MarketStore';

const logger = Logger.create('MarketLifecycle');

const DAY_MS = 24 * 3_600_000;
/** Creator-fee checks per tick (each is a read and maybe a build): well inside Panta's budget. */
const CREATOR_FEE_CHECKS_PER_TICK = 5;
/** Pages of `GET /markets/?createdBy=me` searched when a quote says DUPLICATE_MARKET. */
const DUPLICATE_SEARCH_PAGES = 4;

export interface LifecycleConfig {
  /** Plan and log only: no Panta writes, no signatures, no database writes. */
  dryRun: boolean;
  /** Why it is a dry run (missing key, keypair, image…), for the log. */
  dryRunReasons: string[];
  marketsPerEpoch: number;
  epochsAhead: number;
  thresholdLookback: number;
  schedule: ScheduleOptions;
  /** Rolling 24 h cap on creation fees, USDC base units. */
  maxCreateUsdcBasePerDay: number;
  /** The spend guard's SOL cap per create, lamports. */
  maxLamportsPerCreate: number;
  imageUrl: string | null;
  publicApiUrl: string | null;
  methodologyUrl: string;
  feeIndexAccount: FeeIndexAccountRef | null;
  graceHours: number;
  region: string;
  creatorFeeCheckMs: number;
  /** A market that fails this many times (quote rejected, transaction failed or expired) is given up. */
  maxAttempts: number;
}

export interface LifecycleDeps {
  config: LifecycleConfig;
  chain: BotChain;
  /** Null without PANTA_API_KEY (dry run only). */
  panta: PantaApi | null;
  /** Null without DATABASE_URL (dry run only). */
  store: MarketStore | null;
  history: IndexHistory | null;
  now?: () => number;
}

/** One target epoch of this tick. */
interface Target {
  epoch: number;
  window: MarketWindow;
  thresholds: number[];
}

/** What one tick did: logged as one line (the ops summary) and returned for tests. */
export interface TickSummary {
  at: string;
  epoch: number;
  progressPct: number;
  dryRun: boolean;
  targets: { epoch: number; thresholds: number[] }[];
  skipped: { epoch: number; reason: string }[];
  planned: number;
  created: string[];
  registered: string[];
  recovered: number;
  waiting: number;
  spent24hUsdc: string;
  budgetUsdc: string;
  creatorFeesClaimedUsdc: string;
  errors: string[];
}

/** Stops the create loop for this tick (rate limit, Panta down, permission): nothing about the market is wrong. */
class StopTick extends Error {}

/**
 * F10: keeps Panta markets on the Solana Fee Index open for the coming epochs, with real USDC.
 *
 * Every tick (PANTA_TICK_SECONDS, default 5 min), on the mainnet clock:
 * 1. Recover: a `quoted` row goes back to `planned` (nothing was signed); a `signed` row is resolved from its
 *    signature (landed → confirmed; failed or expired → planned again, attempts + 1; still in flight → re-broadcast);
 *    a `confirmed` row is registered.
 * 2. Plan: for epochs current + 1 … current + PANTA_EPOCHS_AHEAD whose trading window is still long enough, insert
 *    PANTA_MARKETS_PER_EPOCH thresholds from the index history (unique per epoch and threshold).
 * 3. Create, oldest epoch first, within PANTA_MAX_CREATE_USDC_PER_DAY: quote → build → spend guard (simulate: no more
 *    USDC than quoted) → sign → persist the signature → broadcast → confirm → register.
 * 4. Creator fees: graduated markets' accumulated fees are claimed to the creator wallet.
 * Every status change is a compare-and-set, the question text is a function of (epoch, threshold) only (Panta derives
 * the market address from it), and the signature is stored before anything is sent: a restart never creates twice.
 */
export class MarketLifecycle {
  private readonly now: () => number;
  /** The last quoted creation fee (base units): skips quoting while even that would break the budget. */
  private lastFee: number | null = null;

  constructor(private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now;
  }

  async tick(): Promise<TickSummary> {
    const { config, chain } = this.deps;
    const clock = await chain.clock();
    const summary: TickSummary = {
      at: isoIst(this.now()),
      epoch: clock.epoch,
      progressPct: Math.round((clock.slotIndex / clock.slotsInEpoch) * 1_000) / 10,
      dryRun: config.dryRun,
      targets: [],
      skipped: [],
      planned: 0,
      created: [],
      registered: [],
      recovered: 0,
      waiting: 0,
      spent24hUsdc: '0.00',
      budgetUsdc: baseToUsdc(BigInt(config.maxCreateUsdcBasePerDay)),
      creatorFeesClaimedUsdc: '0.00',
      errors: [],
    };
    const history = this.deps.history ? await this.deps.history.recent(clock.epoch, config.thresholdLookback) : [];
    const targets = this.targets(clock, history, summary);
    summary.targets = targets.map(({ epoch, thresholds }) => ({ epoch, thresholds }));

    if (config.dryRun || !this.deps.store || !this.deps.panta) {
      await this.logPlan(targets, history);
      this.logSummary(summary);
      return summary;
    }
    const store = this.deps.store;
    const panta = this.deps.panta;

    await this.step('recover', summary, () => this.recover(store, panta, summary));
    await this.step('plan', summary, () => this.plan(store, targets, history, summary));
    await this.step('create', summary, () => this.create(store, panta, clock, history, summary));
    await this.step('creator-fees', summary, () => this.claimCreatorFees(store, panta, summary));

    summary.waiting = (await store.withStatus(['planned'])).length;
    summary.spent24hUsdc = baseToUsdc(BigInt(await store.committedSince(new Date(this.now() - DAY_MS))));
    this.logSummary(summary);
    return summary;
  }

  // ── 1. Recover ───────────────────────────────────────────────────────────────────────────────────

  private async recover(store: MarketStore, panta: PantaApi, summary: TickSummary): Promise<void> {
    for (const row of await store.withStatus(['quoted', 'signed', 'confirmed'])) {
      if (row.status === 'quoted') {
        // Quoted but never signed (a crash between the two): the session is cheap, start over.
        if (await store.transition(row.id, 'quoted', { status: 'planned', ...CLEAR_CREATE })) summary.recovered++;
        continue;
      }
      if (row.status === 'signed') {
        // Register at once: Panta's create session (createId) lasts about 5 minutes.
        if (await this.settleSigned(store, row, summary)) await this.register(store, panta, row, summary);
        continue;
      }
      await this.register(store, panta, row, summary);
    }
  }

  /** A row whose signature was stored: find out what happened to it on chain. True once it is `confirmed`. */
  private async settleSigned(store: MarketStore, row: MarketRecord, summary: TickSummary): Promise<boolean> {
    const { chain } = this.deps;
    const signature = row.createSignature;
    if (!signature || !row.signedTx || row.lastValidBlockHeight === null) {
      await this.retryLater(store, row, 'signed', 'signed row without its transaction');
      return false;
    }
    const state = await chain.state(signature);
    if (state === 'confirmed') {
      const moved = await store.transition(row.id, 'signed', { status: 'confirmed', paidUsdcBase: row.quotedUsdcBase });
      if (moved) {
        summary.recovered++;
        logger.info('recovered a create that landed before the restart', { epoch: row.epoch, signature });
      }
      return moved;
    }
    if (state === 'failed') {
      await this.retryLater(store, row, 'signed', 'create transaction failed on chain');
      return false;
    }
    const height = await chain.blockHeight();
    if (height > row.lastValidBlockHeight) {
      // Its blockhash is dead: it can never land. Safe to quote again (same question, so never two markets).
      await this.retryLater(store, row, 'signed', 'create transaction expired before it landed');
      summary.recovered++;
      return false;
    }
    // Still in flight: re-broadcast the very same signed transaction and wait for it.
    summary.recovered++;
    const outcome = await this.broadcast(
      store,
      row,
      { signature, signedBase64: row.signedTx },
      row.lastValidBlockHeight,
    );
    return outcome === 'confirmed';
  }

  // ── 2. Plan ──────────────────────────────────────────────────────────────────────────────────────

  private targets(clock: ClockSnapshot, history: { epoch: number; value: number }[], summary: TickSummary): Target[] {
    const { config } = this.deps;
    const targets: Target[] = [];
    for (let epoch = clock.epoch + 1; epoch <= clock.epoch + config.epochsAhead; epoch++) {
      const window = marketWindow(clock, epoch, config.schedule);
      if (!window.ok) {
        summary.skipped.push({ epoch, reason: window.reason ?? 'no window' });
        continue;
      }
      const thresholds = ladderThresholds(
        history.map((point) => point.value),
        config.marketsPerEpoch,
      );
      if (thresholds.length === 0) {
        summary.skipped.push({ epoch, reason: 'no Fee Index history yet (epoch_index is empty)' });
        continue;
      }
      targets.push({ epoch, window, thresholds });
    }
    return targets;
  }

  private async plan(
    store: MarketStore,
    targets: Target[],
    history: { epoch: number; value: number }[],
    summary: TickSummary,
  ): Promise<void> {
    const existing = await store.forEpochs(targets.map((target) => target.epoch));
    for (const target of targets) {
      const rows = existing.filter((row) => row.epoch === target.epoch);
      // Thresholds are fixed once an epoch has its markets: a newer final value never adds a second market.
      let open = this.deps.config.marketsPerEpoch - rows.filter((row) => row.status !== 'failed').length;
      for (const threshold of target.thresholds) {
        if (open <= 0) break;
        if (rows.some((row) => row.threshold === threshold)) continue;
        const text = this.text(target.epoch, threshold, target.window, history);
        const row = await store.plan({
          epoch: target.epoch,
          threshold,
          ...text,
          imageUrl: this.deps.config.imageUrl,
          startTime: new Date(target.window.startTime * 1_000),
          endTime: new Date(target.window.endTime * 1_000),
          resolutionTime: new Date(target.window.resolutionTime * 1_000),
        });
        if (row) {
          open--;
          summary.planned++;
          logger.info('market planned', { epoch: row.epoch, threshold, question: row.question });
        }
      }
    }
  }

  // ── 3. Create ────────────────────────────────────────────────────────────────────────────────────

  private async create(
    store: MarketStore,
    panta: PantaApi,
    clock: ClockSnapshot,
    history: { epoch: number; value: number }[],
    summary: TickSummary,
  ): Promise<void> {
    const { config, chain } = this.deps;
    const wallet = chain.wallet;
    if (!wallet) return;
    let committed = await store.committedSince(new Date(this.now() - DAY_MS));

    for (const row of await store.withStatus(['planned'])) {
      if (row.attempts >= config.maxAttempts) {
        await store.transition(row.id, 'planned', { status: 'failed', error: row.error ?? 'too many attempts' });
        summary.errors.push(`epoch ${row.epoch}: given up after ${row.attempts} attempts`);
        continue;
      }
      // Times are recomputed from the current clock; the question and title never change.
      const window = marketWindow(clock, row.epoch, config.schedule);
      if (!window.ok) {
        await store.transition(row.id, 'planned', { status: 'failed', error: `too late: ${window.reason}` });
        summary.skipped.push({ epoch: row.epoch, reason: window.reason ?? 'no window' });
        continue;
      }
      if (this.lastFee !== null && committed + this.lastFee > config.maxCreateUsdcBasePerDay) {
        // The last quoted fee already breaks the budget: wait without spending a quote.
        logger.info('daily creation budget reached; the market waits', {
          epoch: row.epoch,
          spent24hUsdc: baseToUsdc(BigInt(committed)),
          budgetUsdc: baseToUsdc(BigInt(config.maxCreateUsdcBasePerDay)),
        });
        continue;
      }
      const text = this.text(row.epoch, row.threshold, window, history);
      if (text.question !== row.question) {
        // Never happens unless the wording code changed: creating would make a second market for this epoch.
        await store.transition(row.id, 'planned', {
          status: 'failed',
          error: 'question wording changed since planning',
        });
        summary.errors.push(`epoch ${row.epoch}: question wording changed; not creating`);
        continue;
      }

      let quote;
      try {
        quote = await panta.quoteCreate({
          wallet,
          question: text.question,
          resolutionRule: text.resolutionRule,
          sourcesOfTruth: text.sourcesOfTruth,
          category: 'crypto',
          startTime: window.startTime,
          endTime: window.endTime,
          resolutionTime: window.resolutionTime,
          imageUrl: config.imageUrl ?? '',
          marketType: 'standard',
          title: text.title,
          description: text.description,
          region: config.region,
        });
      } catch (error) {
        if (PantaApiError.is(error, 'DUPLICATE_MARKET')) {
          await this.adoptDuplicate(store, panta, row, summary);
          continue;
        }
        await this.onPantaError(store, row, 'planned', error, summary);
        continue;
      }

      const fee = Number(baseUnits(quote.paymentUsdc));
      this.lastFee = fee;
      if (committed + fee > config.maxCreateUsdcBasePerDay) {
        logger.warn('daily creation budget reached; the market waits', {
          epoch: row.epoch,
          feeUsdc: baseToUsdc(BigInt(fee)),
          spent24hUsdc: baseToUsdc(BigInt(committed)),
          budgetUsdc: baseToUsdc(BigInt(config.maxCreateUsdcBasePerDay)),
        });
        continue;
      }
      const quoted = await store.transition(row.id, 'planned', {
        status: 'quoted',
        createId: quote.createId,
        createExpiresAt: parseDate(quote.expiresAt),
        expectedEventPda: quote.expectedEventPda,
        quotedUsdcBase: fee,
        liquidityUsdcBase: Number(baseUnits(quote.liquidityInjectionUsdc)),
        platformUsdcBase: Number(baseUnits(quote.platformRevenueUsdc)),
        description: text.description,
        resolutionRule: text.resolutionRule,
        sourcesOfTruth: text.sourcesOfTruth,
        startTime: new Date(window.startTime * 1_000),
        endTime: new Date(window.endTime * 1_000),
        resolutionTime: new Date(window.resolutionTime * 1_000),
        error: null,
      });
      if (!quoted) continue; // another runner took it

      let build;
      try {
        build = await panta.buildCreate({ createId: quote.createId, wallet });
      } catch (error) {
        await this.onPantaError(store, row, 'quoted', error, summary);
        continue;
      }

      let signed;
      try {
        signed = await chain.guardAndSign(build.transaction, {
          maxUsdcBase: fee,
          maxLamports: config.maxLamportsPerCreate,
          recentBlockhash: build.recentBlockhash,
        });
      } catch (error) {
        if (error instanceof SpendGuardError) {
          // Not retried: a create that would take more than quoted (or fails in simulation) needs a person.
          await store.transition(row.id, 'quoted', { status: 'failed', ...CLEAR_CREATE, error: errorText(error) });
          logger.error('spend guard refused to sign a create', error, { epoch: row.epoch, ...error.details });
          summary.errors.push(`epoch ${row.epoch}: spend guard: ${error.message}`);
          continue;
        }
        throw error;
      }

      // The signature goes to the database BEFORE the transaction goes to the network.
      const stored = await store.transition(row.id, 'quoted', {
        status: 'signed',
        createSignature: signed.signature,
        signedTx: signed.signedBase64,
        lastValidBlockHeight: build.lastValidBlockHeight,
        signedAt: new Date(this.now()),
      });
      if (!stored) continue; // never broadcast what we could not record
      committed += fee;
      logger.info('creating market', {
        epoch: row.epoch,
        threshold: row.threshold,
        feeUsdc: baseToUsdc(BigInt(fee)),
        simulatedUsdc: baseToUsdc(BigInt(signed.usdcSpentBase)),
        signature: signed.signature,
      });
      const signedRow: MarketRecord = { ...row, status: 'signed', quotedUsdcBase: fee };
      const outcome = await this.broadcast(store, signedRow, signed, build.lastValidBlockHeight);
      if (outcome === 'retry') committed -= fee;
      if (outcome !== 'confirmed') continue;
      const marketId = await this.register(
        store,
        panta,
        {
          id: row.id,
          epoch: row.epoch,
          createId: quote.createId,
          createSignature: signed.signature,
          expectedEventPda: quote.expectedEventPda,
        },
        summary,
      );
      if (marketId) summary.created.push(marketId);
    }
  }

  /**
   * Sends a stored signed create and waits. `confirmed`: landed (row → confirmed). `retry`: it provably cannot land
   * (expired, failed in preflight or on chain): row → planned, one more attempt. `unknown`: the RPC failed us: the row
   * stays `signed` and the next tick resolves it from its signature, so a create that did land is never repeated.
   */
  private async broadcast(
    store: MarketStore,
    row: MarketRecord,
    signed: { signature: string; signedBase64: string },
    lastValidBlockHeight: number,
  ): Promise<'confirmed' | 'retry' | 'unknown'> {
    try {
      await this.deps.chain.send(signed, lastValidBlockHeight);
    } catch (error) {
      if (!(error instanceof TransactionFailedException)) {
        logger.warn('create outcome unknown; the next tick checks its signature', {
          epoch: row.epoch,
          signature: signed.signature,
          error: errorText(error),
        });
        return 'unknown';
      }
      const expired = error.details.expired === true;
      await this.retryLater(
        store,
        row,
        'signed',
        expired ? 'create transaction expired before it landed' : errorText(error),
      );
      return 'retry';
    }
    const moved = await store.transition(row.id, 'signed', { status: 'confirmed', paidUsdcBase: row.quotedUsdcBase });
    return moved ? 'confirmed' : 'unknown';
  }

  /** Lists a confirmed create on Panta. Returns the market id once registered. */
  private async register(
    store: MarketStore,
    panta: PantaApi,
    row: Pick<MarketRecord, 'id' | 'epoch' | 'createId' | 'createSignature' | 'expectedEventPda'>,
    summary: TickSummary,
  ): Promise<string | null> {
    if (!row.createId || !row.createSignature) {
      await store.transition(row.id, 'confirmed', { status: 'unregistered', error: 'confirmed without createId' });
      return null;
    }
    try {
      const registered = await panta.registerMarket({ createId: row.createId, signature: row.createSignature });
      await store.transition(row.id, 'confirmed', {
        status: 'registered',
        marketId: registered.marketId,
        registeredAt: new Date(this.now()),
        // The first creator-fee check comes one interval later: a new market has no fees yet.
        creatorFeesCheckedAt: new Date(this.now()),
        error: null,
      });
      summary.registered.push(registered.marketId);
      logger.info('market registered on Panta', { epoch: row.epoch, marketId: registered.marketId });
      return registered.marketId;
    } catch (error) {
      if (PantaApiError.is(error, 'CREATE_EXPIRED')) {
        // The session is gone but the market exists on chain: it may be in the catalog anyway.
        const listed = row.expectedEventPda ? await panta.getMarket(row.expectedEventPda).catch(() => null) : null;
        if (listed) {
          await store.transition(row.id, 'confirmed', {
            status: 'registered',
            marketId: listed.marketId,
            registeredAt: new Date(this.now()),
            creatorFeesCheckedAt: new Date(this.now()),
          });
          summary.registered.push(listed.marketId);
          return listed.marketId;
        }
        const message =
          `paid and confirmed, but Panta's registration window passed: ask Panta (#dev-chat) to register ` +
          `createId ${row.createId} with signature ${row.createSignature}`;
        await store.transition(row.id, 'confirmed', { status: 'unregistered', error: message });
        logger.error('market needs manual registration', undefined, { epoch: row.epoch, createId: row.createId });
        summary.errors.push(`epoch ${row.epoch}: ${message}`);
        return null;
      }
      // TX_NOT_FOUND (Panta's RPC behind ours), rate limits, outages: stays confirmed, retried next tick.
      summary.errors.push(`epoch ${row.epoch}: register: ${errorText(error)}`);
      logger.warn('register failed; retrying next tick', { epoch: row.epoch, error: errorText(error) });
      return null;
    }
  }

  /** DUPLICATE_MARKET: our wallet already created this exact question. Find it in our catalog and adopt it. */
  private async adoptDuplicate(
    store: MarketStore,
    panta: PantaApi,
    row: MarketRecord,
    summary: TickSummary,
  ): Promise<void> {
    const title = marketTitle(row.epoch, row.threshold);
    let cursor: string | undefined;
    for (let page = 0; page < DUPLICATE_SEARCH_PAGES; page++) {
      const list = await panta.listMarkets({ createdBy: 'me', limit: 50, cursor });
      const found = list.items.find((market) => market.title === title);
      if (found) {
        await store.transition(row.id, 'planned', {
          status: 'registered',
          marketId: found.marketId,
          registeredAt: new Date(this.now()),
          creatorFeesCheckedAt: new Date(this.now()),
          error: 'adopted after DUPLICATE_MARKET',
        });
        summary.registered.push(found.marketId);
        logger.warn('market already existed on Panta; adopted it', { epoch: row.epoch, marketId: found.marketId });
        return;
      }
      if (!list.nextCursor) break;
      cursor = list.nextCursor;
    }
    await store.transition(row.id, 'planned', {
      status: 'failed',
      error: 'DUPLICATE_MARKET but no market with this title in our Panta catalog',
    });
    summary.errors.push(`epoch ${row.epoch}: DUPLICATE_MARKET without a matching market`);
  }

  // ── 4. Creator fees ──────────────────────────────────────────────────────────────────────────────

  private async claimCreatorFees(store: MarketStore, panta: PantaApi, summary: TickSummary): Promise<void> {
    const { chain, config } = this.deps;
    const wallet = chain.wallet;
    if (!wallet) return;
    const due = (await store.withStatus(['registered']))
      .filter(
        (row) =>
          row.marketId &&
          (!row.creatorFeesCheckedAt || this.now() - row.creatorFeesCheckedAt.getTime() >= config.creatorFeeCheckMs),
      )
      .slice(0, CREATOR_FEE_CHECKS_PER_TICK);
    let claimedTotal = 0;
    for (const row of due) {
      const marketId = row.marketId as string;
      const checked = { creatorFeesCheckedAt: new Date(this.now()) };
      try {
        const market = await panta.getMarket(marketId);
        // Creator fees exist only after graduation (primary → secondary); cancelled markets have none.
        if (market.phase !== 'secondary' && market.phase !== 'resolved') {
          await store.transition(row.id, 'registered', checked);
          continue;
        }
        const claim = await panta.buildCreatorFeeClaim({ wallet, marketId });
        const amount = Number(baseUnits(claim.claimableFeesUsdc));
        if (amount <= 0) {
          await store.transition(row.id, 'registered', checked);
          continue;
        }
        const signature = await chain.sendInstructions(claim.instructions);
        await store.transition(row.id, 'registered', {
          ...checked,
          creatorFeesClaimedUsdcBase: row.creatorFeesClaimedUsdcBase + amount,
          lastCreatorFeeSignature: signature,
        });
        claimedTotal += amount;
        logger.info('creator fees claimed', { marketId, usdc: baseToUsdc(BigInt(amount)), signature });
      } catch (error) {
        if (PantaApiError.is(error, 'MARKET_NOT_GRADUATED', 'NO_CREATOR_FEES')) {
          await store.transition(row.id, 'registered', checked);
          continue;
        }
        if (isRetryablePantaError(error)) return;
        summary.errors.push(`creator fees ${marketId}: ${errorText(error)}`);
        logger.warn('creator-fee claim failed', { marketId, error: errorText(error) });
      }
    }
    summary.creatorFeesClaimedUsdc = baseToUsdc(BigInt(claimedTotal));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

  private text(
    epoch: number,
    threshold: number,
    window: MarketWindow,
    history: { epoch: number; value: number }[],
  ): MarketText {
    const { config } = this.deps;
    return marketText({
      epoch,
      threshold,
      window,
      publicApiUrl: config.publicApiUrl ?? 'https://api.epoch.invalid',
      methodologyUrl: config.methodologyUrl,
      feeIndexAccount: config.feeIndexAccount,
      graceHours: config.graceHours,
      reference: history[0] ?? null,
    });
  }

  /** A Panta failure while `row` is `from`. Retryable ones stop the tick; others count an attempt. */
  private async onPantaError(
    store: MarketStore,
    row: MarketRecord,
    from: MarketStatus,
    error: unknown,
    summary: TickSummary,
  ): Promise<void> {
    if (isRetryablePantaError(error) || error instanceof PantaConfigError) {
      if (from !== 'planned') await store.transition(row.id, from, { status: 'planned', ...CLEAR_CREATE });
      throw new StopTick(errorText(error));
    }
    if (PantaApiError.is(error, 'CREATE_NOT_PERMITTED')) {
      if (from !== 'planned') await store.transition(row.id, from, { status: 'planned', ...CLEAR_CREATE });
      logger.error('Panta says this account may not create markets (canCreateMarkets: false)', error);
      throw new StopTick('CREATE_NOT_PERMITTED');
    }
    await this.retryLater(store, row, from, errorText(error));
    summary.errors.push(`epoch ${row.epoch}: ${errorText(error)}`);
  }

  /** Back to `planned` with one more attempt (or `failed` once attempts run out). */
  private async retryLater(store: MarketStore, row: MarketRecord, from: MarketStatus, error: string): Promise<void> {
    const attempts = row.attempts + 1;
    const status: MarketStatus = attempts >= this.deps.config.maxAttempts ? 'failed' : 'planned';
    await store.transition(row.id, from, { status, attempts, error: error.slice(0, 500), ...CLEAR_CREATE });
    logger.warn('create attempt failed', { epoch: row.epoch, attempts, status, error });
  }

  private async step(name: string, summary: TickSummary, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (error instanceof StopTick) {
        summary.errors.push(`${name}: stopped: ${error.message}`);
        logger.warn('step stopped for this tick', { step: name, reason: error.message });
        return;
      }
      summary.errors.push(`${name}: ${errorText(error)}`);
      logger.error('step failed; retrying next tick', error, { step: name });
    }
  }

  private async logPlan(targets: Target[], history: { epoch: number; value: number }[]): Promise<void> {
    const { config, store } = this.deps;
    const existing = store ? await store.forEpochs(targets.map((t) => t.epoch)).catch(() => []) : [];
    for (const target of targets) {
      for (const threshold of target.thresholds) {
        const text = this.text(target.epoch, threshold, target.window, history);
        const row = existing.find((r) => r.epoch === target.epoch && r.threshold === threshold);
        logger.info('DRY RUN: would create', {
          epoch: target.epoch,
          threshold,
          existing: row?.status ?? null,
          question: text.question,
          title: text.title,
          startTime: isoIst(target.window.startTime * 1_000),
          endTime: isoIst(target.window.endTime * 1_000),
          resolutionTime: isoIst(target.window.resolutionTime * 1_000),
          tradingHours: Math.round((target.window.tradingSeconds / 3_600) * 10) / 10,
          sourcesOfTruth: text.sourcesOfTruth,
          category: 'crypto',
          imageUrl: config.imageUrl,
          resolutionRule: text.resolutionRule,
          cost: 'the USDC fee Panta quotes at creation (part seeds liquidity); nothing is quoted in a dry run',
        });
      }
    }
  }

  private logSummary(summary: TickSummary): void {
    const { config } = this.deps;
    logger.info(config.dryRun ? 'tick (DRY RUN)' : 'tick', {
      ...summary,
      ...(config.dryRun ? { dryRunReasons: config.dryRunReasons } : {}),
    });
  }
}

/** Fields of an abandoned create attempt (a new quote starts clean). */
const CLEAR_CREATE = {
  createId: null,
  createExpiresAt: null,
  expectedEventPda: null,
  createSignature: null,
  signedTx: null,
  lastValidBlockHeight: null,
  signedAt: null,
} as const;

function parseDate(text: string): Date | null {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function errorText(error: unknown): string {
  if (error instanceof PantaApiError) return `${error.code}: ${error.message}`;
  if (error instanceof PantaError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
