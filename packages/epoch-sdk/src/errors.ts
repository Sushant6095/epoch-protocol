/**
 * `EpochError` from `programs/epoch/src/errors.rs`. Anchor numbers custom errors from 6000 in declaration order;
 * messages are the `#[msg]` strings verbatim.
 */

export interface EpochErrorInfo {
  code: number;
  name: string;
  message: string;
}

export const EPOCH_ERRORS: readonly EpochErrorInfo[] = Object.freeze(
  [
    { code: 6000, name: 'Paused', message: 'Pool is paused' },
    { code: 6001, name: 'NotAdmin', message: 'Signer is not the pool admin' },
    { code: 6002, name: 'NotScorer', message: 'Signer is not the scorer authority' },
    { code: 6003, name: 'NotPublisher', message: 'Signer is not the index publisher' },
    { code: 6004, name: 'BpsOutOfRange', message: 'A basis-point parameter is above 10,000' },
    { code: 6005, name: 'InvalidParams', message: 'Pool parameters are inconsistent' },
    { code: 6006, name: 'MathOverflow', message: 'Arithmetic overflow' },
    { code: 6007, name: 'ZeroAmount', message: 'Amount must be greater than zero' },
    { code: 6008, name: 'PoolCapExceeded', message: 'Deposit would push the pool above its asset cap' },
    { code: 6009, name: 'InsufficientShares', message: 'Not enough shares' },
    {
      code: 6010,
      name: 'InsufficientLiquidity',
      message: 'Not enough cash in the vault; try again after the next sweep',
    },
    { code: 6011, name: 'JuniorLocked', message: 'Junior tranche is still locked' },
    { code: 6012, name: 'JuniorFloorBreached', message: 'Withdrawal would push the junior tranche below its floor' },
    {
      code: 6013,
      name: 'NotHeadOfQueue',
      message: 'Withdrawal requests are processed in order; this one is not next',
    },
    { code: 6014, name: 'RequestCancelled', message: 'Withdrawal request was already cancelled' },
    { code: 6015, name: 'AlreadyAccrued', message: 'Accrual already ran for this epoch' },
    {
      code: 6016,
      name: 'VaultLedgerMismatch',
      message: "Vault balance does not cover the pool's ledger; refusing to proceed",
    },
    {
      code: 6017,
      name: 'NotAVoteAccount',
      message: 'Account is not owned by the vote program or is not a vote account',
    },
    { code: 6018, name: 'UnsupportedVoteState', message: 'Vote account data is not a supported vote state version' },
    {
      code: 6019,
      name: 'NotWithdrawAuthority',
      message: "Signer is not the vote account's current withdraw authority",
    },
    {
      code: 6020,
      name: 'ProgramNotWithdrawAuthority',
      message: "The program is not the vote account's withdraw authority",
    },
    { code: 6021, name: 'IdentityMismatch', message: 'Vote account identity changed outside the program' },
    { code: 6022, name: 'NotOperator', message: "Signer is not the position's operator" },
    { code: 6023, name: 'PayoutMismatch', message: 'Payout account does not match the position' },
    { code: 6024, name: 'PositionNotActive', message: 'Validator position is not active' },
    { code: 6025, name: 'AdvanceAlreadyOpen', message: 'Validator already has an open advance' },
    { code: 6026, name: 'AdvanceMismatch', message: "Advance account does not match the position's open advance" },
    { code: 6027, name: 'AdvanceOpen', message: 'Cannot do this while an advance is open' },
    { code: 6028, name: 'NoOpenAdvance', message: 'No open advance' },
    { code: 6029, name: 'AdvanceStateInvalid', message: 'Advance is not in the expected state' },
    { code: 6030, name: 'ScoreTooLow', message: 'Score is too low to borrow' },
    { code: 6031, name: 'ScoreStale', message: 'Score is stale; update it first' },
    { code: 6032, name: 'OverLimit', message: 'Requested amount exceeds the credit limit' },
    { code: 6033, name: 'BelowMinimum', message: 'Amount is below the minimum advance' },
    { code: 6034, name: 'UtilizationCapExceeded', message: 'Advance would push utilisation above the cap' },
    { code: 6035, name: 'InsufficientHistory', message: 'Not enough revenue history yet' },
    { code: 6036, name: 'AlreadySweptThisEpoch', message: 'Already swept this epoch' },
    {
      code: 6037,
      name: 'RewardsInProgress',
      message: 'Epoch rewards are still being distributed; sweep after they finish',
    },
    { code: 6038, name: 'NotDefaultable', message: 'Advance is not eligible for default yet' },
    { code: 6039, name: 'CommissionTooLow', message: 'Commission below the pool minimum' },
    { code: 6040, name: 'CommissionChangeBlocked', message: 'Commission changes are limited while an advance is open' },
    { code: 6041, name: 'BondLocked', message: 'Bond cannot be withdrawn while an advance is open' },
    {
      code: 6042,
      name: 'IndexEpochNotNewer',
      message: 'Fee index epoch must be greater than the last finalized epoch',
    },
    { code: 6043, name: 'IndexMoveTooLarge', message: 'Index move exceeds the per-epoch bound' },
    { code: 6044, name: 'NoProposal', message: 'No index proposal pending' },
    { code: 6045, name: 'DisputeWindowOpen', message: 'Dispute window has not elapsed' },
    {
      code: 6046,
      name: 'DisputeWindowClosed',
      message: 'Dispute window has elapsed; the proposal can no longer be vetoed',
    },
    { code: 6047, name: 'IndexMissing', message: 'Fee index for this epoch has not been finalized' },
    { code: 6048, name: 'QuoteExpired', message: 'Quote has expired' },
    { code: 6049, name: 'QuoteEpochMismatch', message: 'Quote is for a different epoch' },
    { code: 6050, name: 'QuoteCapacityExceeded', message: 'Notional exceeds what the quote has left' },
    { code: 6051, name: 'QuoteHasOpenSwaps', message: 'Quote still has open swaps' },
    { code: 6052, name: 'AlreadySettled', message: 'Swap already settled' },
    { code: 6053, name: 'NotMaker', message: 'Signer is not the quote maker' },
  ].map((e) => Object.freeze(e)),
);

const BY_CODE = new Map<number, EpochErrorInfo>(EPOCH_ERRORS.map((e) => [e.code, e]));

export function epochErrorFromCode(code: number): EpochErrorInfo | undefined {
  return BY_CODE.get(code);
}

// Anchor: "AnchorError … Error Code: Paused. Error Number: 6000. Error Message: …"
const ANCHOR_LOG = /Error Number: (\d+)\./g;
// Runtime: "Program X failed: custom program error: 0x1770" (also in simulation error messages).
const CUSTOM_HEX = /custom program error: 0x([0-9a-fA-F]+)/g;
// JSON-printed TransactionError: {"InstructionError":[0,{"Custom":6000}]}
const CUSTOM_JSON = /"Custom"\s*:\s*(\d+)/g;

function codesInText(text: string, out: number[]): void {
  for (const m of text.matchAll(ANCHOR_LOG)) out.push(Number(m[1]));
  for (const m of text.matchAll(CUSTOM_HEX)) out.push(parseInt(m[1], 16));
  for (const m of text.matchAll(CUSTOM_JSON)) out.push(Number(m[1]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Candidate custom error codes found anywhere in `value`, most specific sources first. */
function collectCodes(value: unknown, out: number[], seen: Set<unknown>, depth: number): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) out.push(value);
    return;
  }
  if (typeof value === 'string') {
    codesInText(value, out);
    return;
  }
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectCodes(item, out, seen, depth + 1);
    return;
  }

  // Program logs (SendTransactionError.logs, simulation `value.logs`, RPC error `data.logs`).
  for (const key of ['logs', 'transactionLogs']) {
    const logs = value[key];
    if (Array.isArray(logs)) for (const line of logs) if (typeof line === 'string') codesInText(line, out);
  }
  // TransactionError: { InstructionError: [index, { Custom: n }] }
  const ixError = value.InstructionError;
  if (Array.isArray(ixError) && isRecord(ixError[1]) && typeof ixError[1].Custom === 'number') {
    out.push(ixError[1].Custom);
  }
  if (typeof value.Custom === 'number') out.push(value.Custom);
  // @coral-xyz/anchor's AnchorError: { error: { errorCode: { number } } }
  if (isRecord(value.error) && isRecord(value.error.errorCode) && typeof value.error.errorCode.number === 'number') {
    out.push(value.error.errorCode.number);
  }
  if (typeof value.code === 'number') out.push(value.code);
  for (const key of ['err', 'value', 'data', 'error', 'cause', 'transactionError', 'originalError']) {
    if (key in value) collectCodes(value[key], out, seen, depth + 1);
  }
  for (const key of ['message', 'transactionMessage', 'msg']) {
    if (typeof value[key] === 'string') codesInText(value[key] as string, out);
  }
}

/**
 * The Epoch error behind a failed transaction, simulation or send, or undefined if none is recognisable. Accepts a
 * `TransactionError` (`{ InstructionError: [i, { Custom: n }] }`), a confirmation/simulation result (`{ err, logs }`,
 * `{ value: { err, logs } }`), web3.js's `SendTransactionError` (`.logs`, `.message`), Anchor's `AnchorError`, an RPC
 * error (`{ code, message, data: { logs } }`), a log array, a message string or a bare error number.
 */
export function parseEpochError(error: unknown): EpochErrorInfo | undefined {
  const codes: number[] = [];
  collectCodes(error, codes, new Set(), 0);
  for (const code of codes) {
    const info = BY_CODE.get(code);
    if (info) return info;
  }
  return undefined;
}
