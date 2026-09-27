import { sleep } from '@epoch/common';
import { Logger } from '@epoch/logger';

import { type ConnectionManager } from './ConnectionManager';

export interface EpochSnapshot {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
  progress: number;
}

const logger = Logger.create('EpochClock');

export class EpochClock {
  constructor(private readonly connections: ConnectionManager) {}

  async now(): Promise<EpochSnapshot> {
    const info = await this.connections.withFailover((c) => c.getEpochInfo());
    return {
      epoch: info.epoch,
      slotIndex: info.slotIndex,
      slotsInEpoch: info.slotsInEpoch,
      absoluteSlot: info.absoluteSlot,
      progress: info.slotIndex / info.slotsInEpoch,
    };
  }

  /** Polls the cluster and calls `onNewEpoch(epoch)` once per epoch change. Returns a stop function. */
  watch(onNewEpoch: (epoch: number) => Promise<void>, pollMs = 30_000): () => void {
    let stopped = false;
    let lastEpoch: number | undefined;
    const loop = async () => {
      while (!stopped) {
        try {
          const { epoch } = await this.now();
          if (lastEpoch !== undefined && epoch > lastEpoch) await onNewEpoch(epoch);
          lastEpoch = epoch;
        } catch (error) {
          logger.error('epoch poll failed', error);
        }
        await sleep(pollMs);
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }
}
