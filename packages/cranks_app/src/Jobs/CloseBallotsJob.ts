import { closeIndexBallot, indexBallotStatus } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { describeFailure, type EpochChain } from '../Chain/EpochChain';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('CloseBallotsJob');

/** Epochs a settled ballot stays open for live reads (the API's ballot view) before it is closed. */
export const DEFAULT_BALLOT_RETENTION_EPOCHS = 4;

/**
 * `close_index_ballot` for every Fee Index ballot whose epoch is final or was skipped over (the FeeIndex's last final
 * epoch is at or past it: nothing can ever be proposed for it again) and at least `retentionEpochs` behind the last
 * final epoch, refunding the rent (about 0.0074 SOL) to the ballot's payer, the operator that opened it. Permissionless;
 * the votes stay in the indexed events, so closing loses nothing. Runs once per program epoch.
 */
export class CloseBallotsJob implements Job {
  readonly name = 'CloseBallotsJob';

  constructor(
    private readonly chain: EpochChain,
    private readonly retentionEpochs = DEFAULT_BALLOT_RETENTION_EPOCHS,
  ) {}

  async run(_epoch: bigint): Promise<JobOutcome> {
    const cranker = this.chain.keyOf('crank');
    if (!cranker) throw new Error('crank keypair missing');
    const index = await this.chain.feeIndex();
    if (!index) return 'done';
    const lastFinal = index.account.epoch;
    const closable = (await this.chain.indexBallots())
      .map(({ account }) => account)
      .filter((b) => indexBallotStatus(b, index.account) === 'settled')
      .filter((b) => b.epoch + BigInt(this.retentionEpochs) <= lastFinal)
      .sort((a, b) => (a.epoch < b.epoch ? -1 : 1));

    let retry = false;
    for (const ballot of closable) {
      const result = await this.chain.execute(
        `close_index_ballot ${ballot.epoch}`,
        closeIndexBallot({ programId: this.chain.programId, cranker, epoch: ballot.epoch, payer: ballot.payer }),
        'crank',
      );
      const meta = { epoch: ballot.epoch.toString(), payer: ballot.payer.toBase58() };
      if (result.status === 'failed') {
        // Closed by someone else since the read: Anchor's AccountNotInitialized (3012), not an Epoch error.
        if (result.logs.some((line) => line.includes('Error Code: AccountNotInitialized'))) {
          logger.info('ballot already closed', meta);
        } else {
          logger.error('close_index_ballot failed', undefined, { ...meta, reason: describeFailure(result) });
        }
        retry ||= result.transient;
        continue;
      }
      logger.info('Fee Index ballot closed', { ...meta, status: result.status });
    }
    return retry ? 'retry' : 'done';
  }
}
