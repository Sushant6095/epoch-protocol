# Architecture

**Core idea.** SIMD-0232 (live since 8 Sep 2026, epoch 1031) lets a vote account send its commission to a chosen collector account. Epoch holds the vote account's withdraw authority through a program address and points both collectors at an Epoch escrow. After each epoch's rewards are paid, a permissionless `sweep` moves the validator's revenue into that escrow and repays any open advance at source.

What the sweep captures today:

| Revenue | Where it lands | Captured |
| --- | --- | --- |
| Inflation commission | Escrow, through the SIMD-0232 collector | Yes |
| Jito MEV commission | Vote account, claimed at epoch end | Yes, swept out of the vote account |
| Block fees | Identity account | No. SIMD-0123 is not live, so block fees are a covenant (no identity change while an advance is open), not collateral |

Diagrams of everything on this page, with Mermaid sources and an Excalidraw prompt: [`docs/diagrams/`](diagrams/).

## Components

| Component | Trust | Notes |
| --- | --- | --- |
| Epoch program (Anchor 1.2, 47 instructions) | Trusted code; upgrade key in a Squads multisig | Holds all funds in PDAs; pool cap, utilisation cap, junior floor, pause switch |
| Vote accounts | Native vote program | Withdraw authority is the Epoch `vote_auth` PDA; both commission collectors point at the Epoch escrow |
| Cranks (`cranks_app`) | Permissionless | Anyone can run them; every step is safe to repeat |
| Fee Index publisher (`publisher_app`) | Trusted in v1 | Bounded move per epoch, dispute window, admin veto; posts an inputs hash so anyone can recompute the value |
| Scorer | Trusted for stake only | Posts each validator's activated stake, rank and superminority bit (`update_stake_info`); every other score input is read on chain (see [Validator history and the score](#validator-history-and-the-score)). `update_score` remains the fallback for validators without fresh history |
| Indexer + API (`indexer_app`, `api_app`) | Read-only | Solami gRPC primary, RPC Fast failover |
| App | Untrusted UI | Wallet signs every transaction; the app holds no keys |

## Program map

| Module | Accounts (PDA seeds) | Instructions |
| --- | --- | --- |
| Pool | `Pool` [pool] · `Vault` [vault, pool] · `LenderShares` [lender, pool, owner, tranche] · `WithdrawRequest` [withdraw, pool, seq] | `initialize_pool` `update_params` `set_paused` `set_roles` `deposit` `request_withdraw` `cancel_withdraw` `process_withdrawal` `accrue` |
| Credit | `ValidatorPosition` [position, vote] · vote authority [vote_auth, vote] · escrow [escrow, vote] · `Advance` [advance, vote, seq] | `onboard_validator` `set_collectors` `update_score` `post_bond` `withdraw_bond` `request_advance` `sweep` `mark_default` `release_validator` `update_commission` `update_identity` |
| Fee Index | `FeeIndex` [fee_index, pool] | `initialize_index` `configure_index` `post_index` `finalize_index` `veto_index` |
| Fee Market | `FeeQuote` [quote, maker, epoch] · `SwapPosition` [swap, quote, taker] | `post_quote` `withdraw_quote` `open_swap` `settle_swap` |
| History | `ValidatorHistory` [history, vote] (zero-copy, 64 epochs) · `ScoreConfig` [score_config, pool] | `init_validator_history` `copy_vote_account` `copy_tip_distribution_account` `copy_priority_fee_distribution` `update_stake_info` `refresh_score` `configure_scoring` |

Vote-program calls (Authorize, Withdraw, UpdateCommissionCollector, UpdateCommissionBps, UpdateValidatorIdentity) are encoded by hand and byte-checked against the official crate in tests.

## Onboarding

The app sends `onboard_validator`, `set_collectors` and `post_bond` in one transaction:

1. The current withdraw authority signs once; the `vote_auth` PDA becomes the withdraw authority and the position and escrow are created.
2. Both commission collectors are pointed at the escrow (kept as a separate instruction because SIMD-0232 is gated on some clusters).
3. The bond moves into the vault.

`release_validator` reverses all three, and only when nothing is owed.

## Every epoch (~432,000 slots)

1. Stake rewards finish paying out. `sweep` refuses to run until the EpochRewards sysvar says distribution is over.
2. The validator's Jito MEV commission is claimed from Jito's tip distribution program into the vote account (`ClaimMevJob` in `cranks_app` makes sure it happens).
3. Validator history and the score: anyone copies the vote account and Jito's accounts into the validator's `ValidatorHistory` (before the sweep, so it sees the epoch's revenue), the scorer posts the stake information, and anyone runs `refresh_score`, which computes the Epoch Score (0–10,000) from the history and the hedge from the validator's swaps. `update_score` (scorer-posted inputs) is only for validators without fresh history.
4. `sweep`: withdraws everything above the floor (rent + pending delegator rewards + `vote_reserve_lamports`) into the escrow. While an advance is open, `remit_bps` of the gross goes to the vault (all of it while defaulted) and the rest to the validator's payout account. Each repayment is split pro rata between principal and fee. An epoch that sweeps nothing while an advance is open marks the position Late; revenue returning clears it.
5. `mark_default` (anyone): allowed after 3 late epochs, or once an advance outlives `max_advance_epochs`. The loss hits the bond first, then junior, then senior; later sweeps remit 100% until the advance is recovered.
6. `accrue`: realised income pays the protocol fee, then the senior coupon (`senior_rate_bps_per_epoch`), and junior keeps the residual. If income falls short of the coupon, senior takes all of it and the shortfall is not carried forward.
7. `process_withdrawal`: pays the withdrawal queue first in, first out, and never lets junior fall below `min_junior_bps` of assets.
8. Fee Index: `post_index` → dispute window → `finalize_index` (anyone), then `settle_swap` (anyone) for every swap on that epoch.

## Validator history and the score

The Epoch Score no longer trusts the scorer for what the chain can prove. Each validator has a `ValidatorHistory`
(PDA `["history", vote]`, 8,352 bytes, ~0.059 SOL, created by anyone): 64 per-epoch entries indexed by `epoch % 64`,
each starting at an all-ones "unknown" sentinel. Adapted from Jito stakenet's `validator-history` program; see
`THIRD-PARTY-NOTICES.md`.

| Input | Source | Who can write it |
| --- | --- | --- |
| Vote credits per epoch (up to 64 epochs back) and the newest voted slot | the vote account (`copy_vote_account`, every supported vote-state version) | anyone |
| Maximum possible credits | slots in the epoch × 16 (timely vote credits), from the EpochSchedule sysvar | anyone |
| Inflation and block-revenue commission | the vote account | anyone |
| Vote-account lamports and revenue | the vote account and Epoch's escrow, by the sweep rule (pending delegator rewards excluded) | anyone |
| Jito MEV commission and the epoch's tips (`max_total_claim`) | the tip-distribution account, owner and PDA checked; a clean no-op where it does not exist (devnet) | anyone |
| Priority-fee distribution commission and lamports | Jito's priority-fee distribution account, same checks | anyone |
| Activated stake, stake rank, superminority | **oracle**: `update_stake_info`, signed by the pool's `scorer` | scorer |
| Hedged | the validator's swaps, which `refresh_score` derives and reads itself | anyone |

`refresh_score` (permissionless) builds the inputs of the unchanged formula (`math/score.rs`):

- credits: Σ credits ÷ Σ maximum over the last `credits_window_epochs` (10) finished epochs, rescaled so that
  `credits_reference_bps` (9,950: mainnet's mean was 99.4–99.6% of the maximum in epochs 1048–1050) reads as the
  cluster average;
- commission: the highest inflation or MEV commission (and block-revenue commission once SIMD-0123 makes it binding,
  `count_block_commission`) over the window and the current epoch, so a one-epoch drop does not hide a recent rug;
- delinquent: the newest vote more than 128 slots behind the copy;
- tenure: the longer of the vote account's epochs with credits and the epochs since onboarding;
- superminority: the scorer's bit for the current epoch;
- hedged: unsettled receive-fixed notional against `ScoreConfig.market_maker`'s quote on each of the next 5 epochs ≥
  half the average revenue. The program derives the five swap addresses itself, so nobody can leave a hedge out.

It refuses stale history: no vote-account copy this epoch, one older than `max_copy_age_slots`, or no stake
information for this epoch. `update_score` refuses once a validator's history holds a vote copy from this epoch, so the
scorer cannot overwrite a score the chain computes. History revenue reaches the credit limit only through the hedge
requirement, which takes the larger of the position's and the history's average revenue: stale or missing history can
lower a limit, never raise it.

**Still oracle-signed, and why.** Activated stake needs every stake account delegated to the validator, and rank and
superminority need every validator's stake; no single account proves them and reading them on chain does not fit a
transaction. They are bounded to the history's 64 epochs, signed by the existing `scorer` role, and can only move a
score between uncapped and the superminority cap (5,000). `cranks_app`'s `HistoryJob` does the copies, the stake
posts and the refresh every epoch; `scripts/e2e/history-to-advance.mts` runs the whole flow on a local validator.
Anyone can check the result: `GET /v1/validators/:vote/history` serves the decoded account with its freshness,
`GET /v1/validators/:vote/position` says whether the score came from the history or the scorer (`scoreBreakdown`), and
the `activity` stream shows the copies, stake posts and refreshes (kind `score`).

## Credit limit

`limit = min(trailing 10-epoch revenue × advance_bps, bond × bond_multiplier, max_advance_lamports)`

- `advance_bps` is `advance_bps_hedged` when the validator holds a Fee Market hedge, else `advance_bps_unhedged`.
- A `bond_multiplier` of 0 turns the bond cap off.
- Zero until the validator has 3 epochs of swept revenue.
- `request_advance` also needs: position Active, no open advance, a score of at least `min_score` that is younger than `score_ttl_epochs`, an amount of at least `min_advance_lamports`, utilisation within `max_utilization_bps`, and free cash not owed to queued withdrawals.
- Repayment is a flat fee (`fee_bps` of principal), not interest.

## States

- **Position:** Active → Late when an epoch sweeps nothing with an advance open, and back to Active when revenue resumes. Active or Late → Defaulted through `mark_default`; Defaulted → Active once recoveries pay the advance in full. Active → Released is terminal.
- **Advance:** Open → Repaid, or Open → Defaulted → Repaid if recoveries cover it in full. A defaulted advance still counts as open, so the covenants below stay on until it is recovered.
- **While an advance is open:** commission can't go below its level at origination, the identity can't change, the bond can't be withdrawn and the validator can't be released. Inflation commission can never go below `min_commission_bps` while onboarded.

## Invariants (checked after every instruction)

1. `senior_assets + junior_assets + income_unallocated = cash + outstanding_principal`
2. The vault holds at least `cash + bond_total + rent`.
3. A sweep never takes a vote account below rent + pending delegator rewards + reserve.
4. Rounding always favours the pool.

## Fee Index and fee swaps

- The index is the stake-weighted median priority fee per epoch (micro-lamports per compute unit), computed off-chain by `indexer_app` and posted by `publisher_app` with a hash of its inputs.
- A proposal that moves more than `max_move_bps` from the last final value is rejected. Inside the dispute window the admin multisig can `veto_index`; after it anyone can `finalize_index`. The last 16 final values stay on-chain.
- Makers `post_quote` a fixed rate for a future epoch with collateral = max notional × `max_move_bps`. Takers `open_swap` (pay-fixed or receive-fixed) until that epoch starts.
- `settle_swap` pays `notional × (index − fixed) ÷ fixed`, clipped to ± the maximum loss, so settlement can never run short of funds.
- Switchboard shut down on 25 Sep 2026, so the program is its own oracle; there is no external mirror.
