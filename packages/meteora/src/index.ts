/**
 * @epoch/meteora: browser-safe helpers for Epoch's validator revenue tokens on Meteora (ADR 0006, plan F13). Pool reads
 * (Dynamic Bonding Curve and DAMM v2), trade quotes and unsigned swap transactions for the Launch page, the
 * revenue-anchored curve for the launch script, and the spec's pure math. Built on the official Meteora SDKs and
 * @solana/web3.js v1; no Node built-ins.
 */

// Constants and the partner preset
export {
  BAND_HIGH_PCT,
  BAND_LOW_PCT,
  BUYBACK_SLICES_PER_EPOCH,
  CREATOR_MIGRATION_FEE_SHARE_PCT,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_TRADING_FEE_BPS,
  LOCKED_LIQUIDITY_PCT,
  MIGRATION_FEE_PCT,
  NATIVE_MINT,
  SOL_DECIMALS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants';

// Pure math (pages/launch.md)
export {
  averageRevenueSol,
  backingRatio,
  curveBand,
  type CurveBand,
  dammSeedLamports,
  dammSeedSol,
  endEpochOf,
  epochsLeft,
  impliedYieldPctPerEpoch,
  launchBand,
  type LaunchBand,
  marketCapSol,
  PROTOCOL_MIGRATION_FEE_BPS,
  shareRevenuePerEpochSol,
  type ShareTerms,
  shareValueSol,
  upfrontToValidatorSol,
} from './math';

// The curve
export {
  curvePointsForBand,
  type CurvePointsInput,
  type DammFeeBps,
  isqrt,
  priceToSqrtPriceX64,
  revenueCurveConfig,
  type RevenueCurve,
  type RevenueCurveInput,
  sqrtPriceX64ToPrice,
} from './curve';

// Pool reads
export {
  cpAmmClient,
  type DammPoolState,
  dbcClient,
  graduatedDammPool,
  type LaunchPoolState,
  mapDammPool,
  mapLaunchPool,
  MIGRATION_PROGRESS,
  type MigrationProgress,
  readCurveAccounts,
  readDammPool,
  readLaunchPool,
} from './pools';

// Trades
export {
  buildTradeTx,
  type BuildTradeTxParams,
  computeBudgetInstructions,
  DEFAULT_TRADE_PRIORITY_MICROLAMPORTS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  TRADE_COMPUTE_UNIT_LIMIT,
  type DammQuoteResult,
  dammSwapAmounts,
  type DbcQuoteResult,
  dbcSwapAmounts,
  LaunchTradeError,
  type LaunchTradeErrorCode,
  type LaunchRef,
  type LaunchTradeQuote,
  quoteTrade,
  type QuoteTradeParams,
  type RawSwapAmounts,
  toTradeQuote,
  type TradeSide,
  type TradeVenue,
} from './trade';

// Buyback quotes (the revenue-token crank)
export {
  buybackGraduation,
  type BuybackQuote,
  buybackMinimumOut,
  type BuybackVenueAccounts,
  type BuybackVenueKind,
  buybackVenueState,
  type BuybackVenueState,
  quoteBuyback,
  type RawCurvePoint,
  readBuybackVenue,
} from './buyback';

// Token reads
export {
  countTokenHolders,
  decodeMintAccount,
  type DecodedMint,
  decodeTokenAccountSlice,
  holderFilters,
  readTokenMint,
  tallyHolders,
  type TokenAccountSlice,
  type TokenHolders,
  TOKEN_ACCOUNT_STATE_FILTER,
  type TokenMintInfo,
} from './token';

// Launch script (pure parts) and the registry
export {
  type LaunchConfigInput,
  LaunchConfigError,
  type LaunchPlan,
  type LaunchReceipt,
  launchRecordFor,
  withRegistration,
  parseLaunchConfig,
  planLaunch,
  registryEntryFor,
} from './launch';
export { appendRegistryEntry, type LaunchCluster, type LaunchRegistryEntry } from './registry';

// Units
export { type ExactDecimal, fromBaseUnits, parseDecimal, toBaseUnits, toBigInt, toBN } from './units';

// Events: trades, fee claims and graduation decoded from DBC / DAMM v2 CPI events (the Launch page's live feed)
export { base58Decode, base58Encode } from './base58';
export {
  DAMM_V2_PROGRAM,
  DBC_PROGRAM,
  decodeMeteoraEvents,
  EVENT_IX_TAG,
  launchFeeEventsFromTransaction,
  type LaunchFeeEvent,
  type LaunchFeeEventKind,
  type LaunchTradeEvent,
  launchTradesFromTransaction,
  type MeteoraEvent,
  type MeteoraProgram,
  type NormalizedInstruction,
  type NormalizedTransaction,
  normalizeTransaction,
  type TradePoolInfo,
} from './events';
export { type DecodedStruct, type DecodedValue, IdlCoder, type IdlLike } from './idlCoder';

// Candles
export {
  buildCandles,
  type BuildCandlesOptions,
  type Candle,
  CANDLE_INTERVAL_SECONDS,
  CANDLE_INTERVALS,
  type CandleInterval,
  fillCandles,
  MAX_CANDLES,
  type PricePoint,
} from './candles';

// Claims: partner and creator fees, surplus, leftover, DAMM v2 LP fees
export {
  buildClaimTx,
  claimAmountsUi,
  type ClaimableItem,
  type ClaimKind,
  CREATOR_MIGRATION_FEE_MASK,
  type DammPositionClaim,
  dammPositionClaim,
  isSolQuoted,
  launchClaimsFromState,
  type LaunchClaimsState,
  migrationFeeSplit,
  PARTNER_AND_CREATOR_SURPLUS_SHARE,
  PARTNER_MIGRATION_FEE_MASK,
  readDammPositions,
  readLaunchClaims,
  surplusSplit,
} from './claims';

// Graduation
export { buildMigrateToDammV2Tx, type MigrationReadiness, migrationReadiness } from './migration';

// Meteora's DAMM v2 data API (indexed pool stats, candles, volume, protocol totals): depth for graduated launches
export {
  DAMM_V2_DATA_API_URL,
  DammDataApi,
  type DammDataApiOptions,
  type DammIndexedCandle,
  type DammIndexedPool,
  type DammIndexedVolume,
  type DammProtocolMetrics,
  DATA_API_TIMEFRAMES,
  DataApiError,
  type DataApiRange,
  type DataApiSeries,
  type DataApiTimeframe,
  type DataApiWindows,
  mapIndexedCandles,
  mapIndexedPool,
  mapIndexedVolume,
  mapProtocolMetrics,
} from './dataApi';

// Holders
export { type HolderLabels, mapTopHolders, readTopHolders, type TopHolder } from './holders';

// Revenue history (the curve's input)
export {
  type EpochRevenue,
  estimateBlockRevenue,
  readRevenueHistory,
  type RevenueHistoryOptions,
  readVoteIdentity,
  retryRateLimited,
  type RevenueSummary,
  spreadSample,
  summarizeRevenue,
} from './revenue';

// The launch script's pure parts: cost, pre-flight checks, the plan's math, token metadata
export {
  estimateLaunchCost,
  LAUNCH_ACCOUNT_BYTES,
  type LaunchCost,
  type LaunchCostInput,
  type LaunchCostItem,
  METAPLEX_CREATE_FEE_LAMPORTS,
  rentExemptLamports,
  SIGNATURE_FEE_LAMPORTS,
} from './launchCost';
export {
  checkAccount,
  checkCluster,
  checkEpochPool,
  checkExistingConfig,
  checkInitialBuy,
  checkLeftoverReceiver,
  checkMetadataJson,
  checkMeteoraValidation,
  checkPayerBalance,
  checkProgram,
  checkRegistrableConfig,
  checkRegistrationConfig,
  type RegistrationConfigVerdict,
  checkRegistrableMint,
  checkRegistry,
  checkRevenueTokenTerms,
  checkStartEpoch,
  type CheckStatus,
  checkValidatorPosition,
  GENESIS_HASH,
  type PreflightCheck,
  type PreflightSummary,
  type RevenueTokenLimits,
  summarizePreflight,
  treasuryMismatch,
  type ValidatorPositionState,
} from './launchPreflight';
export { formatSol, launchPlanLines, revenueTableLines } from './launchReport';
export { decodeTokenMetadata, readTokenMetadata, type TokenMetadata } from './tokenMetadata';
