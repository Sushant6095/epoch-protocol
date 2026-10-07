/**
 * Anchor discriminators, precomputed so the SDK needs no SHA-256 at runtime (browser-safe, no `crypto`):
 * `sha256("account:<Struct>")[0..8]`, `sha256("global:<snake_case_ix>")[0..8]`, `sha256("event:<Event>")[0..8]`.
 * `discriminators.test.ts` recomputes every value with Node's crypto, and the Rust vectors pin them to the program.
 */
import { bytesToHex } from './encoding';

export type AccountName =
  | 'Pool'
  | 'LenderShares'
  | 'WithdrawRequest'
  | 'ValidatorPosition'
  | 'Advance'
  | 'FeeIndex'
  | 'FeeQuote'
  | 'SwapPosition'
  | 'RevenueToken'
  | 'ValidatorHistory'
  | 'ScoreConfig';

/** Instruction names exactly as in `lib.rs` (snake_case; the discriminator preimage is `global:<name>`). */
export type InstructionName =
  | 'initialize_pool'
  | 'update_params'
  | 'set_paused'
  | 'set_roles'
  | 'deposit'
  | 'request_withdraw'
  | 'cancel_withdraw'
  | 'process_withdrawal'
  | 'accrue'
  | 'onboard_validator'
  | 'set_collectors'
  | 'update_score'
  | 'post_bond'
  | 'withdraw_bond'
  | 'request_advance'
  | 'sweep'
  | 'mark_default'
  | 'release_validator'
  | 'update_commission'
  | 'update_identity'
  | 'initialize_index'
  | 'configure_index'
  | 'post_index'
  | 'finalize_index'
  | 'veto_index'
  | 'post_quote'
  | 'withdraw_quote'
  | 'open_swap'
  | 'settle_swap'
  | 'register_revenue_token'
  | 'sync_revenue_token_pool'
  | 'execute_buyback'
  | 'redeem'
  | 'configure_revenue_token'
  | 'close_revenue_token'
  | 'claim_partner_trading_fee'
  | 'claim_partner_surplus'
  | 'claim_partner_migration_fee'
  | 'burn_leftover'
  | 'claim_treasury_lp_fee'
  | 'init_validator_history'
  | 'copy_vote_account'
  | 'copy_tip_distribution_account'
  | 'copy_priority_fee_distribution'
  | 'update_stake_info'
  | 'refresh_score'
  | 'configure_scoring';

export type EventName =
  | 'PoolInitialized'
  | 'ParamsUpdated'
  | 'PauseToggled'
  | 'Deposited'
  | 'WithdrawRequested'
  | 'WithdrawCancelled'
  | 'WithdrawProcessed'
  | 'Accrued'
  | 'ValidatorOnboarded'
  | 'CollectorsSet'
  | 'ScoreUpdated'
  | 'BondPosted'
  | 'BondWithdrawn'
  | 'AdvanceOpened'
  | 'Swept'
  | 'AdvanceRepaid'
  | 'AdvanceDefaulted'
  | 'CommissionUpdated'
  | 'IdentityUpdated'
  | 'ValidatorReleased'
  | 'IndexProposed'
  | 'IndexFinalized'
  | 'IndexVetoed'
  | 'QuotePosted'
  | 'SwapOpened'
  | 'SwapSettled'
  | 'RevenueTokenRegistered'
  | 'RevenueShareSwept'
  | 'RevenueTokenPoolSynced'
  | 'BuybackExecuted'
  | 'RevenueTokenRedeemed'
  | 'RevenueTokenConfigured'
  | 'RevenueTokenClosed'
  | 'TreasuryClaimed'
  | 'HistoryInitialized'
  | 'VoteAccountCopied'
  | 'TipDistributionCopied'
  | 'PriorityFeeDistributionCopied'
  | 'StakeInfoUpdated'
  | 'ScoreRefreshed'
  | 'ScoringConfigured';

export const ACCOUNT_DISCRIMINATORS: Readonly<Record<AccountName, Uint8Array>> = Object.freeze({
  Pool: new Uint8Array([241, 154, 109, 4, 17, 177, 109, 188]),
  LenderShares: new Uint8Array([92, 229, 21, 194, 30, 129, 37, 139]),
  WithdrawRequest: new Uint8Array([186, 239, 174, 191, 189, 13, 47, 196]),
  ValidatorPosition: new Uint8Array([149, 243, 231, 113, 234, 221, 177, 221]),
  Advance: new Uint8Array([66, 25, 217, 133, 38, 192, 224, 218]),
  FeeIndex: new Uint8Array([120, 150, 229, 157, 248, 45, 110, 249]),
  FeeQuote: new Uint8Array([228, 252, 197, 237, 1, 50, 181, 20]),
  SwapPosition: new Uint8Array([65, 203, 85, 175, 129, 154, 6, 152]),
  RevenueToken: new Uint8Array([123, 71, 28, 221, 233, 129, 80, 207]),
  ValidatorHistory: new Uint8Array([205, 25, 8, 221, 253, 131, 2, 146]),
  ScoreConfig: new Uint8Array([150, 113, 251, 218, 0, 146, 67, 39]),
});

export const INSTRUCTION_DISCRIMINATORS: Readonly<Record<InstructionName, Uint8Array>> = Object.freeze({
  initialize_pool: new Uint8Array([95, 180, 10, 172, 84, 174, 232, 40]),
  update_params: new Uint8Array([108, 178, 190, 95, 94, 203, 116, 20]),
  set_paused: new Uint8Array([91, 60, 125, 192, 176, 225, 166, 218]),
  set_roles: new Uint8Array([119, 86, 129, 161, 55, 23, 250, 12]),
  deposit: new Uint8Array([242, 35, 198, 137, 82, 225, 242, 182]),
  request_withdraw: new Uint8Array([137, 95, 187, 96, 250, 138, 31, 182]),
  cancel_withdraw: new Uint8Array([112, 53, 226, 58, 158, 30, 37, 168]),
  process_withdrawal: new Uint8Array([51, 97, 236, 17, 37, 33, 196, 64]),
  accrue: new Uint8Array([23, 76, 128, 149, 229, 247, 72, 228]),
  onboard_validator: new Uint8Array([236, 33, 253, 101, 46, 150, 97, 23]),
  set_collectors: new Uint8Array([159, 203, 245, 22, 221, 225, 135, 63]),
  update_score: new Uint8Array([188, 226, 238, 41, 14, 241, 105, 215]),
  post_bond: new Uint8Array([168, 151, 202, 119, 163, 58, 147, 247]),
  withdraw_bond: new Uint8Array([222, 199, 141, 31, 188, 93, 155, 40]),
  request_advance: new Uint8Array([30, 94, 222, 131, 223, 83, 0, 28]),
  sweep: new Uint8Array([40, 23, 234, 175, 14, 61, 154, 177]),
  mark_default: new Uint8Array([182, 231, 123, 132, 66, 208, 137, 139]),
  release_validator: new Uint8Array([99, 120, 136, 121, 26, 43, 230, 60]),
  update_commission: new Uint8Array([2, 202, 72, 156, 19, 253, 91, 174]),
  update_identity: new Uint8Array([130, 54, 88, 104, 222, 124, 238, 252]),
  initialize_index: new Uint8Array([204, 67, 3, 74, 139, 139, 233, 10]),
  configure_index: new Uint8Array([167, 89, 14, 253, 110, 85, 166, 9]),
  post_index: new Uint8Array([221, 162, 38, 53, 98, 77, 183, 154]),
  finalize_index: new Uint8Array([216, 244, 132, 90, 253, 137, 153, 204]),
  veto_index: new Uint8Array([105, 183, 218, 116, 209, 85, 47, 170]),
  post_quote: new Uint8Array([68, 231, 88, 224, 13, 116, 27, 84]),
  withdraw_quote: new Uint8Array([209, 209, 177, 248, 7, 105, 157, 66]),
  open_swap: new Uint8Array([109, 109, 21, 132, 201, 76, 67, 113]),
  settle_swap: new Uint8Array([3, 130, 133, 180, 251, 87, 242, 250]),
  register_revenue_token: new Uint8Array([212, 153, 133, 48, 164, 75, 131, 42]),
  sync_revenue_token_pool: new Uint8Array([177, 191, 191, 37, 193, 225, 157, 235]),
  execute_buyback: new Uint8Array([47, 32, 19, 100, 184, 96, 144, 49]),
  redeem: new Uint8Array([184, 12, 86, 149, 70, 196, 97, 225]),
  configure_revenue_token: new Uint8Array([57, 116, 133, 153, 50, 219, 215, 86]),
  close_revenue_token: new Uint8Array([250, 78, 2, 43, 3, 113, 229, 213]),
  claim_partner_trading_fee: new Uint8Array([123, 126, 241, 171, 152, 241, 18, 123]),
  claim_partner_surplus: new Uint8Array([88, 48, 210, 241, 182, 188, 75, 118]),
  claim_partner_migration_fee: new Uint8Array([5, 91, 233, 246, 90, 63, 86, 200]),
  burn_leftover: new Uint8Array([58, 137, 245, 55, 2, 29, 142, 89]),
  claim_treasury_lp_fee: new Uint8Array([120, 183, 249, 249, 185, 84, 122, 60]),
  init_validator_history: new Uint8Array([15, 24, 53, 164, 220, 184, 185, 60]),
  copy_vote_account: new Uint8Array([171, 204, 73, 59, 129, 63, 134, 61]),
  copy_tip_distribution_account: new Uint8Array([208, 213, 185, 210, 103, 124, 128, 173]),
  copy_priority_fee_distribution: new Uint8Array([152, 174, 178, 77, 92, 83, 93, 33]),
  update_stake_info: new Uint8Array([25, 244, 8, 32, 250, 244, 170, 207]),
  refresh_score: new Uint8Array([60, 234, 183, 65, 144, 1, 136, 207]),
  configure_scoring: new Uint8Array([208, 106, 50, 176, 142, 54, 115, 55]),
});

export const EVENT_DISCRIMINATORS: Readonly<Record<EventName, Uint8Array>> = Object.freeze({
  PoolInitialized: new Uint8Array([100, 118, 173, 87, 12, 198, 254, 229]),
  ParamsUpdated: new Uint8Array([2, 163, 138, 99, 135, 11, 136, 169]),
  PauseToggled: new Uint8Array([105, 215, 89, 53, 198, 232, 136, 161]),
  Deposited: new Uint8Array([111, 141, 26, 45, 161, 35, 100, 57]),
  WithdrawRequested: new Uint8Array([114, 16, 240, 206, 93, 128, 151, 39]),
  WithdrawCancelled: new Uint8Array([162, 153, 181, 47, 154, 132, 183, 117]),
  WithdrawProcessed: new Uint8Array([234, 53, 39, 68, 158, 177, 195, 13]),
  Accrued: new Uint8Array([207, 152, 166, 145, 189, 39, 33, 167]),
  ValidatorOnboarded: new Uint8Array([160, 198, 146, 91, 138, 245, 189, 71]),
  CollectorsSet: new Uint8Array([38, 70, 161, 35, 230, 192, 41, 21]),
  ScoreUpdated: new Uint8Array([175, 144, 206, 62, 108, 213, 230, 183]),
  BondPosted: new Uint8Array([39, 196, 2, 142, 202, 74, 107, 205]),
  BondWithdrawn: new Uint8Array([111, 192, 154, 231, 58, 115, 130, 103]),
  AdvanceOpened: new Uint8Array([186, 136, 85, 49, 255, 147, 220, 30]),
  Swept: new Uint8Array([254, 138, 9, 198, 192, 61, 165, 135]),
  AdvanceRepaid: new Uint8Array([185, 191, 136, 90, 224, 95, 1, 197]),
  AdvanceDefaulted: new Uint8Array([225, 99, 203, 24, 229, 27, 26, 186]),
  CommissionUpdated: new Uint8Array([107, 183, 135, 132, 231, 24, 226, 183]),
  IdentityUpdated: new Uint8Array([93, 70, 231, 144, 0, 172, 155, 159]),
  ValidatorReleased: new Uint8Array([249, 168, 48, 45, 217, 240, 96, 159]),
  IndexProposed: new Uint8Array([34, 205, 59, 177, 150, 79, 9, 185]),
  IndexFinalized: new Uint8Array([220, 108, 152, 84, 157, 165, 201, 162]),
  IndexVetoed: new Uint8Array([79, 144, 93, 156, 122, 24, 194, 132]),
  QuotePosted: new Uint8Array([130, 69, 35, 209, 183, 130, 239, 156]),
  SwapOpened: new Uint8Array([31, 172, 136, 212, 249, 139, 42, 67]),
  SwapSettled: new Uint8Array([104, 192, 63, 194, 238, 236, 149, 85]),
  RevenueTokenRegistered: new Uint8Array([10, 214, 138, 160, 177, 211, 87, 12]),
  RevenueShareSwept: new Uint8Array([72, 98, 155, 56, 89, 44, 3, 197]),
  RevenueTokenPoolSynced: new Uint8Array([174, 77, 19, 3, 191, 201, 129, 151]),
  BuybackExecuted: new Uint8Array([150, 109, 157, 10, 124, 24, 38, 189]),
  RevenueTokenRedeemed: new Uint8Array([141, 111, 135, 82, 133, 221, 9, 69]),
  RevenueTokenConfigured: new Uint8Array([248, 253, 70, 189, 104, 149, 85, 34]),
  RevenueTokenClosed: new Uint8Array([138, 210, 233, 69, 76, 119, 152, 53]),
  TreasuryClaimed: new Uint8Array([59, 99, 64, 13, 118, 14, 251, 106]),
  HistoryInitialized: new Uint8Array([189, 138, 180, 254, 29, 103, 17, 216]),
  VoteAccountCopied: new Uint8Array([16, 56, 150, 242, 97, 105, 77, 75]),
  TipDistributionCopied: new Uint8Array([34, 84, 37, 137, 218, 93, 12, 13]),
  PriorityFeeDistributionCopied: new Uint8Array([122, 165, 146, 98, 49, 149, 120, 22]),
  StakeInfoUpdated: new Uint8Array([181, 235, 215, 27, 252, 126, 49, 81]),
  ScoreRefreshed: new Uint8Array([250, 182, 172, 112, 252, 188, 222, 234]),
  ScoringConfigured: new Uint8Array([235, 216, 69, 63, 190, 216, 94, 242]),
});

export const ACCOUNT_NAMES = Object.freeze(Object.keys(ACCOUNT_DISCRIMINATORS) as AccountName[]);
export const INSTRUCTION_NAMES = Object.freeze(Object.keys(INSTRUCTION_DISCRIMINATORS) as InstructionName[]);
export const EVENT_NAMES = Object.freeze(Object.keys(EVENT_DISCRIMINATORS) as EventName[]);

function lookup<N extends string>(table: Readonly<Record<N, Uint8Array>>): (data: Uint8Array) => N | null {
  const byKey = new Map<string, N>();
  for (const name of Object.keys(table) as N[]) byKey.set(bytesToHex(table[name]), name);
  return (data) => (data.length < 8 ? null : (byKey.get(bytesToHex(data.subarray(0, 8))) ?? null));
}

/** The account type whose discriminator starts `data`, or null. */
export const accountNameOf = lookup(ACCOUNT_DISCRIMINATORS);
/** The instruction whose discriminator starts `data` (instruction data), or null. */
export const instructionNameOf = lookup(INSTRUCTION_DISCRIMINATORS);
/** The event whose discriminator starts `data` (decoded `Program data:` payload), or null. */
export const eventNameOf = lookup(EVENT_DISCRIMINATORS);
