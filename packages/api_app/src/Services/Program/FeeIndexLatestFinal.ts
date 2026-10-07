import { FEE_INDEX_METHODOLOGY_URL } from '@epoch/config-sdk';
import { bytesToHex, type FeeIndexAccount } from '@epoch/epoch-sdk';
import { NotFoundException, ServiceUnavailableException } from '@epoch/exceptions';
import { type PublicKey } from '@solana/web3.js';

import { isoIst } from '../../Lib/Stats';
import { type ProgramAccount } from '../../Sources/EpochProgramSource';
import { type FeeIndexLatestFinal } from '../../types/Activity.types';
import { getServices } from '../index';

export const FEE_INDEX_ACCOUNT_SOURCE = "The Epoch program's FeeIndex account";

/** What GET /v1/index/latest-final reads (EpochProgramSource). */
export interface LatestFinalReader {
  readonly configured: boolean;
  readonly programId?: PublicKey;
  readonly cluster: string;
  feeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null>;
}

/**
 * GET /v1/index/latest-final: the FeeIndex account's last final point (`epoch`, `value`, `inputs_hash`,
 * `finalized_slot`), provider-neutral: no events or database, nothing a reader could not check on chain itself. 503
 * PROGRAM_NOT_CONFIGURED without the program; 404 until the first value is final.
 */
export async function latestFinal(program: LatestFinalReader, now = Date.now()): Promise<FeeIndexLatestFinal> {
  if (!program.configured || !program.programId) {
    throw new ServiceUnavailableException(
      'The latest final Fee Index needs the Epoch program (EPOCH_PROGRAM_ID); this API has none',
      'PROGRAM_NOT_CONFIGURED',
    );
  }
  const index = await program.feeIndex();
  if (!index || index.account.finalizedSlot === 0n) throw new NotFoundException('No Fee Index value is final yet');
  const { account } = index;
  return {
    schemaVersion: 1,
    kind: 'real',
    asOf: isoIst(new Date(now)),
    source: FEE_INDEX_ACCOUNT_SOURCE,
    epoch: Number(account.epoch),
    value: Number(account.value),
    unit: 'µL/CU',
    finalizedSlot: Number(account.finalizedSlot),
    inputsHash: bytesToHex(account.inputsHash),
    cluster: program.cluster,
    programId: program.programId.toBase58(),
    feeIndexAccount: index.address,
    methodology: FEE_INDEX_METHODOLOGY_URL,
  };
}

let reader: LatestFinalReader | undefined;

/** The shared program source, or the reader a test set. */
export const getLatestFinalReader = (): LatestFinalReader => reader ?? getServices().program;

/** Tests. */
export function setLatestFinalReader(next: LatestFinalReader | undefined): void {
  reader = next;
}
