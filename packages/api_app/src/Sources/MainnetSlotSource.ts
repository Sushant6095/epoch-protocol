import { type JsonRpcClient } from '../Lib/Http';
import { type EpochInfo, type SolanaDataSource } from './SolanaDataSource';

/**
 * The websocket `slot` channel's mainnet reads: getEpochInfo through the shared SolanaDataSource, and
 * getSlotLeaders (not in SolanaDataSource) over the same RPC endpoints.
 */
export class MainnetSlotSource {
  constructor(
    private readonly solana: Pick<SolanaDataSource, 'getEpochInfo'>,
    private readonly rpc: JsonRpcClient,
    /** Sees every epoch info read (used to keep MarketData's cached epoch fresh). */
    private readonly onEpochInfo?: (info: EpochInfo) => void,
  ) {}

  async getEpochInfo(): Promise<EpochInfo> {
    const info = await this.solana.getEpochInfo();
    this.onEpochInfo?.(info);
    return info;
  }

  /** Leader identities of `limit` consecutive slots from `startSlot` (each leader holds 4 slots in a row). */
  getSlotLeaders(startSlot: number, limit: number): Promise<string[]> {
    return this.rpc.call<string[]>('getSlotLeaders', [startSlot, limit], 10_000);
  }
}
