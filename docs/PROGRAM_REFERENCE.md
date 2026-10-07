# Epoch program reference

Every instruction, account and event of the Anchor program in `programs/epoch` (main, 7 Oct 2026): 57 instructions,
13 accounts, 52 events, 117 errors. The IDL (`programs/epoch/idl/epoch.json`) is the machine-readable form; the SDK
(`@epoch/epoch-sdk`) has a builder for every instruction and a decoder for every account and event. How the pieces fit
together is in [ARCHITECTURE.md](ARCHITECTURE.md); the Fee Index rules are in
[FEE_INDEX_METHODOLOGY.md](FEE_INDEX_METHODOLOGY.md).

## Who signs

| Role | Key | Instructions |
| --- | --- | --- |
| Admin | `Pool.admin` (the multisig on mainnet) | pool setup and parameters, pause, roles, the Fee Index's setup, veto and operator registry, ballot reset, scoring settings, revenue-token settings |
| Scorer | `Pool.scorer` | `update_score` (the fallback), `update_stake_info` (the one oracle input to the on-chain score) |
| Publisher | `FeeIndex.publisher` | `post_index` while consensus is off |
| Fee Index operator | a key in `IndexOperators` | `cast_index_vote`; `post_index` when it is the sole operator |
| Validator operator | `ValidatorPosition.operator` (the vote account's withdrawer at onboarding) | onboarding, bonds, advances, commission and identity, release, revenue-token registration |
| Lender | the share owner | `deposit`, `request_withdraw`, `cancel_withdraw` |
| Maker / taker | any key | `post_quote`, `withdraw_quote` / `open_swap` |
| Anyone (cranker) | any key, pays the fee | every other instruction: sweeps, accrual, withdrawals, defaults, finalization, settlement, the validator-history copies and score refresh, buybacks, Meteora claims, ballot submit and close, `get_sfi` |

The pause (`set_paused`) stops deposits, onboarding, advances, quotes, swaps, revenue-token registration, buybacks and
the treasury claims. Sweeps, accrual, withdrawals, defaults and the Fee Index keep running.

## Instructions

`signers` lists the accounts that must sign; "cranker", "payer" and "taker" can be any key.

### Pool (`instructions/pool/`)

| Instruction | Args | Signers | What it does | Events |
| --- | --- | --- | --- | --- |
| `initialize_pool` | `params: PoolParams` | admin | Creates the pool and its vault with the admin, treasury and scorer roles. | PoolInitialized |
| `update_params` | `params: PoolParams` | admin | Replaces the pool's parameters (validated as at creation). | ParamsUpdated |
| `set_paused` | `paused: bool` | admin | Pauses or resumes the pool (see above). | PauseToggled |
| `set_roles` | — | admin | Rotates treasury, scorer and admin in one call. | ParamsUpdated |
| `deposit` | `tranche: Tranche`, `assets: u64` | owner | Deposits SOL into the senior or junior tranche and mints shares at the current price. | Deposited |
| `request_withdraw` | `shares: u64` | owner | Queues shares for withdrawal at the tail of the FIFO queue. | WithdrawRequested |
| `cancel_withdraw` | — | owner | Takes a queued request back. | WithdrawCancelled |
| `process_withdrawal` | — | cranker | Pays the request at the head of the queue, whole or nothing, at today's share price (a junior request that would breach the floor bounces). | WithdrawProcessed, WithdrawCancelled |
| `accrue` | — | cranker | Once per epoch: the protocol fee off realised income, the senior coupon for every epoch since the last accrual, the rest to junior. | Accrued |

### Credit (`instructions/credit/`)

| Instruction | Args | Signers | What it does | Events |
| --- | --- | --- | --- | --- |
| `onboard_validator` | — | operator, current_withdrawer | One transaction: the vote account's withdraw authority becomes Epoch's `vote_auth` PDA, and the position and escrow are created. | ValidatorOnboarded |
| `set_collectors` | — | cranker | Points both commission collectors (SIMD-0232) at the escrow. | CollectorsSet |
| `update_score` | `update: ScoreUpdate` | scorer | The scorer's score, the fallback for validators without fresh on-chain history (refused with `HistoryIsFresh` once `copy_vote_account` ran this epoch). | ScoreUpdated |
| `post_bond` | `lamports: u64` | operator | Posts SOL as a bond. | BondPosted |
| `withdraw_bond` | `lamports: u64` | operator | Takes bond back; refused while an advance is open (`BondLocked`). | BondWithdrawn |
| `request_advance` | `amount: u64` | operator | Draws an advance against trailing revenue (limit by score, hedge and pool utilisation). | AdvanceOpened |
| `sweep` | — | cranker | Once per epoch per validator: moves the commission above the reserve out of the vote account and escrow, the revenue-token share first, then the remit on an open advance, the rest to the operator's payout. | Swept, AdvanceRepaid, RevenueShareSwept |
| `mark_default` | — | cranker | Writes off an advance after `DEFAULT_AFTER_LATE_EPOCHS` epochs without revenue, or past `max_advance_epochs`: bond first, then junior. | AdvanceDefaulted |
| `release_validator` | — | operator | Leaves Epoch: hands the withdraw authority and collectors back (refused while an advance is open or a revenue token's term runs). | ValidatorReleased |
| `update_commission` | `kind: u8`, `commission_bps: u16` | operator | Changes a commission through the program, within the covenants (pool minimum, the level at origination while an advance is open, the level at registration while a revenue token's term runs). | CommissionUpdated |
| `update_identity` | — | operator, new_identity | Rotates the validator identity. | IdentityUpdated |

### Fee Index and fee market (`instructions/market/`)

| Instruction | Args | Signers | What it does | Events |
| --- | --- | --- | --- | --- |
| `initialize_index` | `dispute_window_slots: u64`, `max_move_bps: u16` | admin | Creates the FeeIndex with its publisher, dispute window and move bound. | ParamsUpdated |
| `configure_index` | `dispute_window_slots: u64`, `max_move_bps: u16` | admin | Changes the publisher, window and bound (a new publisher key turns consensus off; the registry PDA turns it back on). | ParamsUpdated |
| `post_index` | `epoch: u64`, `value: u64`, `inputs_hash: [u8; 32]` | publisher | Proposes the index for an epoch that has started on the cluster, within `max_move_bps` of the last final value. With consensus on, only the sole operator of a one-operator registry may post (registry in `remaining_accounts[0]`). | IndexProposed |
| `finalize_index` | — | cranker | After the dispute window, makes the proposal the final value and pushes the previous one into the 16-point history. | IndexFinalized |
| `veto_index` | — | admin | Drops a pending proposal (reopens its ballot under consensus). | IndexVetoed |
| `get_sfi` → `u64` | `epoch: u64` | — | The CPI read: the final value for `epoch` as return data; `IndexMissing` when it is not final or has left the history. | — |
| `initialize_index_operators` | `threshold_bps: u16`, `tolerance_bps: u16` | admin | Creates the operator registry and turns consensus on (`FeeIndex.publisher` becomes the registry PDA). | IndexOperatorsInitialized |
| `add_index_operator` | `weight: u32` | admin | Registers a voting key with a weight (total at most 10,000; 8 keys at most). | IndexOperatorAdded |
| `remove_index_operator` | — | admin | Removes a voting key, keeping the others' order. | IndexOperatorRemoved |
| `set_index_operator_weight` | `weight: u32` | admin | Changes a key's weight. | IndexOperatorWeightSet |
| `set_index_consensus` | `threshold_bps: u16`, `tolerance_bps: u16` | admin | Sets the threshold (5,001–10,000 bps of total weight) and tolerance (0–1,000 bps of the weighted median). | IndexConsensusSet |
| `cast_index_vote` | `epoch: u64`, `value: u64`, `inputs_hash: [u8; 32]` | payer, operator | Records an operator's value for a started epoch; the first vote opens the ballot (payer pays its rent); at the threshold the agreed value is proposed, or queued while the FeeIndex cannot take it. | IndexBallotOpened, IndexVoteCast, IndexConsensusReached, IndexProposed, IndexBallotSubmitted |
| `submit_index_ballot` | — | cranker | Proposes a queued consensus once the FeeIndex can take it. | IndexBallotSubmitted, IndexProposed |
| `reset_index_ballot` | — | admin | Opens a new round with a fresh registry snapshot (a stuck vote, or a queued value the admin will not let through). | IndexBallotOpened |
| `close_index_ballot` | — | cranker | Closes a ballot whose epoch is final or was passed over by a later final epoch; the rent goes to its payer. | IndexBallotClosed |
| `post_quote` | `epoch: u64`, `fixed_rate: u64`, `max_notional: u64`, `max_move_bps: u16`, `expiry_slot: u64` | maker | Posts a fixed-rate quote for a future epoch with collateral for its maximum loss. | QuotePosted |
| `withdraw_quote` | — | maker | Takes the quote and its collateral back once it expired or its epoch started and no swap is open (`QuoteNotExpired`, `QuoteHasOpenSwaps`). | QuoteWithdrawn |
| `open_swap` | `notional: u64`, `side: Side` | taker | Opens a pay-fixed or receive-fixed swap against a quote before its epoch starts, with collateral for the taker's maximum loss. | SwapOpened |
| `settle_swap` | — | cranker | Pays both sides from the final index for the swap's epoch (payoff clipped at the collateral) and closes the swap. | SwapSettled |

### Validator history and the on-chain score (`instructions/history/`)

| Instruction | Args | Signers | What it does | Events |
| --- | --- | --- | --- | --- |
| `init_validator_history` | — | payer | Creates a validator's 64-epoch history (8,352 bytes). | HistoryInitialized |
| `copy_vote_account` | — | cranker | Copies what the vote account proves: up to 64 epochs of credits with each epoch's TVC maximum, both commissions, the newest vote, the lamports and the revenue by the sweep rule. | VoteAccountCopied |
| `copy_tip_distribution_account` | `epoch: u64` | cranker | Copies the Jito MEV commission and, once the merkle root is uploaded, the epoch's `max_total_claim`; a missing account is a clean no-op. | TipDistributionCopied |
| `copy_priority_fee_distribution` | `epoch: u64` | cranker | Copies the commission on block rewards routed through Jito's priority-fee distribution and the lamports sent there. | PriorityFeeDistributionCopied |
| `update_stake_info` | `epoch: u64`, `activated_stake_lamports: u64`, `rank: u32`, `superminority: bool` | scorer | The one oracle input left: stake, rank and the superminority bit for an epoch. | StakeInfoUpdated |
| `refresh_score` | — | cranker | The Epoch Score from the history (credits, commission, delinquency, tenure, superminority) and the hedge rule from the operator's swaps in `remaining_accounts`; refuses stale history. | ScoreRefreshed, ScoreUpdated |
| `configure_scoring` | `params: ScoringParams` | admin | Creates or updates the scoring settings (market maker, credit window, reference, copy age). | ScoringConfigured |

### Revenue tokens (`instructions/revenue/`)

| Instruction | Args | Signers | What it does | Events |
| --- | --- | --- | --- | --- |
| `register_revenue_token` | `share_bps: u16`, `term_epochs: u16` | operator | Sells a share of revenue for a term as an SPL token already launched on Meteora DBC with Epoch as partner. | RevenueTokenRegistered |
| `execute_buyback` | `slice: u8`, `min_amount_out: u64` | cranker | One buyback slice on the current venue (DBC or DAMM v2): swap, check, burn. | BuybackExecuted |
| `sync_revenue_token_pool` | — | cranker | Records the DAMM v2 pool the curve graduated to, so buybacks move there. | RevenueTokenPoolSynced |
| `redeem` | `amount: u64` | holder | Burns tokens for their share of the escrow (after the term, or during it when the admin opened redemptions). | RevenueTokenRedeemed |
| `configure_revenue_token` | `params: BuybackParams` | admin | Tunes the buyback schedule and bounds, pauses buybacks, opens redemptions during the term. | RevenueTokenConfigured |
| `close_revenue_token` | — | cranker | Closes a token after its term once the escrow is spent, or after the redeem grace period (the rest becomes pool income). | RevenueTokenClosed |

### Partner treasury claims (`instructions/treasury/`)

| Instruction | Args | Signers | What it does | Events |
| --- | --- | --- | --- | --- |
| `claim_partner_trading_fee` | — | cranker | Claims the DBC partner trading fees: SOL to pool income, tokens burned. | TreasuryClaimed |
| `claim_partner_surplus` | — | cranker | Claims the partner's share of a completed curve's surplus. | TreasuryClaimed |
| `claim_partner_migration_fee` | — | cranker | Claims the partner's share of the DBC migration fee. | TreasuryClaimed |
| `burn_leftover` | — | cranker | Withdraws a graduated curve's unsold supply to the treasury and burns it. | TreasuryClaimed |
| `claim_treasury_lp_fee` | — | cranker | Claims the fees of a DAMM v2 position the treasury owns: SOL to pool income, tokens burned. | TreasuryClaimed |

## Accounts

| Account | Bytes | Seeds | What it holds |
| --- | --- | --- | --- |
| `Pool` | 374 | `["pool"]` | Parameters, roles, both tranches' assets and shares, cash, outstanding principal, bonds, the withdrawal queue's head and tail, pause flag. The vault is the system account `["vault", pool]` |
| `LenderShares` | 130 | `["lender", pool, owner, tranche]` | A lender's shares in one tranche, the shares waiting in the queue, the last deposit epoch (the junior lock counts from it), totals in and out |
| `WithdrawRequest` | 115 | `["withdraw", pool, seq]` | One queued withdrawal |
| `ValidatorPosition` | 415 | `["position", vote]` | One onboarded validator: operator, payout, score and hedge flag, bond, commissions at origination, the revenue ring of the last 10 sweeps, the open advance, the revenue-token pointer. The program's PDAs per validator: `["vote_auth", vote]` (withdraw authority), `["escrow", vote]` (collector) |
| `Advance` | 196 | `["advance", vote, seq]` | One advance: principal, fee, total due, what was repaid (principal and fee), the remit rate, opened and closed epochs, state |
| `FeeIndex` | 486 | `["fee_index", pool]` | The last final value (`epoch`, `value`, `inputs_hash`, `finalized_slot`), the 16 before it, the pending proposal, the publisher, window and move bound |
| `IndexOperators` | 406 | `["index_operators", fee_index]` | Up to 8 voting keys and weights, the threshold and tolerance |
| `IndexBallot` | 936 | `["index_ballot", fee_index, epoch]` | One epoch's vote: the round's registry snapshot, each operator's value, inputs hash, deviation and agreement, the weighted median, the consensus and whether it was proposed; the payer of its rent |
| `FeeQuote` | 151 | `["quote", maker, epoch]` | A maker's fixed-rate quote for one epoch, its capacity and collateral |
| `SwapPosition` | 133 | `["swap", quote, taker]` | A taker's side of a quote: notional, side, collateral, settlement |
| `RevenueToken` | 503 | `["revenue_token", vote]` | A validator's revenue token: mint, venue pools, share and term, buyback schedule and escrow totals. Its PDAs: `["buyback", vote]` (escrow), `["buyback_wsol", vote]`, `["buyback_tokens", vote]` |
| `ValidatorHistory` | 8,352 | `["history", vote]` | A 64-epoch ring of what the vote account and Jito's accounts proved (credits, TVC maximum, commissions, newest vote, revenue, MEV, priority fees, stake info) and the last on-chain score |
| `ScoreConfig` | 145 | `["score_config", pool]` | The scoring settings: Epoch's market maker (whose quotes count as a hedge), credit window, reference, maximum copy age |

The treasury signs Meteora claims as `["treasury", pool]` and receives SOL through `["treasury_wsol", pool]`.

## Events

Every state change emits one event (Anchor `emit!`, base64 in the logs); the indexer stores them all and the API builds
its history views from them.

| Event | Fields | Emitted by |
| --- | --- | --- |
| `PoolInitialized` | pool, admin, treasury, scorer | `initialize_pool` |
| `ParamsUpdated` | pool | `update_params`, `set_roles`, `initialize_index`, `configure_index` |
| `PauseToggled` | pool, paused | `set_paused` |
| `Deposited` | pool, owner, tranche, assets, shares, share_price_e9 | `deposit` |
| `WithdrawRequested` | pool, owner, tranche, shares, seq | `request_withdraw` |
| `WithdrawProcessed` | pool, owner, tranche, shares, assets, seq | `process_withdrawal` |
| `WithdrawCancelled` | pool, owner, seq, reason | `cancel_withdraw`, `process_withdrawal` (a bounced junior request) |
| `Accrued` | pool, epoch, income, protocol_fee, senior_gain, junior_gain, senior_price_e9, junior_price_e9 | `accrue` |
| `ValidatorOnboarded` | pool, vote, identity, operator, original_withdrawer, epoch | `onboard_validator` |
| `CollectorsSet` | vote, collector | `set_collectors` |
| `ScoreUpdated` | vote, epoch, score, hedged | `update_score`, `refresh_score` |
| `BondPosted` | vote, lamports, bond_total | `post_bond` |
| `BondWithdrawn` | vote, lamports, bond_total | `withdraw_bond` |
| `AdvanceOpened` | pool, vote, advance, seq, principal, fee, remit_bps, epoch | `request_advance` |
| `Swept` | pool, vote, epoch, from_vote, gross, remitted, to_operator | `sweep` |
| `AdvanceRepaid` | vote, advance, epoch | `sweep` |
| `AdvanceDefaulted` | pool, vote, advance, principal_lost, bond_applied, epoch | `mark_default` |
| `CommissionUpdated` | vote, kind, commission_bps | `update_commission` |
| `IdentityUpdated` | vote, new_identity | `update_identity` |
| `ValidatorReleased` | pool, vote, new_withdrawer, epoch | `release_validator` |
| `IndexProposed` | epoch, value, inputs_hash, slot | `post_index`, `cast_index_vote`, `submit_index_ballot` |
| `IndexFinalized` | epoch, value, inputs_hash, slot | `finalize_index` |
| `IndexVetoed` | epoch, value | `veto_index` |
| `IndexOperatorsInitialized` | fee_index, index_operators, threshold_bps, tolerance_bps | `initialize_index_operators` |
| `IndexOperatorAdded` | fee_index, operator, weight, total_weight, operator_count | `add_index_operator` |
| `IndexOperatorRemoved` | fee_index, operator, weight, total_weight, operator_count | `remove_index_operator` |
| `IndexOperatorWeightSet` | fee_index, operator, old_weight, weight, total_weight | `set_index_operator_weight` |
| `IndexConsensusSet` | fee_index, threshold_bps, tolerance_bps | `set_index_consensus` |
| `IndexBallotOpened` | fee_index, ballot, epoch, round, operators, total_weight, threshold_bps, tolerance_bps, reset, slot | `cast_index_vote`, `reset_index_ballot` |
| `IndexVoteCast` | fee_index, epoch, round, operator, weight, value, inputs_hash, deviation_bps, agrees, changed, late, median_value, agreeing_weight, total_weight, votes_cast, slot | `cast_index_vote` |
| `IndexConsensusReached` | fee_index, epoch, round, value, inputs_hash, agreeing_weight, total_weight, threshold_bps, votes_cast, proposed, slot | `cast_index_vote` |
| `IndexBallotSubmitted` | fee_index, epoch, round, value, slot | `submit_index_ballot`, `cast_index_vote` (a late vote retrying a queued value) |
| `IndexBallotClosed` | fee_index, epoch, round, payer, lamports | `close_index_ballot` |
| `QuotePosted` | quote, maker, epoch, fixed_rate, max_notional, max_move_bps | `post_quote` |
| `QuoteWithdrawn` | quote, maker, epoch, lamports | `withdraw_quote` |
| `SwapOpened` | quote, swap, taker, epoch, side, notional, fixed_rate, collateral | `open_swap` |
| `SwapSettled` | swap, epoch, index_value, taker_pnl | `settle_swap` |
| `HistoryInitialized` | vote, history, payer, epoch | `init_validator_history` |
| `VoteAccountCopied` | vote, epoch, slot, epoch_credits, epochs_backfilled, last_voted_slot, inflation_commission_bps, block_commission_bps, vote_lamports, revenue_lamports | `copy_vote_account` |
| `TipDistributionCopied` | vote, epoch, found, mev_commission_bps, mev_earned_lamports | `copy_tip_distribution_account` |
| `PriorityFeeDistributionCopied` | vote, epoch, found, priority_fee_commission_bps, priority_fees_lamports | `copy_priority_fee_distribution` |
| `StakeInfoUpdated` | vote, epoch, activated_stake_lamports, rank, superminority | `update_stake_info` |
| `ScoreRefreshed` | pool, vote, epoch, score, credits_ratio_bps, credits_ratio_raw_bps, commission_bps, epochs_active, delinquent, superminority, hedged, hedge_required_notional | `refresh_score` |
| `ScoringConfigured` | pool, market_maker, credits_window_epochs, count_block_commission, credits_reference_bps, max_copy_age_slots | `configure_scoring` |
| `RevenueTokenRegistered` | pool, vote, revenue_token, mint, dbc_pool, share_bps, term_epochs, start_epoch, term_end_epoch, inflation_commission_bps, block_commission_bps | `register_revenue_token` |
| `RevenueShareSwept` | vote, mint, epoch, gross, share, after_senior_advance, escrow_balance | `sweep` |
| `BuybackExecuted` | vote, mint, venue, epoch, slice, lamports_in, tokens_bought, tokens_burned, min_amount_out, fee_free_out, escrow_balance | `execute_buyback` |
| `RevenueTokenPoolSynced` | vote, mint, dbc_pool, damm_pool, damm_config | `sync_revenue_token_pool` |
| `RevenueTokenRedeemed` | vote, mint, holder, tokens_burned, lamports_out, circulating_supply, epoch | `redeem` |
| `RevenueTokenConfigured` | vote, slices_per_epoch, window_slots, max_slippage_bps, max_impact_bps, flags | `configure_revenue_token` |
| `RevenueTokenClosed` | vote, mint, total_escrowed, total_spent, total_burned, total_redeemed, lamports_to_pool | `close_revenue_token` |
| `TreasuryClaimed` | pool, kind, mint, source, position, cranker, lamports_claimed, lamports_to_pool, tokens_claimed, tokens_burned, pool_cash, income_unallocated | the five treasury claims |

## Errors

Codes are Anchor's 6000 + the variant's position in `programs/epoch/src/errors.rs`; new ones are appended, so a code
never changes meaning. The SDK's `EPOCH_ERRORS` and `parseEpochError` carry the same table.

| Codes | Area |
| --- | --- |
| 6000–6092 | pool, credit, Fee Index, market, revenue tokens, treasury claims, the security review |
| 6093–6100 | validator history and the on-chain score |
| 6101–6115 | Fee Index operator consensus |
| 6116 | `QuoteNotExpired` |
