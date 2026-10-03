import { type JsonRpcClient } from '../Lib/Http';
import { bytesToAddress } from '@epoch/solana';

import {
  parseStakeAccount,
  parseStakeHistory,
  parseStakeSlice,
  STAKE_ACCOUNT_SIZE,
  STAKE_HISTORY_SYSVAR,
  STAKE_PROGRAM_ID,
  STAKE_SLICE,
  STAKER_OFFSET,
  type DelegatedStake,
  type StakeAccountInfo,
  type StakeHistoryEntry,
  VOTER_OFFSET,
  WITHDRAWER_OFFSET,
} from '../Lib/StakeLayouts';

export interface EpochInfo {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
}

export interface VoteAccount {
  votePubkey: string;
  nodePubkey: string;
  activatedStake: number;
  commission: number;
  /** New with SIMD-0232; absent on older RPC nodes. */
  inflationRewardsCommissionBps?: number;
  epochVoteAccount: boolean;
  /** [epoch, credits, previousCredits], oldest first, up to five epochs. */
  epochCredits: [number, number, number][];
  lastVote: number;
}

export interface VoteAccounts {
  current: VoteAccount[];
  delinquent: VoteAccount[];
}

export interface PerformanceSample {
  slot: number;
  numSlots: number;
  numTransactions: number;
  numNonVoteTransactions?: number;
  samplePeriodSecs: number;
}

export interface ClusterNode {
  pubkey: string;
  version: string | null;
  /** e.g. `Agave`, `AgaveBam`, `JitoLabs`, `Firedancer`, `Frankendancer`. */
  clientId?: string;
}

export interface BlockProduction {
  /** identity → [leader slots, blocks produced] in the current epoch so far. */
  byIdentity: Record<string, [number, number]>;
  range: { firstSlot: number; lastSlot: number };
}

export interface InflationRate {
  total: number;
  validator: number;
  foundation: number;
  epoch: number;
}

interface RpcContext<T> {
  context: { slot: number };
  value: T;
}

/** Mainnet reads the API needs, over plain JSON-RPC. */
/** getInflationReward: one entry per address, null when the address earned nothing that epoch. */
export interface InflationReward {
  epoch: number;
  effectiveSlot: number;
  amount: number;
  postBalance: number;
  /** Vote accounts only: the commission when the reward was paid. */
  commission?: number | null;
}

export class SolanaDataSource {
  constructor(private readonly rpc: JsonRpcClient) {}

  getEpochInfo(): Promise<EpochInfo> {
    return this.rpc.call<EpochInfo>('getEpochInfo', [{ commitment: 'confirmed' }]);
  }

  getVoteAccounts(): Promise<VoteAccounts> {
    return this.rpc.call<VoteAccounts>('getVoteAccounts', [{ commitment: 'confirmed' }]);
  }

  getRecentPerformanceSamples(limit = 60): Promise<PerformanceSample[]> {
    return this.rpc.call<PerformanceSample[]>('getRecentPerformanceSamples', [limit]);
  }

  getClusterNodes(): Promise<ClusterNode[]> {
    return this.rpc.call<ClusterNode[]>('getClusterNodes');
  }

  async getBlockProduction(): Promise<BlockProduction> {
    const res = await this.rpc.call<RpcContext<BlockProduction>>(
      'getBlockProduction',
      [{ commitment: 'confirmed' }],
      60_000,
    );
    return res.value;
  }

  getInflationRate(): Promise<InflationRate> {
    return this.rpc.call<InflationRate>('getInflationRate');
  }

  async getSupplySol(): Promise<number> {
    const res = await this.rpc.call<RpcContext<{ total: number }>>('getSupply', [
      { commitment: 'confirmed', excludeNonCirculatingAccountsList: true },
    ]);
    return res.value.total / 1e9;
  }

  /** The StakeHistory sysvar, newest first (its newest entry is the last finished epoch). */
  async getStakeHistory(): Promise<StakeHistoryEntry[]> {
    const res = await this.rpc.call<RpcContext<{ data: [string, string] } | null>>('getAccountInfo', [
      STAKE_HISTORY_SYSVAR,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    if (!res.value) return [];
    return parseStakeHistory(Buffer.from(res.value.data[0], 'base64'));
  }

  /**
   * Average fee reward a leader earns per block, in SOL, from a sample of recent blocks. Skipped slots
   * are ignored. Used to estimate block revenue per validator (leaders keep 100% of priority fees and half
   * of base fees).
   */
  async sampleFeePerBlockSol(currentSlot: number, samples = 12): Promise<number> {
    const slots = Array.from({ length: samples }, (_, i) => currentSlot - 150 - i * 11);
    const results = await Promise.allSettled(
      slots.map((slot) =>
        this.rpc.call<{ rewards?: { lamports: number; rewardType: string | null }[] } | null>(
          'getBlock',
          [
            slot,
            { rewards: true, transactionDetails: 'none', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
          ],
          20_000,
        ),
      ),
    );
    // Skipped or pruned slots fail or return null; average the blocks that answered.
    const fees = results
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => (r.status === 'fulfilled' && r.value ? (r.value.rewards ?? []) : []))
      .map((rewards) => rewards.filter((x) => x.rewardType === 'Fee').reduce((s, x) => s + x.lamports, 0) / 1e9);
    if (fees.length === 0) throw new Error('no recent block answered');
    return fees.reduce((s, f) => s + f, 0) / fees.length;
  }

  /** Every delegated stake account pointing at `vote`, read as a 136-byte slice. */
  async getStakeAccountsForVote(vote: string): Promise<DelegatedStake[]> {
    const accounts = await this.rpc.call<{ pubkey: string; account: { data: [string, string] } }[]>(
      'getProgramAccounts',
      [
        STAKE_PROGRAM_ID,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          dataSlice: STAKE_SLICE,
          filters: [{ dataSize: STAKE_ACCOUNT_SIZE }, { memcmp: { offset: VOTER_OFFSET, bytes: vote } }],
        },
      ],
      120_000,
    );
    const out: DelegatedStake[] = [];
    for (const { account } of accounts) {
      const parsed = parseStakeSlice(Buffer.from(account.data[0], 'base64'));
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** SPL stake-pool accounts of `programId` with their pool mint (offset 162 of a StakePool account). */
  async getStakePools(programId: string): Promise<{ pool: string; mint: Buffer }[]> {
    const accounts = await this.rpc.call<{ pubkey: string; account: { data: [string, string] } }[]>(
      'getProgramAccounts',
      [
        programId,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          dataSlice: { offset: 162, length: 32 },
          // account_type == StakePool (1); base58 of the single byte 0x01 is "2".
          filters: [{ memcmp: { offset: 0, bytes: '2' } }],
        },
      ],
      60_000,
    );
    return accounts.map((a) => ({ pool: a.pubkey, mint: Buffer.from(a.account.data[0], 'base64') }));
  }

  /**
   * Every stake account where `address` is the staker or the withdrawer authority (two filtered
   * getProgramAccounts calls, merged by pubkey). Undelegated (initialized) accounts are included.
   */
  async getStakeAccountsByAuthority(address: string): Promise<StakeAccountInfo[]> {
    const read = (offset: number) =>
      this.rpc.call<{ pubkey: string; account: { lamports: number; data: [string, string] } }[]>(
        'getProgramAccounts',
        [
          STAKE_PROGRAM_ID,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            filters: [{ dataSize: STAKE_ACCOUNT_SIZE }, { memcmp: { offset, bytes: address } }],
          },
        ],
        60_000,
      );
    const [byStaker, byWithdrawer] = await Promise.all([read(STAKER_OFFSET), read(WITHDRAWER_OFFSET)]);
    const out = new Map<string, StakeAccountInfo>();
    for (const { pubkey, account } of [...byStaker, ...byWithdrawer]) {
      if (out.has(pubkey)) continue;
      const parsed = parseStakeAccount(
        pubkey,
        BigInt(account.lamports),
        Buffer.from(account.data[0], 'base64'),
        bytesToAddress,
      );
      if (parsed) out.set(pubkey, parsed);
    }
    return [...out.values()];
  }

  /**
   * Inflation rewards for stake or vote accounts in one epoch (default: the last one), 32 addresses per call: the
   * public RPC refuses more ("Too many inputs provided; max 32").
   */
  async getInflationReward(addresses: string[], epoch?: number): Promise<(InflationReward | null)[]> {
    const out: (InflationReward | null)[] = [];
    for (let start = 0; start < addresses.length; start += INFLATION_REWARD_BATCH) {
      const chunk = addresses.slice(start, start + INFLATION_REWARD_BATCH);
      const result = await this.rpc.call<(InflationReward | null)[]>(
        'getInflationReward',
        [chunk, epoch === undefined ? { commitment: 'confirmed' } : { commitment: 'confirmed', epoch }],
        60_000,
      );
      out.push(...result);
    }
    return out;
  }

  // ── Validator profile and wallet reads (requests #5, #10) ──────────────────────────────────────

  /** A vote account read as `jsonParsed`; null when the account does not exist or is not a vote account. */
  async getVoteAccountParsed(vote: string): Promise<ParsedVoteAccount | null> {
    const res = await this.rpc.call<RpcContext<{ data: { parsed?: { type: string; info: RawParsedVote } } } | null>>(
      'getAccountInfo',
      [vote, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    );
    const parsed = res.value?.data?.parsed;
    if (!parsed || parsed.type !== 'vote') return null;
    const info = parsed.info;
    return {
      nodePubkey: info.nodePubkey,
      authorizedWithdrawer: info.authorizedWithdrawer,
      commission: info.commission,
      inflationRewardsCommissionBps: info.inflationRewardsCommissionBps,
      epochCredits: (info.epochCredits ?? []).map((entry) => ({
        epoch: Number(entry.epoch),
        credits: Number(entry.credits),
        previousCredits: Number(entry.previousCredits),
      })),
    };
  }

  /** Every stake account delegated to `vote` with its address, read as the scan's 136-byte slice. */
  async getStakeAccountsForVoteWithKeys(vote: string): Promise<VoteStakeAccount[]> {
    const accounts = await this.rpc.call<{ pubkey: string; account: { data: [string, string] } }[]>(
      'getProgramAccounts',
      [
        STAKE_PROGRAM_ID,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          dataSlice: STAKE_SLICE,
          filters: [{ dataSize: STAKE_ACCOUNT_SIZE }, { memcmp: { offset: VOTER_OFFSET, bytes: vote } }],
        },
      ],
      120_000,
    );
    const out: VoteStakeAccount[] = [];
    for (const { pubkey, account } of accounts) {
      const parsed = parseStakeSlice(Buffer.from(account.data[0], 'base64'));
      if (parsed) out.push({ pubkey, ...parsed });
    }
    return out;
  }

  /** Lamports held by an account (0 when it does not exist). */
  async getBalance(address: string): Promise<number> {
    const res = await this.rpc.call<RpcContext<number>>('getBalance', [address, { commitment: 'confirmed' }]);
    return res.value;
  }
}

/** The public RPC's limit on addresses per getInflationReward call. */
const INFLATION_REWARD_BATCH = 32;

interface RawParsedVote {
  nodePubkey: string;
  authorizedWithdrawer: string;
  commission: number;
  inflationRewardsCommissionBps?: number;
  /** jsonParsed prints u64 values as strings. */
  epochCredits?: { epoch: number | string; credits: number | string; previousCredits: number | string }[];
}

/** The parts of a vote account (VoteStateV4 on mainnet) the validator profile uses. */
export interface ParsedVoteAccount {
  nodePubkey: string;
  authorizedWithdrawer: string;
  /** Legacy whole-percent commission. */
  commission: number;
  /** SIMD-0232 inflation commission in bps, when the account has it. */
  inflationRewardsCommissionBps?: number;
  /** Up to 64 epochs, oldest first; credits earned in an epoch = credits − previousCredits. */
  epochCredits: { epoch: number; credits: number; previousCredits: number }[];
}

/** A stake account delegated to one vote account, with its address. */
export type VoteStakeAccount = DelegatedStake & { pubkey: string };
