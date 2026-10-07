import { retry } from '@epoch/common';
import {
  activeIndexOperators,
  ballotVotes,
  bpsOf,
  castIndexVote,
  type FeeIndexAccount,
  findFeeIndexPda,
  findIndexOperatorsPda,
  findPoolPda,
  type IndexBallotAccount,
  type IndexBallotStatus,
  indexBallotStatus,
  type IndexVote,
  postIndex,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type PublicKey } from '@solana/web3.js';

import { describeFailure, type PublisherChain } from '../Chain/PublisherChain';
import { type EpochOffset, programEpochFor } from '../Index/EpochMapping';
import { sameHash } from '../Index/InputsHash';
import { type EpochIndexRow, type IndexStore } from '../Repositories/EpochIndexRepository';
import { type PublisherStep } from './PublisherStep';

const logger = Logger.create('IndexPublisher');

/** Unposted epochs at each end of the list compared with the on-chain hashes when looking for an unrecorded post. */
const RECOVERY_WINDOW = 3;

export interface IndexPublisherOptions {
  /** FEE_INDEX_EPOCH_OFFSET: `P = M + offset`, or `auto` (`P` = program cluster's epoch − 1 at posting time). */
  offset: EpochOffset;
}

type Choice = { row: EpochIndexRow; programEpoch: bigint } | { wait: string };

/**
 * Publishes the Solana Fee Index for finished mainnet epochs from `epoch_index`, one at a time and in order, under
 * program epoch P (EpochMapping), then records `posted_signature`.
 *
 * Consensus mode (the default once the admin runs initialize_index_operators, which makes the operator registry PDA
 * the FeeIndex's publisher): each configured operator key that is registered votes `cast_index_vote(P, value,
 * inputs_hash)` with the same value and hash, and the program proposes the weighted median once agreeing weight
 * reaches the threshold (docs/FEE_INDEX_METHODOLOGY.md). The ballots are the record of what was voted, so a crash can
 * never vote one mainnet epoch twice. See `vote`.
 *
 * Legacy mode (a FeeIndex whose publisher is PUBLISHER_KEYPAIR_PATH) posts with `post_index`. Each tick it:
 *
 * 1. records a post that landed but was never written to the database (the pending or final inputs hash on-chain
 *    is one of ours), so a crash can never make it post the same mainnet epoch twice;
 * 2. waits while a proposal is pending (post_index refuses; cranks_app's FinalizeIndexJob finalizes it);
 * 3. stops if its latest post is not the last final value (vetoed): the admin decides;
 * 4. picks the next mainnet epoch M and its P, and posts only if P > the last final epoch, P has started on the
 *    program cluster (trading on P's quotes is closed, so the value cannot leak into open trading), the move from
 *    the last final value is within `max_move_bps` (otherwise it stops: the admin decides), and M has slot_fees rows
 *    to hash (`inputs_hash`, see Index/InputsHash.ts).
 *
 * TODO(F9, out of scope): mirror each final value to a Switchboard On-Demand feed as a separate PublisherStep. Check
 * first: docs/ARCHITECTURE.md records that Switchboard shut down on 25 Sep 2026, so the program is its own oracle.
 */
export class IndexPublisher implements PublisherStep {
  readonly name = 'IndexPublisher';
  private readonly hashes = new Map<number, { hash: Uint8Array; slots: number }>();
  /** Configured operator keys already warned about not being registered. */
  private readonly unregistered = new Set<string>();
  private registry?: PublicKey;
  private lastNotice?: string;

  constructor(
    private readonly chain: PublisherChain,
    private readonly store: IndexStore,
    private readonly options: IndexPublisherOptions,
  ) {}

  async tick(): Promise<void> {
    const publisher = this.chain.keyOf('publisher');
    if (!publisher && this.chain.operatorKeys().length === 0) return;
    const index = await this.chain.feeIndex();
    if (!index) return this.notice('wait', 'the FeeIndex is not initialized yet (initialize_index)');
    if (index.publisher.equals(this.registryAddress())) return this.vote(index);
    if (!publisher) {
      return this.notice(
        'stop',
        `operator consensus is off (the FeeIndex publisher is ${index.publisher.toBase58()}, not the operator ` +
          `registry): set PUBLISHER_KEYPAIR_PATH to that key, or the admin turns consensus on (initialize_index_operators)`,
      );
    }
    if (!index.publisher.equals(publisher)) {
      return this.notice(
        'stop',
        `PUBLISHER_KEYPAIR_PATH (${publisher.toBase58()}) is not the FeeIndex publisher (${index.publisher.toBase58()})`,
      );
    }

    const { epoch: programEpoch } = await this.chain.clock();
    const lastPosted = await this.store.latestPosted();
    const candidates = await this.store.unposted(lastPosted?.epoch ?? null);

    if (await this.recoverUnrecorded(index, candidates)) return;

    if (index.hasProposal) {
      return this.notice(
        'wait',
        `the proposal for program epoch ${index.proposedEpoch} is in its dispute window until slot ` +
          `${index.proposedSlot + index.disputeWindowSlots}; cranks_app finalizes it`,
      );
    }

    if (lastPosted && !(await this.isLastFinal(index, lastPosted))) {
      return this.notice(
        'stop',
        `our latest post (mainnet epoch ${lastPosted.epoch}, ${lastPosted.postedSignature}) is not the FeeIndex's last ` +
          `final value: it was vetoed (or the FeeIndex was reset). The admin decides: to re-post it, correct ` +
          `epoch_index.value if needed and set its posted_signature to NULL; to skip it, delete that epoch_index row`,
      );
    }

    const choice = this.choose(candidates, index, programEpoch, lastPosted === null);
    if ('wait' in choice) return this.notice('wait', choice.wait);
    const { row, programEpoch: target } = choice;
    const value = BigInt(row.value);

    const tooFar = this.moveTooLarge(index, row.epoch, value, 'post_index would fail with IndexMoveTooLarge');
    if (tooFar) return this.notice('stop', tooFar);

    const { hash, slots } = await this.hashOf(row.epoch);
    if (slots === 0) {
      return this.notice(
        'stop',
        `mainnet epoch ${row.epoch} has no slot_fees rows: refusing to post a value nobody can recompute`,
      );
    }
    if (value === 0n) logger.warn('posting a zero Fee Index value', { mainnetEpoch: row.epoch });

    const result = await this.chain.execute(
      `post_index ${target} (mainnet ${row.epoch})`,
      postIndex({ programId: this.chain.programId, publisher, epoch: target, value, inputsHash: hash }),
      'publisher',
    );
    const meta = { mainnetEpoch: row.epoch, programEpoch: target.toString(), value: value.toString(), slots };
    if (result.status === 'sent') {
      logger.info('Fee Index proposed', { ...meta, signature: result.signature });
      this.lastNotice = undefined;
      await this.record(row.epoch, result.signature);
    } else if (result.status === 'simulated') {
      this.notice('wait', `DRY_RUN: would post mainnet epoch ${row.epoch} as program epoch ${target} (value ${value})`);
    } else {
      logger.error('post_index failed', undefined, { ...meta, reason: describeFailure(result) });
    }
  }

  /**
   * Consensus mode. Each tick, in order:
   *
   * 1. records a vote that landed but was never written to the database (one of our keys voted an unposted row's
   *    inputs hash in a live or agreed ballot);
   * 2. follows the lowest unsettled ballot holding one of our votes: our keys missing from it vote the same value and
   *    hash (a crash between two votes); otherwise it waits while the ballot votes (logging agreeing weight and our
   *    deviation), is queued or is in its dispute window, and stops when its proposal was vetoed (the admin decides,
   *    as in legacy mode);
   * 3. otherwise picks the next row and program epoch exactly as legacy mode does (same max_move_bps and slot_fees
   *    checks), and every registered operator key that has not voted in the counting round votes it. The first
   *    vote's signature becomes the row's posted_signature.
   */
  private async vote(index: FeeIndexAccount): Promise<void> {
    const keys = this.chain.operatorKeys();
    if (keys.length === 0) {
      return this.notice(
        'stop',
        'operator consensus is on (the FeeIndex publisher is the operator registry), but no operator key is ' +
          'configured: set INDEX_OPERATOR_KEYPAIR_PATHS',
      );
    }
    const registry = await this.chain.indexOperators();
    const registered = registry ? activeIndexOperators(registry) : [];
    const ours = keys.filter((k) => registered.some((o) => o.key.equals(k)));
    if (ours.length === 0) {
      return this.notice(
        'stop',
        `none of the operator keys (${keys.map((k) => k.toBase58()).join(', ')}) is in the FeeIndex operator ` +
          'registry: the admin adds them (add_index_operator)',
      );
    }
    for (const k of keys) {
      if (ours.includes(k) || this.unregistered.has(k.toBase58())) continue;
      this.unregistered.add(k.toBase58());
      logger.warn('operator key is not registered; it does not vote', { operator: k.toBase58() });
    }

    const { epoch: programEpoch } = await this.chain.clock();
    const ballots = (await this.chain.indexBallots()).sort((a, b) => (a.epoch < b.epoch ? -1 : 1));
    const lastPosted = await this.store.latestPosted();
    const candidates = await this.store.unposted(lastPosted?.epoch ?? null);

    if (await this.recoverUnrecordedVote(index, ballots, ours, candidates)) return;

    for (const ballot of ballots) {
      const status = indexBallotStatus(ballot, index);
      const mine = ballotVotes(ballot).filter((v) => v.voted && ours.some((k) => k.equals(v.operator)));
      if (status === 'settled' || mine.length === 0) continue;
      // A vetoed vote whose row the admin re-opened (posted_signature set to NULL) is voted again below.
      if (status === 'vetoed' && (await this.rowWithHash(candidates, mine[0].inputsHash))) continue;
      return this.follow(index, ballot, status, mine, ours);
    }

    if (index.hasProposal) {
      return this.notice(
        'wait',
        `the proposal for program epoch ${index.proposedEpoch} is in its dispute window until slot ` +
          `${index.proposedSlot + index.disputeWindowSlots}; cranks_app finalizes it`,
      );
    }

    const choice = this.choose(candidates, index, programEpoch, lastPosted === null);
    if ('wait' in choice) return this.notice('wait', choice.wait);
    const { row, programEpoch: target } = choice;
    const value = BigInt(row.value);
    const tooFar = this.moveTooLarge(index, row.epoch, value, 'cast_index_vote would only queue it');
    if (tooFar) return this.notice('stop', tooFar);
    const { hash, slots } = await this.hashOf(row.epoch);
    if (slots === 0) {
      return this.notice(
        'stop',
        `mainnet epoch ${row.epoch} has no slot_fees rows: refusing to vote a value nobody can recompute`,
      );
    }
    if (value === 0n) logger.warn('voting a zero Fee Index value', { mainnetEpoch: row.epoch });

    const ballot = ballots.find((b) => b.epoch === target);
    const status = ballot ? indexBallotStatus(ballot, index) : null;
    // A new ballot, or a vetoed one (the first vote opens the next round with a fresh snapshot): every key of ours
    // votes. Otherwise only those in the round's snapshot that have not voted (a key added later is not in it).
    const voters =
      !ballot || status === 'vetoed'
        ? ours
        : ours.filter((k) => ballotVotes(ballot).some((v) => !v.voted && v.operator.equals(k)));
    if (voters.length === 0) {
      return this.notice(
        'stop',
        `program epoch ${target}'s round ${ballot?.round ?? 0} opened before our operator keys were registered: ` +
          'the admin reopens it with the current registry (reset_index_ballot)',
      );
    }
    const signature = await this.cast(voters, target, row.epoch, value, hash, slots);
    if (signature) await this.record(row.epoch, signature);
  }

  /** Waits on, completes or stops at a ballot that holds our votes. */
  private async follow(
    index: FeeIndexAccount,
    ballot: IndexBallotAccount,
    status: Exclude<IndexBallotStatus, 'settled'>,
    mine: IndexVote[],
    ours: PublicKey[],
  ): Promise<void> {
    const epoch = ballot.epoch;
    if (status === 'voting') {
      const missing = ours.filter((k) => ballotVotes(ballot).some((v) => !v.voted && v.operator.equals(k)));
      if (missing.length > 0) {
        const { value, inputsHash } = mine[0];
        await this.cast(missing, epoch, null, value, inputsHash, null);
        return;
      }
      return this.notice(
        'wait',
        `program epoch ${epoch} is voting (round ${ballot.round}): agreeing weight ${ballot.agreeingWeight} of ` +
          `${ballot.totalWeight} (${ballot.thresholdBps} bps needed), median ${ballot.medianValue}, ` +
          `${ballot.votesCast} of ${ballot.operatorCount} voted; our deviation ` +
          `${mine.map((v) => `${v.deviationBps} bps`).join(', ')}`,
      );
    }
    if (status === 'queued') {
      return this.notice(
        'wait',
        `program epoch ${epoch} agreed on ${ballot.consensusValue}; the proposal is queued until the FeeIndex can take ` +
          'it (an earlier proposal in its window, or a move above max_move_bps); cranks_app submits it',
      );
    }
    if (status === 'proposed') {
      return this.notice(
        'wait',
        `program epoch ${epoch}'s agreed value ${ballot.consensusValue} is in its dispute window until slot ` +
          `${index.proposedSlot + index.disputeWindowSlots}; cranks_app finalizes it`,
      );
    }
    return this.notice(
      'stop',
      `the agreed value ${ballot.consensusValue} for program epoch ${epoch} (round ${ballot.round}) was vetoed. The ` +
        `admin decides: to vote again, correct epoch_index.value if needed and set that row's posted_signature to ` +
        `NULL (the first vote opens round ${ballot.round + 1}); to skip it, delete that epoch_index row`,
    );
  }

  /** Sends one cast_index_vote per key; returns the first signature sent (null under DRY_RUN or on failure). */
  private async cast(
    voters: PublicKey[],
    programEpoch: bigint,
    mainnetEpoch: number | null,
    value: bigint,
    inputsHash: Uint8Array,
    slots: number | null,
  ): Promise<string | null> {
    let first: string | null = null;
    const of = mainnetEpoch === null ? '' : ` (mainnet ${mainnetEpoch})`;
    for (const operator of voters) {
      const result = await this.chain.execute(
        `cast_index_vote ${programEpoch}${of} by ${operator.toBase58()}`,
        castIndexVote({ programId: this.chain.programId, operator, epoch: programEpoch, value, inputsHash }),
        operator,
      );
      const meta = {
        mainnetEpoch,
        programEpoch: programEpoch.toString(),
        value: value.toString(),
        operator: operator.toBase58(),
        ...(slots === null ? {} : { slots }),
      };
      if (result.status === 'sent') {
        logger.info('Fee Index vote cast', { ...meta, signature: result.signature });
        this.lastNotice = undefined;
        first ??= result.signature;
      } else if (result.status === 'simulated') {
        this.notice('wait', `DRY_RUN: would vote ${value} for program epoch ${programEpoch}${of}`);
      } else {
        logger.error('cast_index_vote failed', undefined, { ...meta, reason: describeFailure(result) });
      }
    }
    return first;
  }

  /**
   * A vote that landed but whose signature never reached the database: one of our keys voted an unposted row's inputs
   * hash in a ballot that is voting, queued, proposed or agreed and final. Records it and returns true.
   */
  private async recoverUnrecordedVote(
    index: FeeIndexAccount,
    ballots: IndexBallotAccount[],
    ours: PublicKey[],
    candidates: EpochIndexRow[],
  ): Promise<boolean> {
    const votes = ballots
      .filter((b) => {
        const status = indexBallotStatus(b, index);
        return status !== 'vetoed' && (status !== 'settled' || b.consensusSlot > 0n);
      })
      .flatMap((b) => ballotVotes(b).filter((v) => v.voted && ours.some((k) => k.equals(v.operator))));
    if (votes.length === 0 || candidates.length === 0) return false;

    const window = new Set([...candidates.slice(0, RECOVERY_WINDOW), ...candidates.slice(-RECOVERY_WINDOW)]);
    for (const row of window) {
      const { hash, slots } = await this.hashOf(row.epoch);
      const vote = slots === 0 ? undefined : votes.find((v) => sameHash(v.inputsHash, hash));
      if (!vote) continue;
      const signature = await this.chain.findVoteSignature(vote.operator, hash);
      if (!signature) {
        this.notice(
          'stop',
          `mainnet epoch ${row.epoch} is already voted on-chain by ${vote.operator.toBase58()}, but its ` +
            `cast_index_vote is not in that key's recent history: set epoch_index.posted_signature for that row by hand`,
        );
        return true;
      }
      if (this.chain.dryRun) {
        this.notice('wait', `DRY_RUN: would record ${signature} as mainnet epoch ${row.epoch}'s vote`);
        return true;
      }
      logger.warn('recording a cast_index_vote that landed without being recorded', {
        mainnetEpoch: row.epoch,
        signature,
      });
      await this.record(row.epoch, signature);
      return true;
    }
    return false;
  }

  private async rowWithHash(rows: EpochIndexRow[], hash: Uint8Array): Promise<EpochIndexRow | undefined> {
    for (const row of rows) {
      const computed = await this.hashOf(row.epoch);
      if (computed.slots > 0 && sameHash(computed.hash, hash)) return row;
    }
    return undefined;
  }

  /** Why the move from the last final value is beyond max_move_bps, or null when it is within. */
  private moveTooLarge(
    index: FeeIndexAccount,
    mainnetEpoch: number,
    value: bigint,
    consequence: string,
  ): string | null {
    if (index.finalizedSlot === 0n || index.value === 0n) return null;
    const bound = bpsOf(index.value, index.maxMoveBps);
    const move = value > index.value ? value - index.value : index.value - value;
    if (move <= bound) return null;
    return (
      `mainnet epoch ${mainnetEpoch}'s value ${value} moves ${move} from the last final value ${index.value}, more ` +
      `than the FeeIndex allows (${index.maxMoveBps} bps = ${bound}); ${consequence}. The admin decides: widen ` +
      `max_move_bps (configure_index) or correct epoch_index`
    );
  }

  private registryAddress(): PublicKey {
    const programId = this.chain.programId;
    this.registry ??= findIndexOperatorsPda(programId, findFeeIndexPda(programId, findPoolPda(programId)[0])[0])[0];
    return this.registry;
  }

  /** Program epoch and row to post next, or why to wait. */
  private choose(
    candidates: EpochIndexRow[],
    index: FeeIndexAccount,
    programEpoch: bigint,
    firstPost: boolean,
  ): Choice {
    const { offset } = this.options;
    if (offset === 'auto') {
      const target = programEpoch - 1n;
      if (target <= index.epoch) {
        return {
          wait: `program epoch ${target} already has a final value; the next post waits for epoch ${index.epoch + 2n}`,
        };
      }
      // Each program epoch takes the newest finished mainnet epoch; older unposted ones are skipped.
      const row = candidates[candidates.length - 1];
      return row ? { row, programEpoch: target } : { wait: 'no new finished mainnet epoch in epoch_index' };
    }

    const target = (row: EpochIndexRow) => programEpochFor(row.epoch, offset, programEpoch);
    const eligible = candidates.filter((row) => target(row) > index.epoch);
    if (eligible.length === 0) {
      return { wait: `no finished mainnet epoch maps above the last final program epoch ${index.epoch}` };
    }
    // The very first post starts from the newest epoch that has started, not from the oldest row in the table.
    const started = eligible.filter((row) => target(row) <= programEpoch);
    const row = firstPost && started.length > 0 ? started[started.length - 1] : eligible[0];
    const p = target(row);
    if (p > programEpoch) {
      return {
        wait:
          `mainnet epoch ${row.epoch} maps to program epoch ${p}, which has not started (current ${programEpoch}); ` +
          `posting now would reveal its value while its quotes still trade`,
      };
    }
    return { row, programEpoch: p };
  }

  /**
   * A post_index that landed but whose signature never reached the database: the FeeIndex's pending or last final
   * inputs hash equals one of the unposted epochs'. Records it and returns true (nothing else happens this tick).
   */
  private async recoverUnrecorded(index: FeeIndexAccount, candidates: EpochIndexRow[]): Promise<boolean> {
    const onChain: Uint8Array[] = [];
    if (index.hasProposal) onChain.push(index.proposedInputsHash);
    if (index.finalizedSlot > 0n) onChain.push(index.inputsHash);
    if (onChain.length === 0 || candidates.length === 0) return false;

    const window = new Set([...candidates.slice(0, RECOVERY_WINDOW), ...candidates.slice(-RECOVERY_WINDOW)]);
    for (const row of window) {
      const { hash, slots } = await this.hashOf(row.epoch);
      if (slots === 0 || !onChain.some((h) => sameHash(h, hash))) continue;
      const signature = await this.chain.findProposalSignature(hash);
      if (!signature) {
        this.notice(
          'stop',
          `mainnet epoch ${row.epoch} is already proposed on-chain, but its post_index transaction is not in the ` +
            `publisher's recent history: set epoch_index.posted_signature for that row by hand`,
        );
        return true;
      }
      if (this.chain.dryRun) {
        this.notice('wait', `DRY_RUN: would record ${signature} as mainnet epoch ${row.epoch}'s post_index`);
        return true;
      }
      logger.warn('recording a post_index that landed without being recorded', { mainnetEpoch: row.epoch, signature });
      await this.record(row.epoch, signature);
      return true;
    }
    return false;
  }

  private async isLastFinal(index: FeeIndexAccount, lastPosted: EpochIndexRow): Promise<boolean> {
    if (index.finalizedSlot === 0n) return false;
    const { hash, slots } = await this.hashOf(lastPosted.epoch);
    if (slots === 0) {
      this.notice('wait', `cannot re-check mainnet epoch ${lastPosted.epoch} (no slot_fees rows left); assuming final`);
      return true;
    }
    return sameHash(index.inputsHash, hash);
  }

  private async hashOf(epoch: number): Promise<{ hash: Uint8Array; slots: number }> {
    const cached = this.hashes.get(epoch);
    if (cached) return cached;
    const computed = await this.store.inputsHash(epoch);
    if (computed.slots > 0) this.hashes.set(epoch, computed);
    return computed;
  }

  private async record(epoch: number, signature: string): Promise<void> {
    try {
      const marked = await retry(() => this.store.markPosted(epoch, signature), { retries: 3, baseDelayMs: 500 });
      if (!marked) logger.warn('epoch_index row was already marked posted', { mainnetEpoch: epoch, signature });
    } catch (error) {
      // The next tick finds the proposal on-chain by its hash and records it then.
      logger.error('could not record posted_signature', error, { mainnetEpoch: epoch, signature });
    }
  }

  /** Logs a wait (info) or a stop (error: the admin must act) once, not on every tick. */
  private notice(kind: 'wait' | 'stop', message: string): void {
    const key = `${kind}:${message}`;
    if (key === this.lastNotice) return;
    this.lastNotice = key;
    if (kind === 'stop') logger.error(`STOPPED: ${message}`);
    else logger.info(message);
  }
}
