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
  // Revenue tokens (ADR 0006): kind "buyback".
  'RevenueTokenRegistered',
  'RevenueShareSwept',
  'BuybackExecuted',
  'RevenueTokenPoolSynced',
  'RevenueTokenRedeemed',
  'RevenueTokenClosed',
  // Epoch's partner treasury claiming its Meteora fees for lenders (kind "buyback": the revenue-token family).
  'TreasuryClaimed',
  // Validator history and the permissionless score (P1): kind "score".
  'HistoryInitialized',
  'VoteAccountCopied',
  'TipDistributionCopied',
  'PriorityFeeDistributionCopied',
  'StakeInfoUpdated',
  'ScoreRefreshed',
  'ScoringConfigured',
];

/**
 * What makes a repeat of a keeper event no news: HistoryJob copies the vote account and refreshes every score on each
 * pass (every 30 minutes), so the feed shows a validator's first copy of an epoch and a refresh only when its score
 * or a flag changed.
 */
const repeatKey = (stored: StoredProgramEvent): string | null => {
  const { data } = stored;
  switch (stored.name) {
    case 'VoteAccountCopied':
      return `epoch ${data.epoch}`;
    case 'ScoreRefreshed':
      return [data.score, data.delinquent, data.superminority, data.hedged].join(':');
    default:
      return null;
  }
};

/** Drops keeper repeats (see `repeatKey`); feed it events oldest first. Every other event is news. */
export class RepeatFilter {
  private readonly last = new Map<string, string>();

  isNews(stored: StoredProgramEvent): boolean {
    const key = repeatKey(stored);
    if (key === null) return true;
    const slot = `${stored.name}:${String(stored.data.vote ?? '')}`;
    if (this.last.get(slot) === key) return false;
    this.last.set(slot, key);
    return true;
  }
}

/** `TreasuryClaimed.kind` in the feed's words. */
const TREASURY_CLAIM_TEXT: Record<string, string> = {
  tradingFee: 'curve trading fees to lenders',
  surplus: 'curve surplus to lenders',
  migrationFee: 'migration fee to lenders',
  leftover: 'unsold supply burned',
  lpFee: 'DAMM v2 LP fees to lenders',
};

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

/** bps (number or decimal string) → "12.5%". */
const pctText = (value: Data[string] | undefined): string => `${(num(value) ?? 0) / 100}%`;

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
  if (!row) return null;
  const event: ActivityEvent = { id: `${stored.signature}:${stored.ix}`, ...row, signature: stored.signature };
  if (row.kind === 'buyback') {
    const mint = stored.data.mint;
    event.mint = typeof mint === 'string' && mint.length > 0 ? mint : null;
  }
  return event;
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
    case 'RevenueTokenRegistered': {
      const pct = (num(data.shareBps) ?? 0) / 100;
      return solRow(
        'buyback',
        `${validatorName(data, names)} · revenue token: ${pct}% of revenue for ${data.termEpochs} epochs`,
        null,
      );
    }
    case 'RevenueShareSwept':
      return solRow('buyback', `${validatorName(data, names)} · revenue share to the buyback escrow`, sol(data.share));
    case 'BuybackExecuted':
      return solRow(
        'buyback',
        `${validatorName(data, names)} · bought back and burned on ${data.venue === 'dammV2' ? 'DAMM v2' : 'the curve'}`,
        sol(data.lamportsIn),
      );
    case 'RevenueTokenPoolSynced':
      return solRow('buyback', `${validatorName(data, names)} · revenue token graduated to DAMM v2`, null);
    case 'RevenueTokenRedeemed':
      return solRow('buyback', `${validatorName(data, names)} · revenue token redeemed`, sol(data.lamportsOut));
    case 'RevenueTokenClosed':
      return solRow('buyback', `${validatorName(data, names)} · revenue token term closed`, null);
    case 'TreasuryClaimed': {
      const what = TREASURY_CLAIM_TEXT[String(data.kind)] ?? 'claimed';
      const burned = data.kind !== 'leftover' && (num(data.tokensBurned) ?? 0) > 0 ? ', tokens burned' : '';
      const lamports = num(data.lamportsToPool) ?? 0;
      return solRow(
        'buyback',
        `${shortKey(String(data.mint ?? ''))} · treasury: ${what}${burned}`,
        lamports > 0 ? lamports / LAMPORTS_PER_SOL : null,
      );
    }
    case 'HistoryInitialized':
      return solRow('score', `${validatorName(data, names)} · on-chain history opened`, null);
    case 'VoteAccountCopied':
      return solRow('score', `${validatorName(data, names)} · vote account copied on chain`, null);
    case 'TipDistributionCopied':
      // Not found: no Jito account for the epoch (devnet, or not created yet), nothing was written.
      if (data.found !== true) return null;
      return solRow(
        'score',
        `${validatorName(data, names)} · Jito tips copied: ${pctText(data.mevCommissionBps)} MEV commission`,
        sol(data.mevEarnedLamports),
      );
    case 'PriorityFeeDistributionCopied':
      if (data.found !== true) return null;
      return solRow(
        'score',
        `${validatorName(data, names)} · Jito priority fees copied: ${pctText(data.priorityFeeCommissionBps)} commission`,
        sol(data.priorityFeesLamports),
      );
    case 'StakeInfoUpdated':
      return solRow(
        'score',
        `${validatorName(data, names)} · stake rank #${data.rank}${data.superminority === true ? ', superminority' : ''} posted by the scorer`,
        null,
      );
    case 'ScoreRefreshed': {
      const flags = [
        data.delinquent === true ? 'delinquent' : null,
        data.superminority === true ? 'superminority' : null,
        data.hedged === true ? 'hedged' : null,
      ].filter((flag) => flag !== null);
      const score = Math.round((num(data.score) ?? 0) / 100);
      return solRow(
        'score',
        `${validatorName(data, names)} · score ${score} from on-chain history${flags.length ? ` (${flags.join(', ')})` : ''}`,
        null,
      );
    }
    case 'ScoringConfigured':
      return solRow(
        'score',
        `Scoring settings: ${data.creditsWindowEpochs}-epoch credit window, cluster average at ${pctText(data.creditsReferenceBps)} of the maximum`,
        null,
      );
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
