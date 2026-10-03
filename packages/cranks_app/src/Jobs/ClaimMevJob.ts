import { Logger } from '@epoch/logger';

import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('ClaimMevJob');

/**
 * Jito MEV commission for each onboarded validator. Not implemented, on purpose:
 *
 * - Jito's tip-distribution `claim(bump, amount, proof)` requires `merkle_root_upload_authority` as a signer
 *   (jito-programs `tip-distribution/src/lib.rs`, `Claim` accounts), so claims are permissioned: Jito's (TipRouter
 *   NCN's) claim crank submits them for every staker and validator. A third-party crank cannot claim.
 * - The validator's commission node in the merkle tree has the vote account as its claimant
 *   (jito-tip-router `meta_merkle_tree/src/generated_merkle_tree.rs`, `generate_validator_node`), so once Jito claims
 *   it the lamports sit in the vote account and the next `sweep` collects them like any other revenue.
 * - The Epoch program runs on devnet for now (decision 6) and Jito's tip distribution exists on mainnet only.
 *
 * TODO(F8, mainnet): turn this into a check instead of a claim. For each position, derive the TipDistributionAccount
 * PDA `["TIP_DISTRIBUTION_ACCOUNT", vote, (epoch − 1) as u64 LE]` under the tip-distribution program
 * (4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7) and its ClaimStatus PDA `["CLAIM_STATUS", vote, tda]`; when the TDA
 * has a merkle root but no ClaimStatus exists yet, return `retry` for a bounded time so the sweep waits for Jito's
 * claim, then let the sweep run anyway (the commission is then swept one epoch later, nothing is lost).
 */
export class ClaimMevJob implements Job {
  readonly name = 'ClaimMevJob';
  private loggedEpoch?: bigint;

  async run(epoch: bigint): Promise<JobOutcome> {
    if (this.loggedEpoch !== epoch) {
      this.loggedEpoch = epoch;
      logger.info('MEV claims are submitted by Jito (permissioned); the sweep collects them from the vote account', {
        epoch: epoch.toString(),
      });
    }
    return 'done';
  }
}
