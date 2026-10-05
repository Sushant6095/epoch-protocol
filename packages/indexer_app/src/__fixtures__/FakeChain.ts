import { type GrpcEndpoint, type SubscribeContext, type SubscribeRequest, type SubscribeUpdate } from '@epoch/solana';

import { blockFees, type BlockFeesResult } from '../Blocks/BlockFees';
import { decodeRpcBlock } from '../Blocks/RpcBlockDecoder';
import { RpcError, type RpcBlock } from '../Rpc/SolanaRpc';
import { type GrpcStreamLike, type IndexerRpc } from '../Streams/SlotStream';
import { type RecordedBlock, recordedBlocks } from './mainnetBlocks';
import { grpcUpdatesFor, slotStatusUpdate } from './yellowstone';

/** Real (mainnet) leader identities, reused as the fake chain's leaders. */
export const LEADERS = [
  '5Us18hLZPXJTS4QVuGSsUw137Dyd2tgBaem24Xsf5nBS',
  'A1vqhA2fS6K7CvHsJKX1ACcHJFEmyRg4KuR5pctHANy4',
  'GnC339vkyXRm1jRX69dt9mapPPu2LbzXfSDoxc91qta6',
  '8NpDWRcKHkBjn8mbHMYgDm2Z2DRvXXuDiSScPsGSdSgr',
];

/**
 * A small chain for the stream's orchestration tests: short epochs, a leader per 4 slots, some skipped slots, and
 * block contents taken from the recorded mainnet blocks (so every block decodes like the real thing).
 */
export class FakeChain {
  tip: number;
  readonly calls = { getBlock: [] as number[], getSlotLeaders: 0, getVoteAccounts: 0 };
  readonly stakes: Record<string, number> = {
    [LEADERS[0]]: 4_000_000_000_000_000,
    [LEADERS[1]]: 3_000_000_000_000_000,
    [LEADERS[2]]: 2_000_000_000_000_000,
    [LEADERS[3]]: 1_000_000_000_000_000,
  };

  constructor(
    readonly slotsPerEpoch = 32,
    readonly isSkipped: (slot: number) => boolean = (slot) => slot % 10 === 7,
    tip = 0,
  ) {
    this.tip = tip;
  }

  leaderOf(slot: number): string {
    return LEADERS[Math.floor(slot / 4) % LEADERS.length];
  }

  parentOf(slot: number): number {
    let parent = slot - 1;
    while (parent > 0 && this.isSkipped(parent)) parent--;
    return parent;
  }

  /** The recorded block reused for `slot`, re-slotted, with this chain's leader in its Fee reward. */
  recordedFor(slot: number): RecordedBlock {
    const samples = recordedBlocks().blocks.filter((b) => !b.complete);
    const base = samples[slot % samples.length];
    const block: RpcBlock = {
      ...base.block,
      parentSlot: this.parentOf(slot),
      blockTime: 1_791_000_000 + Math.floor(slot * 0.4),
      rewards: [{ pubkey: this.leaderOf(slot), lamports: 1_000, rewardType: 'Fee' }],
    };
    return { ...base, slot, leader: this.leaderOf(slot), block };
  }

  blockFor(slot: number): RpcBlock | null {
    return this.isSkipped(slot) ? null : this.recordedFor(slot).block;
  }

  /** What the indexer should compute for `slot` (null when skipped). */
  expectedFees(slot: number): BlockFeesResult | null {
    const block = this.blockFor(slot);
    return block ? blockFees(slot, this.leaderOf(slot), decodeRpcBlock(slot, block).txs) : null;
  }

  /** Firehose updates for a slot: slot statuses, its transactions, then its block meta. */
  firehose(slot: number): SubscribeUpdate[] {
    if (this.isSkipped(slot)) return [slotStatusUpdate(slot, 0)];
    return [slotStatusUpdate(slot, 0), ...grpcUpdatesFor(this.recordedFor(slot))];
  }

  /** Meta-only updates (hybrid). */
  meta(slot: number): SubscribeUpdate[] {
    return this.firehose(slot).filter((u) => !u.transaction);
  }

  readonly rpc: IndexerRpc = {
    host: 'fake-rpc',
    getSlot: async () => this.tip,
    getEpochSchedule: async () => ({ slotsPerEpoch: this.slotsPerEpoch, firstNormalEpoch: 0, firstNormalSlot: 0 }),
    getEpochInfo: async () => ({
      epoch: Math.floor(this.tip / this.slotsPerEpoch),
      slotIndex: this.tip % this.slotsPerEpoch,
      slotsInEpoch: this.slotsPerEpoch,
      absoluteSlot: this.tip,
    }),
    getBlock: async (slot: number) => {
      this.calls.getBlock.push(slot);
      if (slot > this.tip) throw new RpcError(-32004, `Block not available for slot ${slot}`);
      if (this.isSkipped(slot)) throw new RpcError(-32007, `Slot ${slot} was skipped`);
      return this.blockFor(slot);
    },
    getSlotLeaders: async (start: number, limit: number) => {
      this.calls.getSlotLeaders++;
      return Array.from({ length: limit }, (_, i) => this.leaderOf(start + i));
    },
    getVoteAccounts: async () => {
      this.calls.getVoteAccounts++;
      return {
        current: LEADERS.map((identity, i) => ({
          votePubkey: `vote${i}`,
          nodePubkey: identity,
          activatedStake: this.stakes[identity],
        })),
        delinquent: [],
      };
    },
  } as IndexerRpc;
}

/** A stand-in for GrpcStream: builds the request once, plays a script, then waits for stop(). */
export class FakeGrpcStream implements GrpcStreamLike {
  readonly requests: SubscribeRequest[] = [];
  private stopResolve?: () => void;
  private readonly stopped = new Promise<void>((resolve) => {
    this.stopResolve = resolve;
  });

  constructor(
    private readonly script: (request: SubscribeRequest, push: (u: SubscribeUpdate) => Promise<void>) => Promise<void>,
    private readonly firstAvailableSlot?: number,
  ) {}

  async run(
    build: (context: SubscribeContext) => SubscribeRequest,
    onUpdate: (update: SubscribeUpdate) => Promise<void> | void,
  ): Promise<void> {
    const endpoint: GrpcEndpoint = { name: 'solami', url: 'https://grpc.solami.dev', token: 'x' };
    const request = build({ endpoint, firstAvailableSlot: this.firstAvailableSlot, attempt: 0 });
    this.requests.push(request);
    await this.script(request, async (update) => onUpdate(update));
    await this.stopped;
  }

  stop(): void {
    this.stopResolve?.();
  }
}

/** Polls until `check` passes (or fails the test after `timeoutMs`). */
export async function waitFor(check: () => boolean, timeoutMs = 8_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
