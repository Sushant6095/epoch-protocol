import { type EventName } from '@epoch/epoch-sdk';

import { type PredictCallEvent, type StoredProgramEvent } from '../../Lib/EventBus';
import { LAMPORTS_PER_SOL, shortKey } from '../../Lib/Stats';
import { type ActivityEvent } from '../../types/Activity.types';
import { type NameIndex } from './ValidatorNames';

/** The program events the feed can show; every other event maps to null. */
export const ACTIVITY_EVENT_NAMES: readonly EventName[] = [
  'Swept',
  'Deposited',
  'WithdrawRequested',
  'WithdrawCancelled',
  'WithdrawProcessed',
  'AdvanceOpened',
  'AdvanceRepaid',
  'AdvanceDefaulted',
  'ValidatorOnboarded',
  'IndexProposed',
  'IndexFinalized',
  'IndexVetoed',
  'SwapOpened',
  'SwapSettled',
];

/** `WithdrawCancelled.reason`: the crank bounced the request at the Junior floor (0 = the owner cancelled it). */
const BOUNCED_AT_FLOOR = 1;

type Data = StoredProgramEvent['data'];

/** A u64/i64 decimal string (or number) as a number; null when absent or not numeric. */
const num = (value: Data[string] | undefined): number | null => {
  if (value === undefined || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Lamports (decimal string) → SOL. */
const sol = (value: Data[string] | undefined): number | null => {
  const lamports = num(value);
  return lamports === null ? null : lamports / LAMPORTS_PER_SOL;
};

const tranche = (data: Data): string => (data.tranche === 'junior' ? 'Junior' : 'Senior');

const validatorName = (data: Data, names: NameIndex): string => {
  const vote = String(data.vote ?? '');
  return names.byVote.get(vote) ?? shortKey(vote);
};

const solRow = (kind: ActivityEvent['kind'], text: string, amountSol: number | null) => ({
  kind,
  text,
  amountSol,
  value: null,
  unit: 'SOL' as const,
});

const indexRow = (data: Data, word: 'proposed' | 'final' | 'vetoed') => ({
  kind: 'index' as const,
  text: `Epoch ${data.epoch} Fee Index ${word}`,
  amountSol: null,
  value: num(data.value),
  unit: 'µL/CU' as const,
});

/**
 * One program event as an activity row, in the fixture's words ("Kestrel Nodes · repaid at source", "Epoch 1042 Fee
 * Index final"); null for events the feed does not show. Validators are named from `names.byVote`, else by short key.
 */
export function toActivityEvent(stored: StoredProgramEvent, names: NameIndex): ActivityEvent | null {
  const row = rowFor(stored, names);
  return row ? { id: `${stored.signature}:${stored.ix}`, ...row, signature: stored.signature } : null;
}

function rowFor(stored: StoredProgramEvent, names: NameIndex): Omit<ActivityEvent, 'id' | 'signature'> | null {
  const { data } = stored;
  switch (stored.name) {
    case 'Swept': {
      const remitted = sol(data.remitted);
      return remitted !== null && remitted > 0
        ? solRow('sweep', `${validatorName(data, names)} · repaid at source`, remitted)
        : solRow('sweep', `${validatorName(data, names)} · swept, nothing owed`, sol(data.gross));
    }
    case 'Deposited':
      return solRow('deposit', `${tranche(data)} tranche · deposit`, sol(data.assets));
    case 'WithdrawProcessed':
      return solRow('withdraw', `${tranche(data)} tranche · queue paid`, sol(data.assets));
    case 'WithdrawRequested':
      return solRow('withdraw', `${tranche(data)} tranche · withdrawal queued`, null);
    case 'WithdrawCancelled':
      // Only Junior requests bounce at the floor; an owner's own cancellation is not news.
      return num(data.reason) === BOUNCED_AT_FLOOR
        ? solRow('withdraw', 'Junior tranche · withdrawal bounced at the floor', null)
        : null;
    case 'AdvanceOpened':
      return solRow('advance', `${validatorName(data, names)} · drew credit`, sol(data.principal));
    case 'AdvanceRepaid':
      return solRow('advance', `${validatorName(data, names)} · advance repaid`, null);
    case 'AdvanceDefaulted':
      return solRow('advance', `${validatorName(data, names)} · defaulted, bond applied`, sol(data.bondApplied));
    case 'ValidatorOnboarded':
      return solRow('advance', `${validatorName(data, names)} · onboarded`, null);
    case 'IndexProposed':
      return indexRow(data, 'proposed');
    case 'IndexFinalized':
      return indexRow(data, 'final');
    case 'IndexVetoed':
      return indexRow(data, 'vetoed');
    case 'SwapOpened':
      return solRow(
        'swap',
        `${data.side === 'payFixed' ? 'Pay fixed' : 'Receive fixed'} · epoch ${data.epoch}`,
        sol(data.notional),
      );
    case 'SwapSettled':
      // The taker's profit (+) or loss (−).
      return solRow('swap', `Swap settled · epoch ${data.epoch}`, sol(data.takerPnl));
    default:
      return null;
  }
}

/** A Predict call (points, no transaction) as an activity row: "<market label> · YES". */
export function predictCallToActivityEvent(call: PredictCallEvent): ActivityEvent {
  return {
    id: `predict:${call.id}`,
    kind: 'predict',
    text: `${call.label} · ${call.side === 'no' ? 'NO' : 'YES'}`,
    amountSol: null,
    value: call.points,
    unit: 'points',
    signature: null,
  };
}
