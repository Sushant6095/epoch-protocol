import { type Connection, PublicKey } from '@solana/web3.js';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { type EpochProgramSource } from '../../Sources/EpochProgramSource';
import { type MevEpochRecord } from '../Validator/MevHistory';
import { type ValidatorTableData } from '../ValidatorTable';
import { type ProgramEventStore } from './ProgramEventStore';

/**
 * The program reads the Vault, position, lender and market services use. `EpochProgramSource` satisfies it; tests
 * pass fakes built from epoch-sdk account types.
 */
export type ProgramReader = Pick<
  EpochProgramSource,
  | 'cluster'
  | 'configured'
  | 'marketMaker'
  | 'requirePool'
  | 'pool'
  | 'feeIndex'
  | 'positions'
  | 'position'
  | 'positionsByOperator'
  | 'advances'
  | 'lenders'
  | 'lenderAccounts'
  | 'withdrawRequests'
  | 'quotes'
  | 'swaps'
  | 'epochInfo'
  | 'firstSlotOfEpoch'
  | 'epochOfSlot'
>;

/** Stored program events (`getServices().events`). */
export type EventReader = Pick<ProgramEventStore, 'query'>;

/** Mainnet validator rows, for names by vote, the not-onboarded estimate and epochs a year. */
export interface ValidatorDirectory {
  get(): Promise<Pick<ValidatorTableData, 'rows' | 'epochsPerYear' | 'grossYieldPerEpoch'>>;
}

/** One point of the Pool's history, recorded at each `Accrued` event (`pool_snapshots`). */
export interface PoolHistoryPoint {
  epoch: number;
  seniorPriceE9: bigint;
  juniorPriceE9: bigint;
  utilizationBps: number;
}

/** The Pool's per-epoch history, oldest first. */
export interface PoolHistory {
  recent(limit: number): Promise<PoolHistoryPoint[]>;
}

export const NO_POOL_HISTORY: PoolHistory = { recent: async () => [] };

/** Everything the program services read. */
export interface ProgramServiceDeps {
  program: ProgramReader;
  events: EventReader;
  validators: ValidatorDirectory;
  history: PoolHistory;
  /** The program cluster's EpochRewards sysvar `active` flag; null when it can't be read. */
  rewardsActive: () => Promise<boolean | null>;
  /** indexer_app's Jito MEV scan for a vote account, oldest first (request #5b); undefined without it. */
  mev?: (vote: string) => readonly MevEpochRecord[] | undefined;
  now?: () => Date;
}

/** The EpochRewards sysvar (SIMD-0118): `active` while stake rewards are still being paid at the start of an epoch. */
export const EPOCH_REWARDS_SYSVAR = new PublicKey('SysvarEpochRewards1111111111111111111111111');

/**
 * Offset of `active` in the sysvar's data: distribution_starting_block_height u64, num_partitions u64,
 * parent_blockhash [u8; 32], total_points u128, total_rewards u64, distributed_rewards u64, then active: bool.
 */
export const EPOCH_REWARDS_ACTIVE_OFFSET = 8 + 8 + 32 + 16 + 8 + 8;

export function parseEpochRewardsActive(data: Uint8Array): boolean | null {
  return data.length > EPOCH_REWARDS_ACTIVE_OFFSET ? data[EPOCH_REWARDS_ACTIVE_OFFSET] !== 0 : null;
}

/** Reads the EpochRewards sysvar on the program's cluster; null when the read fails or the account is missing. */
export async function readEpochRewardsActive(connections: {
  withFailover<T>(fn: (connection: Connection) => Promise<T>): Promise<T>;
}): Promise<boolean | null> {
  try {
    const info = await connections.withFailover((c) => c.getAccountInfo(EPOCH_REWARDS_SYSVAR, 'confirmed'));
    return info ? parseEpochRewardsActive(info.data) : null;
  } catch {
    return null;
  }
}

/** The epoch an event happened in: the ingester's `epoch`, else derived from its slot. */
export async function eventEpoch(
  program: Pick<ProgramReader, 'epochOfSlot'>,
  event: Pick<StoredProgramEvent, 'epoch' | 'slot'>,
): Promise<number> {
  return event.epoch ?? program.epochOfSlot(event.slot);
}
