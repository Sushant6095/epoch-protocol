/**
 * @epoch/epoch-sdk: browser-safe TypeScript client for the Epoch Anchor program, on @solana/web3.js v1 only (no Anchor
 * runtime, no Node built-ins; `TransactionInstruction.data` uses web3.js's own Buffer class).
 * PDAs, account and event decoders, instruction builders, the error table and exact mirrors of the program's math.
 * Every function that touches an address takes `programId` explicitly.
 */

// Seeds, constants, enums
export {
  ADVANCE_STATES,
  type AdvanceState,
  COMMISSION_KIND,
  POSITION_STATUSES,
  type PositionStatus,
  PROGRAM_CONSTANTS,
  RAW_SHARES_PER_UI_SHARE,
  rawSharesToUi,
  SEEDS,
  sharePriceE9ToSol,
  type Side,
  SIDES,
  type Tranche,
  TRANCHES,
  VOTE_PROGRAM_ID,
} from './constants';

// Discriminators
export {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_NAMES,
  type AccountName,
  accountNameOf,
  EVENT_DISCRIMINATORS,
  EVENT_NAMES,
  type EventName,
  eventNameOf,
  INSTRUCTION_DISCRIMINATORS,
  INSTRUCTION_NAMES,
  type InstructionName,
  instructionNameOf,
} from './discriminators';

// PDAs
export {
  findAdvancePda,
  findEscrowPda,
  findFeeIndexPda,
  findLenderPda,
  findPoolPda,
  findPositionPda,
  findQuotePda,
  findSwapPda,
  findVaultPda,
  findVoteAuthPda,
  findWithdrawRequestPda,
} from './pda';

// Accounts
export {
  ACCOUNT_SIZES,
  accountFilters,
  type AdvanceAccount,
  decodeAccount,
  type DecodedAccount,
  decodeAdvance,
  decodeFeeIndex,
  decodeFeeQuote,
  decodeLenderShares,
  decodePool,
  decodeSwapPosition,
  decodeValidatorPosition,
  decodeWithdrawRequest,
  type EpochAccountMap,
  type FeeIndexAccount,
  feeIndexHistory,
  feeIndexValueFor,
  type FeeQuoteAccount,
  FIELD_OFFSETS,
  fieldFilter,
  type IndexPoint,
  type LenderSharesAccount,
  type PoolAccount,
  type PoolParams,
  revenueHistory,
  type SwapPositionAccount,
  trailingRevenue,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from './accounts';

// Events
export {
  decodeEvent,
  type EpochEvent,
  type EpochEventJson,
  type EpochEventMap,
  eventToJson,
  parseEventsFromLogs,
} from './events';

// Instructions
export {
  accrue,
  type AccrueInput,
  type BondInput,
  cancelWithdraw,
  type CancelWithdrawInput,
  configureIndex,
  type ConfigureIndexInput,
  deposit,
  type DepositInput,
  finalizeIndex,
  type FinalizeIndexInput,
  initializeIndex,
  type InitializeIndexInput,
  initializePool,
  type InitializePoolInput,
  lamportsToSolString,
  markDefault,
  type MarkDefaultInput,
  onboardValidator,
  type OnboardValidatorInput,
  onboardWithBond,
  type OnboardWithBondInput,
  openSwap,
  type OpenSwapInput,
  openSwaps,
  type OpenSwapsInput,
  postBond,
  postIndex,
  type PostIndexInput,
  postQuote,
  type PostQuoteInput,
  processWithdrawal,
  type ProcessWithdrawalInput,
  releaseValidator,
  type ReleaseValidatorInput,
  requestAdvance,
  type RequestAdvanceInput,
  requestWithdraw,
  type RequestWithdrawInput,
  type ScoreUpdate,
  setCollectors,
  type SetCollectorsInput,
  setPaused,
  type SetPausedInput,
  setRoles,
  type SetRolesInput,
  settleSwap,
  type SettleSwapInput,
  solToLamports,
  sweep,
  type SweepInput,
  type SwapLeg,
  updateCommission,
  type UpdateCommissionInput,
  updateIdentity,
  type UpdateIdentityInput,
  updateParams,
  type UpdateParamsInput,
  updateScore,
  type UpdateScoreInput,
  vetoIndex,
  type VetoIndexInput,
  withdrawBond,
  withdrawQuote,
  type WithdrawQuoteInput,
} from './instructions';

// Errors
export { EPOCH_ERRORS, epochErrorFromCode, type EpochErrorInfo, parseEpochError } from './errors';

// Math
export {
  absorbLoss,
  assetsToShares,
  attributeRepayment,
  bpsOf,
  bpsOfCeil,
  computeScore,
  creditLimit,
  type CreditLimitInput,
  distributeIncome,
  EpochMathError,
  juniorRatioBps,
  mulDiv,
  type ScoreInput,
  sharePriceE9,
  sharesToAssets,
  splitSweep,
  swapCollateral,
  takerPnl,
} from './math';

// Encodings
export { base58Decode, base58Encode, base64Decode, base64Encode, bytesToHex, hexToBytes } from './encoding';
