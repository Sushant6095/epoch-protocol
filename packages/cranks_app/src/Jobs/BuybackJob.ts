import {
  closeRevenueToken,
  executeBuyback,
  findBuybackEscrowPda,
  planBuybackSlice,
  PROGRAM_CONSTANTS,
  type RevenueTokenAccount,
  revenueTokenBuybacksPaused,
  revenueTokenInTerm,
  revenueTokenTermActive,
  sliceTiming,
  syncRevenueTokenPool,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type PublicKey } from '@solana/web3.js';

import { type BuybackMarket } from '../Chain/BuybackMarket';
import { describeFailure, type EpochChain, type ExecuteResult } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('BuybackJob');

export interface BuybackJobOptions {
  /** The crank's `min_amount_out`: a fresh quote less this many bps (the program enforces its own floor too). */
  slippageBps: number;
  /** Sends per (token, epoch, slice) before the job leaves that slice for good. */
  maxAttempts: number;
  /** Compute units for `execute_buyback` (it wraps SOL, swaps through Meteora, unwraps and burns). */
  computeUnitLimit: number;
}

export const DEFAULT_BUYBACK_OPTIONS: BuybackJobOptions = {
  slippageBps: 100,
  maxAttempts: 3,
  computeUnitLimit: 300_000,
};

/** Program errors that end a slice for this epoch (re-sending cannot change them). */
const SLICE_OVER = new Set(['SliceAlreadyExecuted', 'NothingToBuy', 'OutsideBuybackWindow', 'BuybacksPaused']);
/** Program errors that mean "not yet": the next tick looks again, without spending an attempt. */
const NOT_YET = new Set(['SliceNotDue', 'SweepPending', 'VenueNotTrading', 'PoolNotSynced']);

/**
 * Revenue-token buybacks (ADR 0006): every tick, for each token, at most one `execute_buyback` — the earliest slice
 * of the current epoch that is due and has not run (slices are spread over the first `window_slots` slots, 12 over
 * ~1 hour by default). The SOL amount and the program's own min-out floor come from the SDK mirror of the instruction
 * (`planBuybackSlice`, on the pool state read just before); the crank's `min_amount_out` is a fresh Meteora quote less
 * `slippageBps`, and the job refuses to send one below the floor. Idempotent per (epoch, slice): the program's
 * `slices_done` bitmap is re-read every tick, and a slice that succeeded, cannot succeed this epoch or used up its
 * attempts is not sent again.
 *
 * Also, permissionlessly: `sync_revenue_token_pool` once the curve migrated (buybacks then move to DAMM v2), and
 * `close_revenue_token` after the term once the escrow is spent (the rent goes back to the operator).
 *
 * Runs after the epoch's sweep (a steady job), since slices in the term wait for this epoch's share.
 */
export class BuybackJob implements Job {
  readonly name = 'BuybackJob';
  private readonly over = new Set<string>();
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly chain: EpochChain,
    private readonly market: BuybackMarket,
    private readonly options: BuybackJobOptions = DEFAULT_BUYBACK_OPTIONS,
  ) {}

  async run(epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');
    const tokens = await this.chain.revenueTokens();
    if (tokens.length === 0) return 'done';
    const { slotIndex } = await this.chain.clock();
    const rent = await this.chain.rentExempt(0);
    for (const { account: token } of tokens) {
      try {
        await this.runToken(token, epoch, slotIndex, rent, cranker);
      } catch (error) {
        logger.error('buyback step failed', error, { vote: token.vote.toBase58() });
      }
    }
    this.forgetBefore(epoch);
    return 'done';
  }

  private async runToken(
    token: RevenueTokenAccount,
    epoch: bigint,
    slotIndex: bigint,
    rent: bigint,
    cranker: PublicKey,
  ): Promise<void> {
    const vote = token.vote.toBase58();
    const [escrow] = findBuybackEscrowPda(this.chain.programId, token.vote);
    const escrowLamports = await this.chain.lamports(escrow);
    const escrowAvailable = escrowLamports > rent ? escrowLamports - rent : 0n;

    if (!revenueTokenTermActive(token, epoch) && escrowAvailable <= PROGRAM_CONSTANTS.MAX_CLOSE_DUST_LAMPORTS) {
      await this.close(token, cranker);
      return;
    }
    if (revenueTokenBuybacksPaused(token)) return;
    if (!token.dammPool) {
      const graduation = await this.market.graduation(token);
      if (graduation) {
        const result = await this.chain.execute(
          `sync_revenue_token_pool ${vote}`,
          syncRevenueTokenPool({
            programId: this.chain.programId,
            cranker,
            vote: token.vote,
            dbcPool: token.dbcPool,
            dammConfig: graduation.dammConfig,
            dammPool: graduation.dammPool,
          }),
          'crank',
        );
        logger.info('graduated: synced the DAMM v2 pool', {
          vote,
          dammPool: graduation.dammPool.toBase58(),
          result: describeFailure(result),
        });
        return; // the next tick buys on DAMM v2
      }
    }

    const slice = this.nextSlice(token, epoch, slotIndex);
    if (slice === null) return;
    const id = `${vote}:${epoch}:${slice}`;
    if (revenueTokenInTerm(token, epoch) && token.lastShareEpoch !== epoch) {
      logger.debug('slice due, waiting for this epoch’s sweep', { vote, slice });
      return;
    }
    const venue = await this.market.venue(token);
    if (!venue) {
      logger.warn('buyback venue not found', { vote, dammPool: token.dammPool?.toBase58() ?? null });
      return;
    }
    const plan = planBuybackSlice({ epoch, revenueToken: token, escrowAvailable, slice, venue: venue.state });
    if (plan.status === 'skip') {
      if (SLICE_OVER.has(plan.reason)) this.over.add(id);
      logger.info('slice skipped', { vote, slice, reason: plan.reason });
      return;
    }
    const quote = await venue.quote(plan.amount, this.options.slippageBps);
    if (quote.minimumOut < plan.floor) {
      // The pool would return less than the program accepts (a fee schedule or dynamic fee above the bound).
      this.spendAttempt(id, `quote min-out ${quote.minimumOut} below the program floor ${plan.floor}`, vote);
      return;
    }
    const result = await this.chain.execute(
      `execute_buyback ${vote} slice ${slice}`,
      executeBuyback({
        programId: this.chain.programId,
        cranker,
        vote: token.vote,
        mint: token.mint,
        dbcConfig: token.dbcConfig,
        venue: { kind: venue.kind, pool: venue.pool },
        slice,
        minAmountOut: quote.minimumOut,
      }),
      'crank',
      { computeUnitLimit: this.options.computeUnitLimit },
    );
    this.settle(id, vote, slice, result, {
      venue: venue.kind,
      lamports: plan.amount.toString(),
      minAmountOut: quote.minimumOut.toString(),
      floor: plan.floor.toString(),
    });
  }

  /** The earliest slice of the epoch that has not run and is due; null when the next one is not due yet. */
  private nextSlice(token: RevenueTokenAccount, epoch: bigint, slotIndex: bigint): number | null {
    const done = token.buybackEpoch === epoch ? token.slicesDone : 0;
    for (let slice = 0; slice < token.slicesPerEpoch; slice++) {
      if (((done >>> slice) & 1) === 1 || this.over.has(`${token.vote.toBase58()}:${epoch}:${slice}`)) continue;
      return sliceTiming(slotIndex, slice, token.slicesPerEpoch, token.windowSlots) === 'due' ? slice : null;
    }
    return null;
  }

  private settle(
    id: string,
    vote: string,
    slice: number,
    result: ExecuteResult,
    context: Record<string, string>,
  ): void {
    if (result.status !== 'failed') {
      this.over.add(id);
      logger.info('buyback slice sent', { vote, slice, status: result.status, ...context });
      return;
    }
    const name = result.error?.name;
    if (name && SLICE_OVER.has(name)) {
      this.over.add(id);
      logger.info('slice over for this epoch', { vote, slice, reason: name });
    } else if (name && NOT_YET.has(name)) {
      logger.info('slice not ready yet', { vote, slice, reason: name });
    } else {
      // Transient, or the price moved under the quote (BuybackOutputTooLow, MinOutTooLow, the venue's slippage check).
      this.spendAttempt(id, describeFailure(result), vote);
    }
  }

  private spendAttempt(id: string, reason: string, vote: string): void {
    const attempts = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempts);
    if (attempts >= this.options.maxAttempts) {
      this.over.add(id);
      logger.error('buyback slice given up for this epoch', undefined, { vote, id, attempts, reason });
    } else {
      logger.warn('buyback slice failed; retrying next tick', { vote, id, attempts, reason });
    }
  }

  private async close(token: RevenueTokenAccount, cranker: PublicKey): Promise<void> {
    const vote = token.vote.toBase58();
    const id = `${vote}:close`;
    if (this.over.has(id)) return;
    const result = await this.chain.execute(
      `close_revenue_token ${vote}`,
      closeRevenueToken({
        programId: this.chain.programId,
        cranker,
        vote: token.vote,
        operator: token.operator,
        mint: token.mint,
      }),
      'crank',
    );
    if (result.status !== 'failed' || !result.transient) this.over.add(id);
    logger.info('revenue token closed after its term', { vote, result: describeFailure(result) });
  }

  /** Drops bookkeeping of earlier epochs. */
  private forgetBefore(epoch: bigint): void {
    for (const store of [this.over, this.attempts.keys()]) {
      for (const id of [...store]) {
        const parts = id.split(':');
        if (parts.length === 3 && BigInt(parts[1]) < epoch) {
          this.over.delete(id);
          this.attempts.delete(id);
        }
      }
    }
  }
}
