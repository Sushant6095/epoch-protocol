import { ServiceUnavailableException } from '@epoch/exceptions';

import { type PredictCallEvent, type StoredProgramEvent } from '../../Lib/EventBus';
import { isoIst } from '../../Lib/Stats';
import { type ActivityEvent, type ActivityFeed } from '../../types/Activity.types';
import { type ProgramEventStore } from '../Program/ProgramEventStore';
import { ACTIVITY_EVENT_NAMES, predictCallToActivityEvent, RepeatFilter, toActivityEvent } from './ActivityMapper';
import { type PredictCallSource } from './PredictCallSource';
import { type NameIndex } from './ValidatorNames';

export interface ActivityServiceDeps {
  /** The Epoch program (EpochProgramSource): events are shown only when EPOCH_PROGRAM_ID is set. */
  program: { readonly configured: boolean; readonly cluster: string };
  events: Pick<ProgramEventStore, 'query'>;
  /** Predict calls from Postgres; null without DATABASE_URL. */
  predict: PredictCallSource | null;
  names: () => Promise<NameIndex>;
}

const ACTIVITY_NAMES = new Set<string>(ACTIVITY_EVENT_NAMES);

interface Timed {
  event: ActivityEvent;
  /** Sort key, epoch ms. */
  at: number;
}

/**
 * The Terminal's live activity: program events (sweeps, deposits, withdrawals, advances, index, swaps) mapped to
 * rows, merged with Predict calls, newest first. The same mapping feeds the websocket's `activity` channel.
 */
export class ActivityService {
  /** The websocket's keeper-repeat filter: live events arrive oldest first. */
  private readonly live = new RepeatFilter();

  constructor(private readonly deps: ActivityServiceDeps) {}

  /** True when there is anything to show: the program or the Predict database. */
  get available(): boolean {
    return this.deps.program.configured || this.deps.predict !== null;
  }

  /** GET /v1/activity: the newest `limit` rows; 503 PROGRAM_NOT_CONFIGURED without the program and the database. */
  async feed(limit: number): Promise<ActivityFeed> {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'Activity needs the Epoch program (EPOCH_PROGRAM_ID) or Postgres (DATABASE_URL); this API has neither',
        'PROGRAM_NOT_CONFIGURED',
        { cluster: this.deps.program.cluster },
      );
    }
    const [program, predict] = await Promise.all([this.programRows(limit), this.predictRows(limit)]);
    // Array.prototype.sort is stable: equal times keep program order (slot, ix descending) before calls.
    const events = [...program, ...predict]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((row) => row.event);
    return { schemaVersion: 1, kind: 'real', asOf: isoIst(), source: this.source(), events };
  }

  /** One program event as a row (null when the feed doesn't show it), for the websocket. */
  async fromProgramEvent(event: StoredProgramEvent): Promise<ActivityEvent | null> {
    if (!ACTIVITY_NAMES.has(event.name) || !this.live.isNews(event)) return null;
    return toActivityEvent(event, await this.deps.names());
  }

  fromPredictCall(call: PredictCallEvent): ActivityEvent {
    return predictCallToActivityEvent(call);
  }

  private source(): string {
    const program = `Epoch program events (${this.deps.program.cluster})`;
    if (this.deps.program.configured && this.deps.predict) return `${program} and Predict calls`;
    return this.deps.program.configured ? program : 'Predict calls (the Epoch program is not configured on this API)';
  }

  private async programRows(limit: number): Promise<Timed[]> {
    if (!this.deps.program.configured) return [];
    // Some events map to nothing (an owner's own withdrawal cancel): read a margin beyond `limit`.
    const [stored, names] = await Promise.all([
      this.deps.events.query({ names: ACTIVITY_EVENT_NAMES, limit: Math.min(10_000, limit * 2 + 20) }),
      this.deps.names(),
    ]);
    // Keeper repeats are judged oldest first (the oldest in the window always shows).
    const repeats = new RepeatFilter();
    const news = new Set([...stored].reverse().filter((event) => repeats.isNews(event)));
    const rows: Timed[] = [];
    // Newest first. An event without a block time sorts with the newer event before it.
    let at = Number.MAX_SAFE_INTEGER;
    for (const event of stored) {
      if (event.blockTime) at = Date.parse(event.blockTime);
      if (!news.has(event)) continue;
      const row = toActivityEvent(event, names);
      if (row) rows.push({ event: row, at });
    }
    return rows;
  }

  private async predictRows(limit: number): Promise<Timed[]> {
    if (!this.deps.predict) return [];
    const calls = await this.deps.predict.recent(limit);
    return calls.map((call) => ({ event: predictCallToActivityEvent(call), at: Date.parse(call.createdAt) }));
  }
}
