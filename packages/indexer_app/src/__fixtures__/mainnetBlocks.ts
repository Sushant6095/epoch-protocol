import fs from 'fs';
import path from 'path';

import { type RpcBlock } from '../Rpc/SolanaRpc';

/** What the independent Python decoder computed for each trimmed block (see mainnet-blocks.json `reference`). */
export interface BlockReference {
  simpleVotes: number;
  nonVote: number;
  priced: number;
  unpriced: number;
  leaderPaid: number;
  failedPriced: number;
  medianCuPrice: number | null;
  p25CuPrice: number | null;
  p75CuPrice: number | null;
  p90CuPrice: number | null;
  classes: Record<string, number>;
  samples: { index: number; feePayer: string; cuPrice: number | null; version: 'legacy' | 0 | 1; failed: boolean }[];
}

export interface RecordedBlock {
  slot: number;
  leader: string;
  /** Every non-vote transaction of the real block is present (the others are samples). */
  complete: boolean;
  /** Real priced transactions whose fee payer was re-keyed to the leader (the leader-paid exclusion). */
  syntheticIndexes: number[];
  transactionsInBlock: number;
  nonVoteInBlock: number;
  block: RpcBlock;
  reference: BlockReference;
}

export interface RecordedBlocks {
  source: string;
  trimmed: string;
  reference: string;
  blocks: RecordedBlock[];
}

let cached: RecordedBlocks | undefined;

/** Real mainnet blocks (epoch 1048), trimmed; read once per test file. */
export function recordedBlocks(): RecordedBlocks {
  cached ??= JSON.parse(fs.readFileSync(path.join(__dirname, 'mainnet-blocks.json'), 'utf8')) as RecordedBlocks;
  return cached;
}

export const MAINNET_EPOCH_OF = (slot: number): number => Math.floor(slot / 432_000);
