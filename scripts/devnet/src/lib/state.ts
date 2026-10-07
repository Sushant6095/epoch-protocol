/**
 * Resumable step state, keyed to the cluster's genesis hash and the program id. A re-run skips completed steps; state
 * from another ledger (a reset local validator, another cluster) or another program is moved aside, never reused.
 *
 * Idea from the localnet harness (seed-state.json) and stakenet's keeper, which re-derives what to do from chain state
 * every loop: steps here also check their on-chain effect before sending, so a crash between "sent" and "recorded"
 * never sends twice.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface StepRecord {
  /** ISO time the step completed. */
  at: string;
  epoch?: number;
  slot?: number;
  signature?: string;
  signatures?: string[];
  [key: string]: unknown;
}

export interface KitState {
  version: 1;
  command: string;
  cluster: string;
  genesisHash: string;
  programId: string;
  startedAt: string;
  steps: Record<string, StepRecord>;
  data: Record<string, unknown>;
}

export function stateFile(dir: string, command: string, genesisHash: string): string {
  return path.join(dir, `${command}-${genesisHash.slice(0, 8)}.json`);
}

export class StateStore {
  readonly file: string;
  readonly state: KitState;
  /** Set when an older state file was moved aside. */
  readonly movedAside: string | null;

  constructor(dir: string, command: string, cluster: string, genesisHash: string, programId: string) {
    this.file = stateFile(dir, command, genesisHash);
    let moved: string | null = null;
    let state: KitState | null = null;
    if (fs.existsSync(this.file)) {
      const old = JSON.parse(fs.readFileSync(this.file, 'utf8')) as KitState;
      if (old.genesisHash === genesisHash && old.programId === programId && old.command === command) {
        state = old;
      } else {
        moved = `${this.file}.${Date.now()}.stale`;
        fs.renameSync(this.file, moved);
      }
    }
    this.movedAside = moved;
    this.state = state ?? {
      version: 1,
      command,
      cluster,
      genesisHash,
      programId,
      startedAt: new Date().toISOString(),
      steps: {},
      data: {},
    };
  }

  done(id: string): StepRecord | undefined {
    return this.state.steps[id];
  }

  record(id: string, result: Partial<StepRecord> = {}): StepRecord {
    const rec: StepRecord = { at: new Date().toISOString(), ...result };
    this.state.steps[id] = rec;
    this.save();
    return rec;
  }

  /** Run `fn` unless step `id` is recorded; record what it returns. */
  async step(id: string, fn: () => Promise<Partial<StepRecord> | void>): Promise<StepRecord> {
    const prior = this.done(id);
    if (prior) return prior;
    return this.record(id, (await fn()) ?? {});
  }

  setData(key: string, value: unknown): void {
    this.state.data[key] = value;
    this.save();
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }
}
