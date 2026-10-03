import { Logger } from '@epoch/logger';

import { shortKey } from '../../Lib/Stats';
import { type ValidatorRow } from '../../types/Api.types';
import { type ValidatorDirectory } from './ProgramSources';

const logger = Logger.create('ValidatorNames');

/**
 * Epochs a year when the mainnet validator table can't be read: ≈ 271.5 at today's slot times (decision 5, the figure
 * behind "3 bps ≈ 8.1% a year").
 */
export const FALLBACK_EPOCHS_PER_YEAR = 271.5;

/** Mainnet validator rows by vote account. A devnet vote key usually has no row: its name is then its short key. */
export interface ValidatorNames {
  /** False when the mainnet table could not be read. */
  available: boolean;
  epochsPerYear: number;
  grossYieldPerEpoch: number;
  row(vote: string): ValidatorRow | undefined;
  nameOf(vote: string): string;
}

export async function loadValidatorNames(directory: ValidatorDirectory): Promise<ValidatorNames> {
  try {
    const table = await directory.get();
    const byVote = new Map(table.rows.map((row) => [row.vote, row]));
    return {
      available: true,
      epochsPerYear: table.epochsPerYear > 0 ? table.epochsPerYear : FALLBACK_EPOCHS_PER_YEAR,
      grossYieldPerEpoch: table.grossYieldPerEpoch,
      row: (vote) => byVote.get(vote),
      nameOf: (vote) => byVote.get(vote)?.name ?? shortKey(vote),
    };
  } catch (error) {
    logger.warn('mainnet validator table unavailable; using short keys', { error: String(error) });
    return {
      available: false,
      epochsPerYear: FALLBACK_EPOCHS_PER_YEAR,
      grossYieldPerEpoch: 0,
      row: () => undefined,
      nameOf: (vote) => shortKey(vote),
    };
  }
}
