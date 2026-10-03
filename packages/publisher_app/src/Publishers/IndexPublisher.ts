import { retry } from '@epoch/common';
import { bpsOf, type FeeIndexAccount, postIndex } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

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
 * Posts the Solana Fee Index (`post_index`) for finished mainnet epochs from `epoch_index`, one at a time and in
 * order, under program epoch P (EpochMapping), then records `posted_signature`. Each tick it:
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
  private lastNotice?: string;

  constructor(
    private readonly chain: PublisherChain,
    private readonly store: IndexStore,
    private readonly options: IndexPublisherOptions,
  ) {}

  async tick(): Promise<void> {
    const publisher = this.chain.keyOf('publisher');
    if (!publisher) return;
    const index = await this.chain.feeIndex();
    if (!index) return this.notice('wait', 'the FeeIndex is not initialized yet (initialize_index)');
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

    if (index.finalizedSlot > 0n && index.value > 0n) {
      const bound = bpsOf(index.value, index.maxMoveBps);
      const move = value > index.value ? value - index.value : index.value - value;
      if (move > bound) {
        return this.notice(
          'stop',
          `mainnet epoch ${row.epoch}'s value ${value} moves ${move} from the last final value ${index.value}, more ` +
            `than the FeeIndex allows (${index.maxMoveBps} bps = ${bound}); post_index would fail with ` +
            `IndexMoveTooLarge. The admin decides: widen max_move_bps (configure_index) or correct epoch_index`,
        );
      }
    }

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
