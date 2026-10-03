import { type JsonRpcClient } from '../Lib/Http';
import {
  parseStakeHistory,
  parseStakeSlice,
  STAKE_ACCOUNT_SIZE,
  STAKE_HISTORY_SYSVAR,
  STAKE_PROGRAM_ID,
  STAKE_SLICE,
  type DelegatedStake,
  type StakeHistoryEntry,
  VOTER_OFFSET,
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
}
