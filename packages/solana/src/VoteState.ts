import { bytesToAddress } from './pubkeys';

/**
 * Reads a vote account (the vote program's bincode `VoteStateVersions`) far enough for the scorer and the operator
 * tools: identity, withdraw authority, commission, pending delegator rewards and the epoch-credits history.
 *
 * Layout from `solana-vote-interface` 7.1 (`vote_state_deserialize.rs`), pinned by tests against bytes produced by
 * that crate's own serializer:
 *
 * ```text
 * u32 version                        1 = V1_14_11, 2 = V3, 3 = V4 (0 = uninitialized)
 * [u8;32] node_pubkey, [u8;32] authorized_withdrawer
 * V4:  [u8;32] inflation_rewards_collector, [u8;32] block_revenue_collector,
 *      u16 inflation_rewards_commission_bps, u16 block_revenue_commission_bps, u64 pending_delegator_rewards,
 *      Option<[u8;48]> bls_pubkey_compressed
 * V3 / V1_14_11: u8 commission (percent)
 * votes: u64 n × (V3/V4: u8 latency + u64 slot + u32 confirmations; V1_14_11: u64 slot + u32 confirmations)
 * root_slot: Option<u64>
 * authorized_voters: u64 n × (u64 epoch + [u8;32] voter)
 * prior_voters (V3 / V1_14_11 only): 32 × ([u8;32] + u64 + u64) + u64 idx + bool is_empty
 * epoch_credits: u64 n × (u64 epoch, u64 credits, u64 prev_credits)
 * last_timestamp: u64 slot, i64 timestamp
 * ```
 */
export type VoteStateVersion = 'v1_14_11' | 'v3' | 'v4';

export interface EpochCredits {
  epoch: bigint;
  /** Cumulative credits at the end of `epoch`. */
  credits: bigint;
  /** Cumulative credits at the start of `epoch`; `credits - prevCredits` were earned in it. */
  prevCredits: bigint;
}

export interface VoteState {
  version: VoteStateVersion;
  nodePubkey: string;
  authorizedWithdrawer: string;
  /** V4 only (SIMD-0232); before V4 the runtime pays inflation commission to the vote account itself. */
  inflationRewardsCollector: string | null;
  /** V4 only; before V4 block revenue goes to the identity. */
  blockRevenueCollector: string | null;
  inflationRewardsCommissionBps: number;
  /** 10,000 before V4 (the validator kept all block revenue). */
  blockRevenueCommissionBps: number;
  /** Lamports in the vote account that belong to delegators (SIMD-0123); 0 before V4. */
  pendingDelegatorRewards: bigint;
  rootSlot: bigint | null;
  /** Oldest first, at most 64 entries (MAX_EPOCH_CREDITS_HISTORY). */
  epochCredits: EpochCredits[];
  lastTimestamp: { slot: bigint; timestamp: bigint };
}

const VERSIONS: Record<number, VoteStateVersion> = { 1: 'v1_14_11', 2: 'v3', 3: 'v4' };
/** 32 prior voters × (pubkey + two u64) + u64 idx + bool is_empty. */
const PRIOR_VOTERS_SIZE = 32 * (32 + 8 + 8) + 8 + 1;
const BLS_PUBKEY_COMPRESSED_SIZE = 48;

class Cursor {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private take(size: number, what: string): number {
    if (size < 0 || this.offset + size > this.data.length) {
      throw new RangeError(`vote state truncated reading ${what} at byte ${this.offset}`);
    }
    const at = this.offset;
    this.offset += size;
    return at;
  }

  u8(what: string): number {
    return this.view.getUint8(this.take(1, what));
  }
  u16(what: string): number {
    return this.view.getUint16(this.take(2, what), true);
  }
  u32(what: string): number {
    return this.view.getUint32(this.take(4, what), true);
  }
  u64(what: string): bigint {
    return this.view.getBigUint64(this.take(8, what), true);
  }
  i64(what: string): bigint {
    return this.view.getBigInt64(this.take(8, what), true);
  }
  pubkey(what: string): string {
    const at = this.take(32, what);
    return bytesToAddress(this.data.subarray(at, at + 32));
  }
  skip(size: number, what: string): void {
    this.take(size, what);
  }
  optionTag(what: string): boolean {
    const tag = this.u8(what);
    if (tag > 1) throw new RangeError(`invalid Option tag ${tag} for ${what}`);
    return tag === 1;
  }
  /** A bincode length prefix, checked against the bytes left so a corrupt length cannot loop for ever. */
  length(itemSize: number, what: string): number {
    const n = this.u64(what);
    const left = BigInt(this.data.length - this.offset);
    if (n * BigInt(itemSize) > left) throw new RangeError(`vote state ${what} length ${n} exceeds the data`);
    return Number(n);
  }
}

/** Parse a vote account's data. Throws on an uninitialized, unsupported or truncated account. */
export function parseVoteState(data: Uint8Array): VoteState {
  const r = new Cursor(data);
  const tag = r.u32('version');
  const version = VERSIONS[tag];
  if (!version) throw new RangeError(`unsupported vote state version ${tag}`);
  const nodePubkey = r.pubkey('node_pubkey');
  const authorizedWithdrawer = r.pubkey('authorized_withdrawer');

  let inflationRewardsCollector: string | null = null;
  let blockRevenueCollector: string | null = null;
  let inflationRewardsCommissionBps: number;
  let blockRevenueCommissionBps = 10_000;
  let pendingDelegatorRewards = 0n;
  if (version === 'v4') {
    inflationRewardsCollector = r.pubkey('inflation_rewards_collector');
    blockRevenueCollector = r.pubkey('block_revenue_collector');
    inflationRewardsCommissionBps = r.u16('inflation_rewards_commission_bps');
    blockRevenueCommissionBps = r.u16('block_revenue_commission_bps');
    pendingDelegatorRewards = r.u64('pending_delegator_rewards');
    if (r.optionTag('bls_pubkey_compressed')) r.skip(BLS_PUBKEY_COMPRESSED_SIZE, 'bls_pubkey_compressed');
  } else {
    inflationRewardsCommissionBps = r.u8('commission') * 100;
  }

  const voteSize = version === 'v1_14_11' ? 8 + 4 : 1 + 8 + 4;
  r.skip(r.length(voteSize, 'votes') * voteSize, 'votes');
  const rootSlot = r.optionTag('root_slot') ? r.u64('root_slot') : null;
  r.skip(r.length(8 + 32, 'authorized_voters') * (8 + 32), 'authorized_voters');
  if (version !== 'v4') r.skip(PRIOR_VOTERS_SIZE, 'prior_voters');

  const count = r.length(24, 'epoch_credits');
  const epochCredits: EpochCredits[] = [];
  for (let i = 0; i < count; i++) {
    epochCredits.push({ epoch: r.u64('epoch'), credits: r.u64('credits'), prevCredits: r.u64('prev_credits') });
  }
  const lastTimestamp = { slot: r.u64('last_timestamp.slot'), timestamp: r.i64('last_timestamp.timestamp') };

  return {
    version,
    nodePubkey,
    authorizedWithdrawer,
    inflationRewardsCollector,
    blockRevenueCollector,
    inflationRewardsCommissionBps,
    blockRevenueCommissionBps,
    pendingDelegatorRewards,
    rootSlot,
    epochCredits,
    lastTimestamp,
  };
}

/** Credits the vote account earned in `epoch` (0 when it has no entry for it). */
export function creditsEarnedIn(state: Pick<VoteState, 'epochCredits'>, epoch: bigint): bigint {
  const entry = state.epochCredits.find((e) => e.epoch === epoch);
  return entry ? entry.credits - entry.prevCredits : 0n;
}
