import {
  copyPriorityFeeDistribution,
  copyTipDistributionAccount,
  copyVoteAccount,
  findPriorityFeeDistributionPda,
  findTipDistributionPda,
  HISTORY_SOURCES,
  type HistoryEntry,
  initValidatorHistory,
  refreshScore,
  updateStakeInfo,
  type ValidatorHistoryAccount,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type PublicKey, type TransactionInstruction } from '@solana/web3.js';

import { describeFailure, type EpochChain, type ExecuteResult, type SignerRole } from '../Chain/EpochChain';
import { type StakeRank, stakeRanks, unrankedStake } from '../Scoring/StakeRanks';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('HistoryJob');

/** A missing Jito account may appear later (the root is uploaded hours into the next epoch); try this many times. */
export const MAX_JITO_ATTEMPTS = 12;

export interface HistoryJobOptions {
  /** Vote accounts to keep history for besides the onboarded ones (HISTORY_WATCHLIST). */
  watchlist?: readonly PublicKey[];
}

const has = (entry: HistoryEntry | undefined, source: number): boolean => !!entry && (entry.sources & source) !== 0;
const entryOf = (history: ValidatorHistoryAccount, epoch: bigint): HistoryEntry | undefined =>
  history.entries.find((e) => e.epoch === epoch);

/**
 * Validator history, every epoch (at the boundary and then on the rescore interval), for every onboarded validator
 * plus HISTORY_WATCHLIST:
 *
 * 1. `init_validator_history` when the account does not exist yet (the crank pays ~0.059 SOL once);
 * 2. `copy_vote_account` once per epoch, after the epoch's stake rewards are paid and before the sweep, so the
 *    history sees the epoch's revenue the way the sweep does;
 * 3. the Jito copies (`copy_tip_distribution_account` for the last and the current epoch, and
 *    `copy_priority_fee_distribution` for the last), only while the history lacks that data and the Jito account
 *    exists (none on devnet), at most `MAX_JITO_ATTEMPTS` times each;
 * 4. for onboarded validators, with the scorer key: `update_stake_info` for this epoch (rank and superminority from
 *    the program cluster's stakes), then `copy_vote_account` + `refresh_score` in one transaction, so the copy the
 *    score uses is never stale. The hedge swaps are the program-derived PDAs on the market maker's quotes.
 *
 * Positions are left alone until `configure_scoring` has run: a fresh copy makes `update_score` refuse, and without
 * a ScoreConfig `refresh_score` cannot run, so they keep the `update_score` fallback. Idempotent: every step reads
 * the history first.
 */
export class HistoryJob implements Job {
  readonly name = 'HistoryJob';
  private readonly warned = new Set<string>();
  private readonly jitoAttempts = new Map<string, number>();

  constructor(
    private readonly chain: EpochChain,
    private readonly options: HistoryJobOptions = {},
  ) {}

  async run(epoch: bigint): Promise<JobOutcome> {
    const crank = this.chain.keyOf('crank');
    if (!crank) {
      this.warnOnce('no-crank', 'CRANK_KEYPAIR_PATH is not set; validator history is not copied');
      return 'done';
    }
    if (await this.chain.epochRewardsActive()) return 'retry';

    const [positions, config] = await Promise.all([this.chain.positions(), this.chain.scoreConfig()]);
    const onboarded = positions.filter((p) => p.account.status !== 'released');
    if (onboarded.length > 0 && !config) {
      this.warnOnce(
        'no-config',
        'configure_scoring has not run: onboarded validators keep the update_score fallback and are not copied',
      );
    }
    const targets = new Map<string, { vote: PublicKey; operator?: PublicKey }>();
    if (config) for (const { account } of onboarded) targets.set(account.vote.toBase58(), account);
    for (const vote of this.options.watchlist ?? [])
      if (!targets.has(vote.toBase58())) targets.set(vote.toBase58(), { vote });
    if (targets.size === 0) return 'done';

    const scorer = this.chain.keyOf('scorer');
    let ranks: Map<string, StakeRank> | undefined;
    let unranked: StakeRank | undefined;
    let retry = false;
    const step = async (label: string, instructions: TransactionInstruction[], role: SignerRole = 'crank') => {
      const result = await this.chain.execute(label, instructions, role);
      if (result.status === 'failed') {
        logger.error(`${label} failed`, undefined, { reason: describeFailure(result) });
        if (result.transient) retry = true;
      }
      return result;
    };
    const ok = (result: ExecuteResult) => result.status !== 'failed';
    const programId = this.chain.programId;

    for (const [key, { vote, operator }] of targets) {
      let history = await this.chain.history(vote);
      if (!history) {
        if (
          !ok(await step(`init_validator_history ${key}`, initValidatorHistory({ programId, cranker: crank, vote })))
        ) {
          continue;
        }
        history = await this.chain.history(vote);
        if (!history) {
          retry = true; // created, not visible yet at this commitment
          continue;
        }
      }

      // 2. The vote account, once per epoch (positions get a fresh copy with their refresh below).
      if (!has(entryOf(history, epoch), HISTORY_SOURCES.vote)) {
        await step(`copy_vote_account ${key}`, copyVoteAccount({ programId, cranker: crank, vote }));
      }

      // 3. Jito, while the history lacks it and the account exists.
      const last = entryOf(history, epoch - 1n);
      const now = entryOf(history, epoch);
      const jito: [string, bigint, boolean, PublicKey, TransactionInstruction[]][] = [
        [
          'tip',
          epoch - 1n,
          (last?.mevEarnedLamports ?? null) !== null,
          findTipDistributionPda(vote, epoch - 1n)[0],
          copyTipDistributionAccount({ programId, cranker: crank, vote, epoch: epoch - 1n }),
        ],
        [
          'tip',
          epoch,
          (now?.mevCommissionBps ?? null) !== null,
          findTipDistributionPda(vote, epoch)[0],
          copyTipDistributionAccount({ programId, cranker: crank, vote, epoch }),
        ],
        [
          'priority fee',
          epoch - 1n,
          (last?.priorityFeesLamports ?? null) !== null,
          findPriorityFeeDistributionPda(vote, epoch - 1n)[0],
          copyPriorityFeeDistribution({ programId, cranker: crank, vote, epoch: epoch - 1n }),
        ],
      ];
      for (const [kind, at, done, account, instructions] of jito) {
        const attemptKey = `${key}:${at}:${kind}`;
        const attempts = this.jitoAttempts.get(attemptKey) ?? 0;
        if (done || attempts >= MAX_JITO_ATTEMPTS || (await this.chain.lamports(account)) === 0n) continue;
        this.jitoAttempts.set(attemptKey, attempts + 1);
        await step(`copy ${kind} distribution ${key} epoch ${at}`, instructions);
      }

      // 4. Onboarded validators: this epoch's stake info, then the score from the history.
      if (!operator || !config) continue;
      if (!scorer) {
        this.warnOnce('no-scorer', 'SCORER_KEYPAIR_PATH is not set: no stake info, so refresh_score cannot run');
        continue;
      }
      if ((now?.superminority ?? null) === null) {
        if (!ranks) {
          const stakes = await this.chain.voteStakes();
          ranks = stakeRanks(stakes);
          unranked = unrankedStake(stakes);
        }
        const info = ranks.get(key) ?? unranked!;
        const posted = await step(
          `update_stake_info ${key}`,
          updateStakeInfo({
            programId,
            scorer,
            vote,
            info: {
              epoch,
              activatedStakeLamports: info.activatedStake,
              rank: info.rank,
              superminority: info.superminority,
            },
          }),
          'scorer',
        );
        if (!ok(posted)) continue;
      }
      const result = await step(`refresh_score ${key}`, [
        ...copyVoteAccount({ programId, cranker: crank, vote }),
        ...refreshScore({
          programId,
          cranker: crank,
          vote,
          operator,
          marketMaker: config.marketMaker,
          currentEpoch: epoch,
        }),
      ]);
      if (ok(result)) logger.info('score refreshed from history', { vote: key, epoch: epoch.toString() });
    }
    return retry ? 'retry' : 'done';
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn(message);
  }
}
