# Security review: revenue tokens and treasury claims

Adversarial review of the Epoch program's revenue-token code before mainnet (5 Oct 2026). Scope:
`instructions/revenue/*` (register, sync, execute_buyback, redeem, configure, close, venue),
`instructions/treasury/*` (the five partner-treasury claims and their shared code), and the revenue-token changes to
`credit/sweep.rs`, `credit/release.rs` and `credit/update_commission.rs`, with the code they call
(`math/revenue_token.rs`, `math/amm.rs`, `math/u256.rs`, `meteora_account.rs`, `cpi/*`). Checked: account validation,
PDA seeds and bumps, signers; CPI program ids; SPL Token vs Token-2022; mint, vault and position ownership; remaining
accounts; arithmetic and rounding direction; rent, close and re-initialisation; front-running and sandwiching of
slices and claims; donation griefing and pre-funded accounts; pause coverage; upgrade compatibility.

Every finding below is fixed in the program, has a negative test, and was re-run against the real Meteora DBC and
DAMM v2 binaries on a local validator (`results-2026-10-05-r2.json`, 70 checks).

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| R-1 | High | `redeem` payout could be inflated by selling into the pool first | Fixed |
| R-2 | High | Registration accepted a DBC config whose unsold supply goes to anyone | Fixed |
| R-3 | Medium | Registration accepted graduated liquidity the creator can withdraw | Fixed |
| R-4 | Medium | The sandwich bound on buyback slices was not enforced | Fixed |
| R-5 | Medium | The pool's pause did not stop buybacks | Fixed |
| R-6 | Low | A donation to the escrow could keep a finished token open forever | Fixed |
| R-7 | Info | Identity rotation and the block revenue collector | No issue (probed) |
| R-8 | Info | The same mint can be registered by several validators | Accepted |
| R-9 | Info | `ValidatorPosition` has no reserved bytes left | Accepted |

### R-1 (High): inflatable `redeem` payout

**Where.** `instructions/revenue/redeem.rs`.

**Problem.** `redeem` paid `escrow × amount / circulating`, with circulating = supply − DBC base vault − DAMM v2 token
vault − the buyback and treasury token accounts. Pool vault balances move with trades. A holder sells part of its
tokens into the DBC curve or the DAMM v2 pool (the vault grows, circulating shrinks), redeems the rest at the inflated
rate, and buys the tokens back. A curve or constant-product round trip costs only the pool fee both ways, so whenever
the escrow is large against the pool, the extra payout exceeds the fees; the other holders pay for it. Example
(`math::revenue_token::tests::selling_into_the_pool_no_longer_inflates_a_redemption`): selling 300k of a 1M supply into
the pool raised a 100k redemption's payout by more than half.

**Fix.** Circulating supply is now the mint supply less only what Epoch's own accounts hold: the buyback token account
and, when passed, the treasury's token account (both burned by the next slice or claim). Tokens in the curve or the
pool count, because anyone can buy and redeem them. The denominator can now change only by burns and transfers into
Epoch's accounts, which are gifts to the remaining holders, never a profit. Every token redeems at the same rate
whatever the order. `redeem` no longer takes the DBC and DAMM v2 pool and vault accounts (interface change).

Consequence: the escrow's share of tokens sitting in a pool is claimable by buying those tokens. Buybacks keep running
after the term and spend the escrow; what holders still have not redeemed after the grace period becomes pool income
(R-6).

**Tests.** Rust: `selling_into_the_pool_no_longer_inflates_a_redemption`, `redeem_is_pro_rata_and_rounds_down`; SDK:
`circulating_supply` vectors; localnet: `redeem-counts-pool-tokens`, `redeem-after-a-pool-sell`,
`selling-into-the-pool-does-not-raise-the-payout` (the trader sells half its tokens into DAMM v2; the next
redemption's circulating supply is the previous one minus the first burn, and the rate per token is unchanged).

### R-2 (High): leftover receiver not checked at registration

**Where.** `instructions/revenue/register.rs`.

**Problem.** For a fixed-supply DBC config, the unsold supply left after graduation goes to the config's
`leftover_receiver` (DBC's permissionless `withdraw_leftover`). Registration checked the fee claimer but not this. A
validator could launch with itself as leftover receiver and a large leftover, receive the unsold tokens after
graduation, and sell them into the pool or redeem them against the escrow its holders paid for.

**Fix.** For a fixed-supply config, `leftover_receiver` must be the treasury PDA (`NotTreasuryLeftoverReceiver`), which
`burn_leftover` burns. A config without a fixed supply is fine: DBC burns the rest at migration.

**Tests.** Rust: `register::tests::the_leftover_must_reach_the_treasury`; SDK: `launchConfigs` vectors
(`foreign_leftover_receiver`, `not_fixed_supply_any_receiver`) through `checkLaunchConfig`; localnet:
`register-rejects-foreign-leftover-receiver` (a real DBC config with the admin as leftover receiver).

### R-3 (Medium): graduated liquidity not required to be locked

**Where.** `instructions/revenue/register.rs`.

**Problem.** DBC splits the graduated DAMM v2 liquidity between partner and creator, unlocked, vesting or permanently
locked. Registration did not look at the split. With unlocked (or vesting) creator liquidity, the creator can pull the
pool's SOL and tokens: holders lose their exit, the tokens become circulating, and buybacks then trade in a thin pool.
The mainnet config the layout tests use gives its creator 89% unlocked and 11% vesting.

**Fix.** The partner's and creator's permanently locked percentages must add up to 100 and the unlocked and vesting
ones must be zero (`LiquidityNotLocked`). Epoch's preset locks 100% with the partner.

**Tests.** Rust: `register::tests::the_graduated_liquidity_must_be_locked_forever`,
`the_real_mainnet_config_is_refused`, `meteora_account::tests::reads_a_real_graduated_dbc_pool_and_its_config` (the
new fields on real bytes); SDK: `creator_lp_unlocked`, `partner_lp_vesting`, `split_locked_lp` vectors; localnet:
`register-rejects-unlocked-liquidity` (a real config with 50% creator liquidity unlocked).

### R-4 (Medium): sandwich bound not enforced

**Where.** `instructions/revenue/execute_buyback.rs`, `register.rs`, `configure.rs`, `state/revenue_token.rs`.

**Problem.** A slice is unprofitable to sandwich only while the price move it may cause (`max_impact_bps`) is at most
twice the venue's fee: the attacker earns about the slice's move on its position and pays the fee in and out. The code
documented this assumption but did not enforce it. A config with a 0.25% curve fee, or a migrated pool at 0.1% (the
mainnet config in the tests), under the default 1% impact cap, lets a well-funded attacker front-run every slice and
pocket the difference from the escrow.

**Fix.** Registration computes the lowest fee the venues can ever charge from the DBC config: the curve's base fee
after its whole schedule (linear and exponential schedulers; the cliff for the rate limiter), and the graduated pool's
fee (fixed tiers, or a customizable pool with a fixed fee; market-cap schedulers are refused). It stores it as
`RevenueToken.fee_floor_bps` (two of the reserved bytes; the account stays 503 bytes), caps the default
`max_impact_bps` at twice it, and refuses a config whose bound would be under the 10 bps minimum
(`UnsupportedVenueFee`). `configure_revenue_token` refuses `max_impact_bps` above twice the floor
(`ImpactAboveFeeBound`). Residual assumption: Meteora's operator does not lower a live pool's fee below its config's
(DAMM v2 `update_pool_fees` is operator-only).

**Tests.** Rust: `dbc_fee_floors`, `migrated_pool_fees_and_the_impact_bound`,
`a_slice_within_the_bound_is_not_worth_sandwiching` (constant-product model: within the bound the best front-run
loses; at four times the fee it profits), `fees_too_low_or_decaying_are_refused`,
`the_impact_bound_follows_the_fee_floor`; SDK: math vectors for all five new functions, `launchConfigs`; localnet:
`register` (fee floor 100 bps, max impact 100 for Epoch's 1%/1% preset), `configure-caps-impact-at-twice-the-fee-floor`.

### R-5 (Medium): pool pause did not stop buybacks

**Where.** `instructions/revenue/execute_buyback.rs`.

**Problem.** `set_paused` is the emergency stop, but `execute_buyback` only honoured the token's own
`FLAG_BUYBACKS_PAUSED`. During an incident (a Meteora exploit, a bad pool) every token's slices kept swapping escrow
SOL until the admin flipped each token separately.

**Fix.** `execute_buyback` takes the `Pool` (`has_one = pool` on the token) and fails with `Paused`. Interface
change: a new second account. `BuybackJob` treats `Paused` as "not yet" (no attempt spent).

**Tests.** Localnet: `buyback-stops-when-the-pool-is-paused`; cranks: `waits out a paused pool without giving up the
slice`; SDK/IDL: `execute_buyback` account order.

### R-6 (Low): a donation could keep a finished token open

**Where.** `instructions/revenue/close.rs`.

**Problem.** `close_revenue_token` required the escrow to be spent down to 100,000 lamports. Anyone could send
lamports to the escrow after the holders redeemed (or once the only unredeemed tokens sat in a pool) and keep the token
open for good: the operator's rent stuck and the validator unable to register a new token.

**Fix.** After `REDEEM_GRACE_EPOCHS` (30) past the term, `close_revenue_token` closes whatever the escrow holds: the
rent returns to the operator and the rest is booked as pool income (`cash` and `income_unallocated`, like the treasury
claims). Before that, holders have the grace period to redeem. `RevenueTokenClosed` gained a trailing
`lamports_to_pool` field (old decoders ignore trailing bytes). Interface change: `close_revenue_token` takes the pool
and its vault. `BuybackJob` closes in either case.

**Tests.** Rust: `close_waits_for_the_spend_or_the_grace_period`; SDK: `revenueTokenCloseMode`; cranks: `closes a
token whose escrow still holds SOL once the redemption grace period is over`; localnet:
`close-waits-for-holders-or-the-grace-period`, then `close-after-grace-books-the-rest-as-pool-income` (epoch 41 ≥ term
end 11 + 30: 1,812,169,657 lamports to the vault, `cash` and `income_unallocated` up by exactly that, the operator
refunded 7,321,920 lamports of rent).

### R-7 (Info): identity rotation and the block revenue collector

`update_identity`'s comment said the vote program resets the block revenue collector to the new identity, which during
a revenue token's term would divert block-revenue commission from the escrow. A probe on Agave 4.3
(`vote-program-keeps-a-custom-block-collector-on-identity-change`) shows the vote program keeps a collector that is
not the identity; only a collector that was the old identity follows the new one. With the escrow as collector, an
identity change diverts nothing (`update-identity-keeps-the-escrow-as-block-collector`), and `set_collectors` stays
permissionless. The comment is corrected; no program change.

Release note from the same run: `release_validator` restores the block revenue collector to the identity, and the vote
program wants a rent-exempt collector, so a release fails while the identity account holds no SOL (a voting identity
always does).

### R-8 (Info): one mint, several registrations

Another validator can register an existing mint for its own position. That validator's share then buys back and burns
someone else's token, and holders can redeem from both escrows: a gift, not a loss. Accepted; the launch page shows the
registration that matches its registry entry.

### R-9 (Info): `ValidatorPosition` has no reserved bytes

`revenue_token` took the position's last 32 reserved bytes, and its 415-byte size is pinned by the SDK, the indexer and
deployed decoders. A later field needs an Anchor `realloc` migration. `Pool` (64) and `RevenueToken` (62) keep reserved
space.

## Checked, no issue

- **Account validation.** Every revenue-token PDA uses its stored bump with its seeds; `sweep` derives the buyback
  escrow from the token's bump; `close` checks the position's owner and discriminator before clearing its pointer. Every
  Meteora account is checked against the `RevenueToken` record or a fixed PDA (`Venue::load`, `sync_revenue_token_pool`'s
  pool address `["pool", config, max, min]` and DAMM config `pool_creator_authority`), with owner and discriminator
  checks on every read.
- **CPI program ids.** DBC, DAMM v2, SPL Token, the ATA program, System and Vote are pinned by address; the only remaining
  account (`execute_buyback`) must be the instructions sysvar.
- **SPL Token vs Token-2022.** The revenue mint and every token account it uses must be owned by SPL Token; DBC
  `pool_type` and config `token_type` must be SPL; DAMM v2 position NFTs (Token-2022) are only read.
- **Ownership.** Claims require the treasury PDA as fee claimer, leftover receiver or NFT owner; `claim_treasury_lp_fee`
  requires the position's NFT in a Token-2022 account the treasury owns.
- **Arithmetic.** Checked or saturating everywhere; `u128`/`U256` intermediates in the AMM math. Rounding favours the
  protocol: `redeem_payout` and the share round down, `min_out_floor` rounds up, slice budgets round down (the last slice
  takes the rest), the fee floor rounds down (a lower floor means a tighter impact bound).
- **Rent, close, re-init.** Anchor `init` and `create_pda_account` handle pre-funded PDAs (transfer, allocate, assign);
  the one-instruction WSOL accounts are created, used and closed within the instruction, so donations to them end up in
  the escrow or the pool; a pre-created treasury ATA is used and left open. A closed token can be registered again only
  after its escrow is gone.
- **Front-running.** Claims pay fixed accrued amounts into the pool whoever cranks them. `sync` is deterministic.
  Redemptions pay the same rate in any order (R-1). Slices: R-4. Registration of someone's mint: R-8.
- **Pause.** Stops deposit, onboard, request_advance, post_quote/open_swap, register, the five claims and (now)
  buybacks. Exits continue: withdrawals, sweeps and repayments, release, redeem, close.
- **Sweep, release, update_commission.** The share needs the recorded `RevenueToken` and its escrow (a cranker cannot
  skip or redirect it); release and commission cuts wait for the term; a senior advance keeps its claim on gross
  revenue.
- **Upgrade compatibility.** Error codes are appended; account sizes are unchanged; no mainnet deployment exists, so the
  interface changes below need no migration. Tokens registered by an earlier devnet build read `fee_floor_bps = 0`, so
  `configure_revenue_token` refuses any `max_impact_bps` until they re-register.

## Interface changes (all clients updated: epoch-sdk builders and vectors, cranks, the localnet test)

| Instruction / type | Change |
| --- | --- |
| `execute_buyback` | new account `pool` (second, read-only); fails `Paused` |
| `redeem` | removed `dbc_pool`, `dbc_base_vault`, `damm_pool`, `damm_token_vault` |
| `close_revenue_token` | new accounts `pool`, `vault` (third and fourth, writable) |
| `register_revenue_token` | same accounts; refuses more configs (R-2, R-3, R-4) |
| `configure_revenue_token` | same accounts; refuses `max_impact_bps` above twice the fee floor |
| `RevenueToken` | `fee_floor_bps: u16` before `_reserved` (now 62 bytes); 503 bytes as before |
| `RevenueTokenClosed` | trailing `lamports_to_pool: u64` |
| Errors | `LiquidityNotLocked` (6090), `UnsupportedVenueFee` (6091), `ImpactAboveFeeBound` (6092) |
| Constant | `REDEEM_GRACE_EPOCHS = 30` |
