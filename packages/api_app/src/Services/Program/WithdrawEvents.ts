import { type StoredProgramEvent } from '../../Lib/EventBus';
import { payload } from './ProgramFormat';
import { type EventReader } from './ProgramSources';

/** Most per-request lookups one call makes after the bulk read (each is one indexed query). */
const MAX_SINGLE_LOOKUPS = 50;

/**
 * The `WithdrawRequested` event of each request `seq` (decimal strings), for its signature and the epoch it was
 * asked in: one bulk read of the newest requests, then one query per seq still missing. `where` narrows both (the
 * pool, an owner).
 */
export async function requestEventsBySeq(
  events: EventReader,
  seqs: readonly string[],
  where: Record<string, string> = {},
): Promise<Map<string, StoredProgramEvent>> {
  const wanted = new Set(seqs);
  const found = new Map<string, StoredProgramEvent>();
  if (wanted.size === 0) return found;
  for (const event of await events.query({ names: ['WithdrawRequested'], where, limit: 2_000 })) {
    const seq = String(payload(event, 'WithdrawRequested').seq);
    if (wanted.has(seq) && !found.has(seq)) found.set(seq, event);
  }
  const missing = [...wanted].filter((seq) => !found.has(seq)).slice(0, MAX_SINGLE_LOOKUPS);
  const lookups = await Promise.all(
    missing.map((seq) => events.query({ names: ['WithdrawRequested'], where: { ...where, seq }, limit: 1 })),
  );
  lookups.forEach((list, index) => {
    if (list[0]) found.set(missing[index], list[0]);
  });
  return found;
}
