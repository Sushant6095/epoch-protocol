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
| Epoch program (Anchor 1.2, 29 instructions) | Trusted code; upgrade key in a Squads multisig | Holds all funds in PDAs; pool cap, utilisation cap, junior floor, pause switch |
| Vote accounts | Native vote program | Withdraw authority is the Epoch `vote_auth` PDA; both commission collectors point at the Epoch escrow |
| Cranks (`cranks_app`) | Permissionless | Anyone can run them; every step is safe to repeat |
| Fee Index publisher (`publisher_app`) | Trusted in v1 | Bounded move per epoch, dispute window, admin veto; posts an inputs hash so anyone can recompute the value |
| Scorer | Trusted in v1 | Posts Epoch Score inputs; the formula is on-chain (`math/score.rs`) so anyone can recompute it |
| Indexer + API (`indexer_app`, `api_app`) | Read-only | Solami gRPC primary, RPC Fast failover |
| App | Untrusted UI | Wallet signs every transaction; the app holds no keys |

## Program map

| Module | Accounts (PDA seeds) | Instructions |
| --- | --- | --- |
| Pool | `Pool` [pool] · `Vault` [vault, pool] · `LenderShares` [lender, pool, owner, tranche] · `WithdrawRequest` [withdraw, pool, seq] | `initialize_pool` `update_params` `set_paused` `set_roles` `deposit` `request_withdraw` `cancel_withdraw` `process_withdrawal` `accrue` |
| Credit | `ValidatorPosition` [position, vote] · vote authority [vote_auth, vote] · escrow [escrow, vote] · `Advance` [advance, vote, seq] | `onboard_validator` `set_collectors` `update_score` `post_bond` `withdraw_bond` `request_advance` `sweep` `mark_default` `release_validator` `update_commission` `update_identity` |
| Fee Index | `FeeIndex` [fee_index, pool] | `initialize_index` `configure_index` `post_index` `finalize_index` `veto_index` |
| Fee Market | `FeeQuote` [quote, maker, epoch] · `SwapPosition` [swap, quote, taker] | `post_quote` `withdraw_quote` `open_swap` `settle_swap` |

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
3. `update_score`: the scorer posts vote credits, commission, tenure and the hedged flag; the program computes the Epoch Score (0–10,000).
4. `sweep`: withdraws everything above the floor (rent + pending delegator rewards + `vote_reserve_lamports`) into the escrow. While an advance is open, `remit_bps` of the gross goes to the vault (all of it while defaulted) and the rest to the validator's payout account. Each repayment is split pro rata between principal and fee. An epoch that sweeps nothing while an advance is open marks the position Late; revenue returning clears it.
5. `mark_default` (anyone): allowed after 3 late epochs, or once an advance outlives `max_advance_epochs`. The loss hits the bond first, then junior, then senior; later sweeps remit 100% until the advance is recovered.
6. `accrue`: realised income pays the protocol fee, then the senior coupon (`senior_rate_bps_per_epoch`), and junior keeps the residual. If income falls short of the coupon, senior takes all of it and the shortfall is not carried forward.
7. `process_withdrawal`: pays the withdrawal queue first in, first out, and never lets junior fall below `min_junior_bps` of assets.
8. Fee Index: `post_index` → dispute window → `finalize_index` (anyone), then `settle_swap` (anyone) for every swap on that epoch.

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
