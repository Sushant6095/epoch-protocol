import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import { type RpcBlock } from '../Rpc/SolanaRpc';

/** What an independent Python script computed for each block from the node's JSON view (see the file's `reference`). */
export interface FeeBlockReference {
  base: number;
  priority: number;
  tips: number;
  /** The tip accounts' positive balance deltas: equal to `tips` on every recorded block. */
  tipsByBalance: number;
  tipTxs: number;
  votes: number;
  nonVote: number;
  voteBase: number;
  failed: number;
  precompileSigs: number;
  txs: number;
  reward: number | null;
  rewardPubkey: string | null;
}

export interface RecordedFeeBlock {
  slot: number;
  block: RpcBlock;
  reference: FeeBlockReference;
}

export interface RecordedFeeBlocks {
  source: string;
  trimmed: string;
  reference: string;
  blocks: RecordedFeeBlock[];
}

let cached: RecordedFeeBlocks | undefined;

/** Two complete mainnet blocks (epoch 1051, every transaction, votes included), gzipped; read once per test file. */
export function recordedFeeBlocks(): RecordedFeeBlocks {
  cached ??= JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'mainnet-fee-blocks.json.gz'))).toString('utf8'),
  ) as RecordedFeeBlocks;
  return cached;
}
