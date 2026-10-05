# Revenue tokens: mainnet checklist

How to ship the revenue-token upgrade of the Epoch program (ADR 0006, with the treasury claims of its 4 Oct 2026 amendment) and the first token. Run the steps in order.

## 1. Before the upgrade

1. Deploy the new clients first: `@epoch/epoch-sdk`, then cranks_app, api_app and operator_cli built from it. The new builders pass extra trailing accounts that the current program ignores. They also mark the identity writable in `release_validator`, which the current program accepts. Old builders fail against the new program in three places: `sweep` (two new trailing accounts), `release_validator` (identity must now be writable) and `update_commission` (one trailing account). Anchor 1.2 has no `allow-missing-optionals`, so a missing trailing account is an error, not a `None`. The five treasury claims are new instructions with a new event (`TreasuryClaimed`), so they change nothing for old clients; an old indexer skips the event.
2. Run `cargo test -p epoch` and `cargo build-sbf` with the mainnet `declare_id!`. Record the `.so` hash.
3. Check the program-data size. The upgraded `epoch.so` is 950,296 bytes (the revenue-token build without the treasury claims was 820,832). If the current program-data account is smaller, run `solana program extend <PROGRAM_ID> <extra bytes>` first; space costs 6,960 lamports per byte (rent exemption is `(bytes + 128) × 6,960`).

   | What | Bytes | Lamports | SOL |
   | --- | --- | --- | --- |
   | Program data for this build (45-byte header + program) | 950,341 | 6,615,264,240 | 6.615 |
   | Extend from the 820,832-byte build | 129,464 | 901,069,440 | 0.901 |
   | Upgrade buffer (37-byte header + program), refunded when it closes | 950,333 | 6,615,208,560 | 6.615 |
   | Buffer writes, about 940 transactions at 5,000 lamports, before priority fees | – | ~4,700,000 | ~0.005 |

   A first deploy locks about 6.62 SOL in program data. An upgrade costs the extension (if any) and the write fees; the buffer's 6.62 SOL comes back.

## 2. Upgrade

1. Run `solana program deploy target/deploy/epoch.so --program-id <PROGRAM_ID> --upgrade-authority <authority>`, or write a buffer and upgrade from the multisig.
2. No migration is needed. `ValidatorPosition` keeps its 415 bytes: `revenue_token` took the 32 reserved bytes, which are zero on every existing position, so they all read "no revenue token". `Pool` and the other accounts are unchanged. `RevenueToken` accounts are new.
3. Smoke-test with simulations only: `sweep` on an existing position with the program id in both revenue-token slots, and `release_validator` simulated, not sent.

## 3. The first token

1. Partner treasury: `["treasury", pool]` under the program id (`findPartnerTreasuryPda` in the SDK). The DBC config must use it as `fee_claimer` (registration refuses any other) and as `leftover_receiver` (only then can `burn_leftover` burn the unsold supply).
2. DBC config: quote mint wrapped SOL, `migrationOption` DAMM v2, SPL token type, Epoch's preset (100 bps curve fee, DAMM v2 FixedBps100 config `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`, 100% of the graduated liquidity permanently locked with the partner, so the treasury owns the LP position). Avoid a launch fee schedule that starts high: slices fail their floor (3% below fee-free) while the pool fee is above about 2%. The crank logs that and retries.
3. Create the pool. The validator (pool creator) then signs `register_revenue_token(share_bps, term_epochs)`. Rent: 0.00439 SOL (`RevenueToken`, 503 bytes) + 0.00089 SOL (escrow) + 0.00204 SOL (token account) = 0.00732 SOL, all returned by `close_revenue_token` after the term.
4. The share starts with the next epoch's sweep.

## 4. Crank

- cranks_app with `BUYBACK_ENABLED=true`, `BUYBACK_SLIPPAGE_BPS=100`, `BUYBACK_COMPUTE_UNITS=300000` (a slice used about 94k CU on DBC and 79k on DAMM v2 against the real programs).
- The crank wallet fronts 0.00204 SOL of rent for each slice and gets it back in the same instruction, so it pays only fees. Give it the usual priority fee.
- BuybackJob also runs `sync_revenue_token_pool` after graduation and `close_revenue_token` after the term.
- DBC migration is permissionless, but someone has to send it. DBC's own keepers or the launch tooling do. While a complete curve waits for migration, slices report `VenueNotTrading`.
- Treasury claims: `LAUNCH_CLAIMS_ENABLED=true`, `LAUNCHES_PATH` (the launch registry) and `LAUNCH_CLUSTER` equal to the program's `EPOCH_CLUSTER`. `LaunchFeeClaimJob` then sends the treasury's claims (trading fees, surplus, migration fee, leftover, LP fees) as Epoch program instructions signed by the crank key, every `LAUNCH_CLAIM_INTERVAL_MINUTES`, and leaves accruing fees under `LAUNCH_CLAIM_MIN_SOL` to grow. No treasury key exists or is needed. The crank fronts up to 0.0041 SOL of rent per claim and gets it back in the same instruction. A claim used 16k–75k CU against the real programs; the job asks for 150,000. Creator claims are simulated unless the creator's key is configured.

## 5. Not in v1

- Token-2022 mints are rejected at registration, and the treasury claims only SPL Token pools quoted in wrapped SOL.
- Claimed SOL is pool income: the senior coupon is paid first and junior takes the rest. A senior-only bucket would need a new `Pool` field and a new ledger identity (ADR 0006, amendment of 4 Oct 2026).
- A completed curve's surplus is a rounding lamport on the current DBC, so `claim_partner_surplus` usually reports `NothingToClaim`.

## 6. Verify

- The sweep after registration emits `RevenueShareSwept`, and the escrow grows by exactly `gross × share_bps / 10,000`.
- `GET /v1/launches/<mint>/buybacks` shows the escrow, the schedule and then `BuybackExecuted` rows. The mint's supply drops by `tokens_burned` after each slice.
- Each treasury claim emits `TreasuryClaimed`. The pool's `cash` and `income_unallocated` grow by `lamports_to_pool` and the mint's supply drops by `tokens_burned`. The next `Accrued` event's `income` includes the claims. `GET /v1/launches/<mint>/buybacks` lists them under `treasury`; what is still unclaimed is on `GET /v1/launches/<mint>/fees`.
