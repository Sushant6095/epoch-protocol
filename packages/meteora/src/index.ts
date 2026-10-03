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
  dammSeedSol,
  endEpochOf,
  epochsLeft,
  impliedYieldPctPerEpoch,
  launchBand,
  type LaunchBand,
  marketCapSol,
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
  parseLaunchConfig,
  planLaunch,
  registryEntryFor,
} from './launch';
export { appendRegistryEntry, type LaunchCluster, type LaunchRegistryEntry } from './registry';

// Units
export { type ExactDecimal, fromBaseUnits, parseDecimal, toBaseUnits, toBigInt, toBN } from './units';
