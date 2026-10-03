import {
  type AdvanceAccount,
  bpsOf,
  type PoolParams,
  trailingRevenue,
  type ValidatorPositionAccount,
} from '@epoch/epoch-sdk';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { type AdvanceStatus } from '../../types/Program.types';
import { big, payload } from './ProgramFormat';

/**
 * An advance's status in the UI's words.
 *
 * - Open → `late` while the position is Late (a sweep found no revenue), else `active`.
 * - Defaulted → `recovered` once repaid ≥ total due, else `defaulted`.
 * - Repaid → `recovered` when the advance was written off first (an `AdvanceDefaulted` event names it), else `repaid`.
 *   The program flips a defaulted advance to Repaid when its recoveries clear `total_due` (sweep.rs), so `recovered`
 *   would never show if only the account state were read.
 */
export function advanceStatus(
  advance: AdvanceAccount,
  position: ValidatorPositionAccount | undefined,
  everDefaulted: boolean,
): AdvanceStatus {
  switch (advance.state) {
    case 'open':
      return position?.status === 'late' ? 'late' : 'active';
    case 'defaulted':
      return advance.repaid >= advance.totalDue ? 'recovered' : 'defaulted';
    case 'repaid':
      return everDefaulted ? 'recovered' : 'repaid';
  }
}

/** Average swept revenue per epoch (lamports) over the position's window; 0 before the first sweep. */
export const averageRevenue = (position: ValidatorPositionAccount): bigint =>
  position.revenueCount > 0 ? trailingRevenue(position) / BigInt(position.revenueCount) : 0n;

/** What the next sweep is expected to take: `remit_bps` of average revenue, all of it once defaulted. */
export function expectedRemit(advance: AdvanceAccount, position: ValidatorPositionAccount): bigint {
  const average = averageRevenue(position);
  return advance.state === 'defaulted' ? average : bpsOf(average, advance.remitBps);
}

/** Recoveries swept after a default: remittances that were not attributed to principal or fee (sweep.rs). */
export const recoveredAfterDefault = (advance: AdvanceAccount): bigint => {
  const attributed = advance.principalRepaid + advance.feeRepaid;
  return advance.repaid > attributed ? advance.repaid - attributed : 0n;
};

/** One plain sentence for the loan book, or null. */
export function advanceNote(
  status: AdvanceStatus,
  advance: AdvanceAccount,
  position: ValidatorPositionAccount | undefined,
  defaultEvent: StoredProgramEvent | undefined,
): string | null {
  const bondApplied = defaultEvent ? big(payload(defaultEvent, 'AdvanceDefaulted').bondApplied) : 0n;
  switch (status) {
    case 'late': {
      const late = position?.lateEpochs ?? 0;
      return `Late ${late} epoch${late === 1 ? '' : 's'}: revenue stopped`;
    }
    case 'defaulted':
      return bondApplied > 0n
        ? 'Defaulted: bond applied, every sweep takes 100% until recovered'
        : 'Defaulted: every sweep takes 100% until recovered';
    case 'recovered': {
      const fromSweeps = recoveredAfterDefault(advance) > 0n;
      if (bondApplied > 0n)
        return fromSweeps ? 'Recovered: bond applied, the rest from sweeps' : 'Recovered: bond paid';
      return 'Recovered from sweeps after a default';
    }
    case 'active': {
      if (!position) return null;
      const next = expectedRemit(advance, position);
      const owed = advance.totalDue - advance.repaid;
      return next > 0n && owed > 0n && owed <= next ? 'Last payment next' : null;
    }
    case 'repaid':
      return null;
  }
}

/** The limit rate that applies to this position now: hedged or unhedged. */
export const limitRateBps = (params: PoolParams, hedged: boolean): number =>
  hedged ? params.advanceBpsHedged : params.advanceBpsUnhedged;
