/**
 * The launch registry: one JSON entry per revenue token, read by api_app (`LAUNCHES_PATH`) and appended by the launch
 * script. It lists the launches and their Meteora pools; once `register_revenue_token` ran, the program's `RevenueToken`
 * account (`revenueToken`) is the source of the terms and the buyback state.
 */
export type LaunchCluster = 'devnet' | 'mainnet';

export interface LaunchRegistryEntry {
  mint: string;
  symbol: string;
  name: string;
  /** `vote` is the validator's mainnet vote account (its revenue backs the token), or null. */
  validator: { name: string; vote: string | null };
  /** Share of the validator's commission sold, bps. */
  shareBps: number;
  termEpochs: number;
  /** First epoch whose revenue share is bought back. */
  startEpoch: number;
  /** Set when the curve opens later than the registration. */
  opensAtEpoch?: number | null;
  dbcPool?: string | null;
  dbcConfig?: string | null;
  /** The DAMM v2 pool after graduation (derived from the curve when omitted). */
  dammPool?: string | null;
  /** The buyback escrow, the program's PDA `["buyback", vote]`: every sweep's share lands here. */
  escrow?: string | null;
  /** Fixed supply at launch, UI units. */
  supply: number;
  decimals: number;
  /** Fallback for burned tokens when the mint cannot be read. */
  burned?: number;
  cluster: LaunchCluster;
  /** The 10-epoch average revenue per epoch (SOL) the curve was priced from. */
  avgRevenueSol?: number;
  /** The raise target set at launch (DBC migrationQuoteThreshold), SOL. */
  raiseTargetSol?: number;
  /** The epoch the token graduated, when known. */
  graduatedEpoch?: number | null;
  /** When the launch script created the pool (ISO 8601, IST). */
  launchedAt?: string;
  /** The pool creator (receives the 70% migration fee): the validator's wallet. */
  creator?: string | null;
  /** The DBC partner and fee claimer: the Epoch program's treasury PDA `["treasury", pool]`. */
  feeClaimer?: string | null;
  /** Who can withdraw the unused supply after graduation (the treasury PDA: the program burns it). */
  leftoverReceiver?: string | null;
  /**
   * Transaction signatures by step: createConfig, createPool, launch (both in one), transferCreator, and
   * registerRevenueToken once the validator's operator registered the token.
   */
  signatures?: Record<string, string>;
  /** The Epoch program the token is (to be) registered with. */
  programId?: string | null;
  /** The program's `RevenueToken` account, `["revenue_token", vote]`. */
  revenueToken?: string | null;
  /** The epoch `register_revenue_token` ran in (the term starts with the next one); null until registered. */
  registeredEpoch?: number | null;
}

/** Adds an entry, refusing a second entry for the same mint (pure: the caller writes the file). */
export function appendRegistryEntry(
  entries: readonly LaunchRegistryEntry[],
  entry: LaunchRegistryEntry,
): LaunchRegistryEntry[] {
  if (entries.some((existing) => existing.mint === entry.mint)) {
    throw new Error(`the registry already has a launch for mint ${entry.mint}`);
  }
  return [...entries, entry];
}
