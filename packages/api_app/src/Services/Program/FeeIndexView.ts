import { type FeeIndexAccount, feeIndexHistory, feeIndexValueFor } from '@epoch/epoch-sdk';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { round } from '../../Lib/Stats';
import { type EpochIndexValue } from '../../types/Program.types';
import { big, chainOrder, payload } from './ProgramFormat';
import { type EventReader, type ProgramReader } from './ProgramSources';

/**
 * The Fee Index as the market and the Vault's cycle need it. Another service (`FeeIndexService.latest()`) exposes the
 * same final / proposed / avg8 figures; this one also answers per-epoch statuses for quotes and swaps.
 */
export interface FeeIndexView {
  /** The last finalized value; null until the first one. */
  final: { epoch: number; value: number } | null;
  /** The pending proposal and the slot its dispute window ends. */
  proposed: { epoch: number; value: number; disputeEndsSlot: number } | null;
  /** Mean of the last 8 final values; null until the first one. */
  avg8: number | null;
  /** One epoch's value: final (the account's value or history, else an IndexFinalized event), the pending proposal,
   * or vetoed (an IndexVetoed event and nothing newer); null before anything was proposed. */
  valueFor(epoch: number): EpochIndexValue | null;
}

export function buildFeeIndexView(
  account: FeeIndexAccount | null,
  finalized: readonly StoredProgramEvent[],
  vetoed: readonly StoredProgramEvent[],
): FeeIndexView {
  const finals = new Map<number, number>();
  for (const event of [...finalized].sort(chainOrder)) {
    const fields = payload(event, 'IndexFinalized');
    finals.set(Number(fields.epoch), Number(big(fields.value)));
  }
  const vetoes = new Map<number, number>();
  for (const event of [...vetoed].sort(chainOrder)) {
    const fields = payload(event, 'IndexVetoed');
    vetoes.set(Number(fields.epoch), Number(big(fields.value)));
  }

  const hasFinal = account !== null && account.finalizedSlot > 0n;
  const final = hasFinal ? { epoch: Number(account.epoch), value: Number(account.value) } : null;
  const proposed =
    account?.hasProposal === true
      ? {
          epoch: Number(account.proposedEpoch),
          value: Number(account.proposedValue),
          disputeEndsSlot: Number(account.proposedSlot + account.disputeWindowSlots),
        }
      : null;
  let avg8: number | null = null;
  if (hasFinal) {
    const lastEight = [...feeIndexHistory(account), { epoch: account.epoch, value: account.value }].slice(-8);
    avg8 = round(lastEight.reduce((total, point) => total + Number(point.value), 0) / lastEight.length, 1);
  }

  return {
    final,
    proposed,
    avg8,
    valueFor(epoch: number): EpochIndexValue | null {
      const onChain = account ? feeIndexValueFor(account, BigInt(epoch)) : null;
      if (onChain !== null) return { value: Number(onChain), status: 'final' };
      const fromEvent = finals.get(epoch);
      if (fromEvent !== undefined) return { value: fromEvent, status: 'final' };
      if (proposed && proposed.epoch === epoch) return { value: proposed.value, status: 'proposed' };
      const veto = vetoes.get(epoch);
      if (veto !== undefined) return { value: veto, status: 'vetoed' };
      return null;
    },
  };
}

/** Reads the FeeIndex account and the IndexFinalized / IndexVetoed events. */
export async function loadFeeIndexView(
  program: Pick<ProgramReader, 'feeIndex'>,
  events: EventReader,
): Promise<FeeIndexView> {
  const [account, finalized, vetoed] = await Promise.all([
    program.feeIndex(),
    events.query({ names: ['IndexFinalized'], limit: 1_000 }),
    events.query({ names: ['IndexVetoed'], limit: 1_000 }),
  ]);
  return buildFeeIndexView(account?.account ?? null, finalized, vetoed);
}
