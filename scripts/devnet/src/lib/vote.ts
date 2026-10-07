/**
 * The vote program's public account layout and the one direct vote instruction the kit sends (`UpdateCommission`,
 * for CP1's controls). Everything else goes through the Epoch program's CPIs.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

import { KitError } from './errors';

export const VOTE_PROGRAM_ID = new PublicKey('Vote111111111111111111111111111111111111111');

/** `VoteStateVersions` tag of VoteStateV4 (SIMD-0185); 2 is V3 (`CurrentV3`). */
export const VOTE_STATE_V4 = 3;

export interface VoteHeader {
  version: number;
  nodePubkey: PublicKey;
  authorizedWithdrawer: PublicKey;
  /** V4 only (SIMD-0232); null on V3. */
  inflationRewardsCollector: PublicKey | null;
  blockRevenueCollector: PublicKey | null;
  inflationRewardsCommissionBps: number;
  blockRevenueCommissionBps: number;
}

export function parseVoteHeader(data: Uint8Array): VoteHeader {
  if (data.length < 136) throw new KitError('CHECK_FAILED', `not a vote account (${data.length} bytes)`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint32(0, true);
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  if (version === VOTE_STATE_V4) {
    return {
      version,
      nodePubkey: key(4),
      authorizedWithdrawer: key(36),
      inflationRewardsCollector: key(68),
      blockRevenueCollector: key(100),
      inflationRewardsCommissionBps: view.getUint16(132, true),
      blockRevenueCommissionBps: view.getUint16(134, true),
    };
  }
  return {
    version,
    nodePubkey: key(4),
    authorizedWithdrawer: key(36),
    inflationRewardsCollector: null,
    blockRevenueCollector: null,
    inflationRewardsCommissionBps: data[68] * 100,
    blockRevenueCommissionBps: 10_000,
  };
}

/** Vote program `UpdateCommission(u8)` (instruction 5): accounts [vote (writable), withdraw authority (signer)]. */
export function voteUpdateCommission(vote: PublicKey, withdrawer: PublicKey, percent: number): TransactionInstruction {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RangeError('commission is 0–100 percent');
  const data = Buffer.alloc(5);
  data.writeUInt32LE(5, 0);
  data.writeUInt8(percent, 4);
  return new TransactionInstruction({
    programId: VOTE_PROGRAM_ID,
    keys: [
      { pubkey: vote, isSigner: false, isWritable: true },
      { pubkey: withdrawer, isSigner: true, isWritable: false },
    ],
    data,
  });
}
