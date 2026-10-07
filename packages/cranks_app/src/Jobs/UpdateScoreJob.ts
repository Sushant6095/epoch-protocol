import {
  computeScore,
  HISTORY_SOURCES,
  type ScoreUpdate,
  type SwapPositionAccount,
  updateScore,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type PublicKey } from '@solana/web3.js';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type ValidatorDataSource } from '../Chain/MainnetData';
import { hedgeStatus } from '../Scoring/HedgeRule';
import { clusterStats, scoreInputs } from '../Scoring/ScoreInputs';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('UpdateScoreJob');

/**
 * A posted score is still fresh at the next boundary (when this job runs again), so skipping now cannot let it go
 * stale: `request_advance` accepts `epoch <= last_scored_epoch + score_ttl_epochs`.
 */
export function stillFreshNextEpoch(lastScoredEpoch: bigint, scoreTtlEpochs: number, epoch: bigint): boolean {
  return lastScoredEpoch > 0n && epoch + 1n <= lastScoredEpoch + BigInt(scoreTtlEpochs);
}

/**
 * `update_score` for every onboarded validator without fresh on-chain history (HistoryJob scores the others with
 * `refresh_score`), signed by the scorer key. Inputs come from the data cluster
 * (DATA_RPC_URL, mainnet) and Jito Kobe; the hedged flag from the operator's open Receive-fixed swaps against
 * Epoch's maker (HedgeRule). Skips a position whose score and hedged flag would not change while the posted score
 * stays fresh. Any data-source failure retries on the next tick rather than posting a guess.
 */
export class UpdateScoreJob implements Job {
  readonly name = 'UpdateScoreJob';
  private warned = new Set<string>();

  constructor(
    private readonly chain: EpochChain,
    private readonly data: ValidatorDataSource,
    private readonly hedgeMakers: readonly PublicKey[],
  ) {}

  async run(epoch: bigint): Promise<JobOutcome> {
    const scorer = this.chain.keyOf('scorer');
    if (!scorer) {
      this.warnOnce('no-scorer', 'SCORER_KEYPAIR_PATH is not set; scores are not updated');
      return 'done';
    }
    const pool = await this.chain.pool();
    if (!pool) {
      this.warnOnce('no-pool', 'the Pool is not initialized yet');
      return 'done';
    }
    if (!pool.account.scorer.equals(scorer)) {
      logger.error('SCORER_KEYPAIR_PATH is not the Pool scorer; update_score would fail with NotScorer', undefined, {
        configured: scorer.toBase58(),
        poolScorer: pool.account.scorer.toBase58(),
      });
      return 'done';
    }
    if (this.hedgeMakers.length === 0) {
      this.warnOnce('no-maker', 'EPOCH_MARKET_MAKER is not set: no validator can count as hedged');
    }

    const positions = (await this.chain.positions()).filter((p) => p.account.status !== 'released');
    if (positions.length === 0) return 'done';

    const [voters, mev, states, swaps] = await Promise.all([
      this.data.voters(),
      this.data.mevCommissions(),
      this.data.voteStates(positions.map((p) => p.account.vote)),
      this.chain.swaps(),
    ]);
    const stats = clusterStats(voters);
    const swapsByTaker = new Map<string, SwapPositionAccount[]>();
    for (const { account } of swaps) {
      const key = account.taker.toBase58();
      swapsByTaker.set(key, [...(swapsByTaker.get(key) ?? []), account]);
    }

    let retry = false;
    for (const { account: position } of positions) {
      const vote = position.vote.toBase58();
      if (await this.historyIsFresh(position.vote, epoch)) {
        // HistoryJob scores it from the chain (refresh_score); the program refuses update_score now anyway.
        logger.debug('fresh on-chain history; scored by refresh_score', { vote });
        continue;
      }
      const inputs = scoreInputs(vote, stats, states.get(vote) ?? null, mev.get(vote) ?? null);
      if (!inputs) {
        this.warnOnce(
          `missing ${vote}`,
          'vote account not found on the data cluster; not scored (check DATA_RPC_URL)',
          {
            vote,
          },
        );
        continue;
      }
      const hedge = hedgeStatus({
        programId: this.chain.programId,
        position,
        currentEpoch: epoch,
        swaps: swapsByTaker.get(position.operator.toBase58()) ?? [],
        makers: this.hedgeMakers,
      });
      const update: ScoreUpdate = { ...inputs, hedged: hedge.hedged };
      const score = computeScore(inputs);
      if (
        score === position.score &&
        hedge.hedged === position.hedged &&
        stillFreshNextEpoch(position.lastScoredEpoch, pool.account.params.scoreTtlEpochs, epoch)
      ) {
        logger.debug('score unchanged and fresh; skipped', { vote, score });
        continue;
      }
      const result = await this.chain.execute(
        `update_score ${vote}`,
        updateScore({ programId: this.chain.programId, scorer, vote: position.vote, update }),
        'scorer',
      );
      if (result.status === 'failed') {
        logger.error('update_score failed', undefined, { vote, reason: describeFailure(result) });
        if (result.transient) retry = true;
      } else {
        logger.info('score posted', {
          vote,
          score,
          previous: position.score,
          ...(hedge.reason ? { notHedgedBecause: hedge.reason } : {}),
          ...update,
          status: result.status,
        });
      }
    }
    return retry ? 'retry' : 'done';
  }

  /** The validator's history holds a vote-account copy from this epoch (update_score would fail HistoryIsFresh). */
  private async historyIsFresh(vote: PublicKey, epoch: bigint): Promise<boolean> {
    const history = await this.chain.history(vote);
    return !!history?.entries.some((e) => e.epoch === epoch && (e.sources & HISTORY_SOURCES.vote) !== 0);
  }

  private warnOnce(key: string, message: string, meta: Record<string, unknown> = {}): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn(message, meta);
  }
}
