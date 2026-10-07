import { Logger } from '@epoch/logger';
import {
  claimStatusAddress,
  JITO_TIP_DISTRIBUTION_PROGRAM_ID,
  parseTipClaimStatus,
  parseTipDistributionAccount,
  tipDistributionAccountAddress,
} from '@epoch/solana';
import { PublicKey } from '@solana/web3.js';

import { type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('ClaimMevJob');

export interface ClaimMevJobOptions {
  /** Jito's tip-distribution program on the Epoch program's cluster (mainnet's by default). */
  tipDistributionProgramId?: string;
  /** How long after the runner first saw the epoch the sweep waits for Jito's claims (MEV_CLAIM_WAIT_MINUTES). */
  waitMinutes: number;
  now?: () => number;
}

/** Why a position's sweep waits. */
type Waiting = { vote: string; tda: string; reason: 'root' | 'claim' };

/**
 * A gate before the sweep, never a claim. Jito's `claim(bump, amount, proof)` requires the
 * `merkle_root_upload_authority` signer (jito-programs `tip-distribution/src/lib.rs`, `Claim` accounts), so only Jito's
 * (TipRouter's) crank can claim. The validator's commission node has the vote account as claimant (jito-tip-router
 * `meta_merkle_tree/src/generated_merkle_tree.rs`, `generate_validator_node`), so once claimed the lamports sit in the
 * vote account and the sweep collects them with the rest of the revenue.
 *
 * For program epoch E and every Active or Late position not swept yet: read the TipDistributionAccount
 * `["TIP_DISTRIBUTION_ACCOUNT", vote, (E − 1) u64 LE]` (one getMultipleAccounts for all positions). No TDA → nothing to
 * wait for (not running Jito, or a cluster without Jito, like devnet). 0 % commission → the node is 0 and is never
 * claimed: nothing to wait for. Commission above 0 and no merkle root yet, or the root but no claimed ClaimStatus
 * `["CLAIM_STATUS", vote, tda]` (one more call for all of them) → `retry`, so the sweep waits; at most `waitMinutes`
 * after the runner first saw epoch E (mainnet claims landed 1.2 to 3.1 hours after the boundary in epoch 1051), then
 * `done` with a warning: the commission arrives later and is swept next epoch, nothing is lost.
 */
export class ClaimMevJob implements Job {
  readonly name = 'ClaimMevJob';
  private firstSeen?: { epoch: bigint; at: number };
  private readonly programId: string;

  constructor(
    private readonly chain: EpochChain,
    private readonly options: ClaimMevJobOptions,
  ) {
    this.programId = options.tipDistributionProgramId ?? JITO_TIP_DISTRIBUTION_PROGRAM_ID;
  }

  async run(epoch: bigint): Promise<JobOutcome> {
    const now = (this.options.now ?? Date.now)();
    if (this.firstSeen?.epoch !== epoch) this.firstSeen = { epoch, at: now };
    if (epoch === 0n) return 'done';

    const due = (await this.chain.positions()).filter(
      (p) => (p.account.status === 'active' || p.account.status === 'late') && p.account.lastSweptEpoch < epoch,
    );
    if (due.length === 0) return 'done';
    const waiting = await this.waitingFor(
      due.map((p) => p.account.vote.toBase58()),
      epoch - 1n,
    );
    if (waiting.length === 0) return 'done';

    const waitedMinutes = Math.floor((now - this.firstSeen.at) / 60_000);
    const detail = {
      epoch: epoch.toString(),
      mevEpoch: (epoch - 1n).toString(),
      waiting: waiting.map((w) => `${w.vote} (${w.reason === 'root' ? 'no merkle root yet' : 'not claimed yet'})`),
      waitedMinutes,
    };
    if (now - this.firstSeen.at >= this.options.waitMinutes * 60_000) {
      logger.warn('Jito has not claimed every MEV commission; sweeping now (the rest is swept next epoch)', detail);
      return 'done';
    }
    logger.info('waiting for Jito to claim MEV commissions before the sweep', detail);
    return 'retry';
  }

  /** Positions whose MEV commission for `mevEpoch` is not in the vote account yet. */
  private async waitingFor(votes: string[], mevEpoch: bigint): Promise<Waiting[]> {
    const tdas = votes.map((vote) => tipDistributionAccountAddress(vote, mevEpoch, this.programId));
    const tdaData = await this.chain.accountsData(tdas.map((address) => new PublicKey(address)));
    const waiting: Waiting[] = [];
    const rooted: Waiting[] = [];
    tdaData.forEach((data, i) => {
      const tda = data ? parseTipDistributionAccount(data) : null;
      if (!tda || tda.validatorCommissionBps === 0) return;
      const entry: Waiting = { vote: votes[i], tda: tdas[i], reason: tda.merkleRoot ? 'claim' : 'root' };
      (tda.merkleRoot ? rooted : waiting).push(entry);
    });
    if (rooted.length > 0) {
      const claims = await this.chain.accountsData(
        rooted.map((r) => new PublicKey(claimStatusAddress(r.vote, r.tda, this.programId))),
      );
      claims.forEach((data, i) => {
        if (!(data && parseTipClaimStatus(data)?.isClaimed)) waiting.push(rooted[i]);
      });
    }
    return waiting;
  }
}
