export const LAMPORTS_PER_SOL = 1_000_000_000;
export const SLOTS_PER_EPOCH = 432_000;
export const BPS_DENOMINATOR = 10_000;

/** Alpenglow admission ticket, charged from the vote account every epoch. */
export const ADMISSION_FEE_RESERVE_LAMPORTS = 1_600_000_000;

/** Epochs of revenue history used for the credit limit. */
export const REVENUE_WINDOW_EPOCHS = 10;

/** PDA seeds, as in programs/epoch/src/constants.rs. The PDA helpers live in @epoch/epoch-sdk. */
export const SEEDS = {
  pool: 'pool',
  vault: 'vault',
  lender: 'lender',
  withdraw: 'withdraw',
  position: 'position',
  voteAuthority: 'vote_auth',
  escrow: 'escrow',
  advance: 'advance',
  feeIndex: 'fee_index',
  feeQuote: 'quote',
  swap: 'swap',
} as const;
