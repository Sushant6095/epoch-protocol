# Meteora: every call, checked against the current docs

Round 4, 7 Oct 2026, 12:20–14:10 IST, branch `feat/r4-sidetracks` (cut from main `31e3135`). Track: Meteora, best use
of DBC. Every external call Epoch makes to Meteora was checked: the DBC and DAMM v2 SDKs, the DAMM v2 data API, the
program's hand-encoded CPIs and fixed-offset account reads, the launch CLI, the three cranks and the Launch API. Each
row gives the doc line that backs the call and the test that covers it. Sources: Meteora's docs (also through the docs
MCP, `https://docs.meteora.ag/mcp`), the agent skill ([`.claude/skills/meteora/`](../../.claude/skills/meteora/SKILL.md)),
the studio CLI (`MeteoraAg/meteora-invent` `dd77ef3`), npm, and the mainnet program accounts.

**Result.** All 53 rows below (M1–M66) are backed by a doc line and a test. One logic gap was found and fixed: the
graduation gate ignored DBC's `migration_progress`. Four new test files, plus two new tests in `events.test.ts`, pin the
code to Meteora's IDLs and SDKs. Two errors in Meteora's
docs were found, and our code is right in both cases. Today's studio cross-check, on Meteora's mainnet binaries, found
our DBC config and the studio's equal in all 120 fields except two known rounding units. Both configs pass Epoch's
`check_launch_config`.

## What changed at Meteora since 6 Oct: nothing

| Source | Ours | Current (7 Oct) | Changed? |
| --- | --- | --- | --- |
| `@meteora-ag/dynamic-bonding-curve-sdk` | 1.5.13 | 1.5.13 (npm, 24 Sep) | No |
| `@meteora-ag/cp-amm-sdk` | 1.5.1 | 1.5.1 (npm, 30 Sep) | No |
| Skill and studio (`meteora-invent` `main`) | `dd77ef3` | `dd77ef3` (`git ls-remote`) | No. The skill pins DBC SDK 1.5.11 and cp-amm 1.4.5; we run the newer patch releases, and the cross-check below compares builds across that gap |
| Docs changelogs | DBC 0.2.1, cp_amm 0.2.4 | same | No new release |
| Mainnet DBC program | 0.2.1 | deployed slot 445,503,633 (9 Sep, 08:32 IST) | No |
| Mainnet DAMM v2 program | 0.2.4 | deployed slot 445,230,614 (8 Sep, 08:30 IST) | No. cp-amm SDK 1.5.1 bundles the 0.2.5 IDL; diffed against 0.2.4: only the version string differs |

So round 3's binary dumps (3 Oct) are still what mainnet runs, and the local stand-in below uses them.

## How to read the tables

Doc links point to `docs.meteora.ag`. "l. N" is the line in that page's Markdown export (`<page>.md`), saved 7 Oct
2026, 12:30 IST. A line marked "(mdx)" is the line in the page source as the docs MCP's filesystem tool serves it.
Paths are from the repo root, and `meteora/` means `packages/meteora/`. In the status column, ✓ means the code matches
the doc, and **fixed** means a gap was found and fixed this round, with the commit given.

Pages:
[DBC SDK reference](https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference) (DBC ref) ·
[DBC developer guide](https://docs.meteora.ag/developer-guides/dbc) (DBC guide) ·
[DBC program accounts](https://docs.meteora.ag/developer-guides/dbc/program/accounts) ·
[DBC accounts and permissions](https://docs.meteora.ag/core-products/dbc/accounts-and-permissions) ·
[DBC fees](https://docs.meteora.ag/core-products/dbc/fees/overview) ·
[DAMM v2 SDK reference](https://docs.meteora.ag/developer-guides/damm-v2/typescript-sdk/reference) (DAMM ref) ·
[DAMM v2 data API](https://docs.meteora.ag/developer-guides/damm-v2/api-reference/overview) ·
changelogs for [DBC](https://docs.meteora.ag/developer-guides/dbc/changelog) and
[DAMM v2](https://docs.meteora.ag/developer-guides/damm-v2/changelog).

## 1. DBC SDK 1.5.13

| # | Call | Where | Doc | Test | Status |
| --- | --- | --- | --- | --- | --- |
| M1 | `DynamicBondingCurveClient.create(connection, "confirmed")` | `meteora/src/pools.ts` | DBC ref l.125–126 | `pools.test.ts` | ✓ |
| M2 | `state.getPoolConfig` | `pools.ts`, launch CLI | DBC ref l.196 | `pools.test.ts`, `stateParity.test.ts` | ✓ |
| M3 | `state.getPool` | `pools.ts` | DBC ref l.199 | `pools.test.ts`, `migration.test.ts` | ✓ |
| M4 | `state.getPoolsByConfig` | launch CLI | DBC ref l.201 | launch CLI dry run on the stand-in (below) | ✓ |
| M5 | `buildCurveWithCustomSqrtPrices`: every config field (fees, migration option and fee, LP split, token type and authority, leftover, activation, collect mode, creator share, pool creation fee, `enableFirstSwapWithMinFee`, `migratedPoolFee`, market-cap scheduler) | `meteora/src/curve.ts` | DBC ref l.503–553; DBC fees l.99–108; DBC guide l.141–147 | `curve.test.ts`, `launchPreflight.test.ts`, studio cross-check | ✓ (docs error 1) |
| M6 | `validateConfigParameters` | `launchPreflight.ts` | DBC ref l.365 | `launchPreflight.test.ts`; PASS in today's dry run | ✓ |
| M7 | `getBaseTokenForSwap`, `getMigrationThresholdPrice`, `createSqrtPrices`, `getSqrtPriceFromPrice`, `getPriceFromSqrtPrice` | `curve.ts` | DBC ref l.239–252 | `curve.test.ts` | ✓ |
| M8 | `partner.createConfig` | `meteora/scripts/launch-revenue-token.ts` `buildLaunchTransactions` | DBC ref l.138, l.489–501 (accounts), l.571–578 (example) | sent on the stand-in today with the CLI's exact arguments (`3LpwErqt…`), then compared with the studio's config | ✓ |
| M9 | `partner.createConfigAndPool`, `createConfigAndPoolWithFirstBuy` | launch CLI | DBC ref l.140, l.142 | today's dry run built both transactions and simulated `createConfig` on the mainnet DBC binary (31,489 CU); round 3's rehearsal sent both | ✓ |
| M10 | `creator.createPool`, `createPoolWithFirstBuy` (`buyer`, `buyAmount`, `minimumAmountOut` = quote − 1%, `referralTokenAccount: null`) | launch CLI | DBC ref l.166, l.168, l.584–592 | round 3's rehearsal (`--config-account` reuse path); types checked against 1.5.13 (`CreatePoolParams`, `FirstBuyParams`) | ✓ |
| M11 | `creator.transferPoolCreator({ pool, creator, newCreator })` | launch CLI | DBC ref l.177 | round 3's rehearsal (hand-over to the validator); types checked against 1.5.13 | ✓ |
| M12 | `pool.swapQuote2` (`currentPoint`, `eligibleForFirstSwapWithMinFee`, ExactIn, PartialFill, ExactOut) | `trade.ts`, `buyback.ts` | DBC ref l.160, l.598–610 | `trade.test.ts`, `buyback.test.ts` | ✓ |
| M13 | `pool.swap2` | `trade.ts` | DBC ref l.157, l.612–620 | `trade.test.ts` | ✓ |
| M14 | `migration.migrateToDammV2` (two position-NFT signers; the SDK asks for 600,000 CU, and so does our sender) | `migration.ts`, `cranks_app/src/Launch/LaunchClaimChain.ts` | DBC ref l.190 | `LaunchMigrationJob.test.ts`, `LaunchClaimChain.test.ts`, `migration.test.ts` | ✓ |
| M15 | `migration.withdrawLeftover` | `claims.ts` | DBC ref l.185 | `claims.test.ts`, `LaunchClaimChain.test.ts` | ✓ |
| M16 | `partner.claimPartnerTradingFee` (simulation only; the crank claims through the program, M52) | `claims.ts` | DBC ref l.145 | `claims.test.ts` | ✓ |
| M17 | `partner.partnerWithdrawSurplus` | `claims.ts` | DBC ref l.148 | `claims.test.ts` | ✓ |
| M18 | `partner.partnerWithdrawMigrationFee` | `claims.ts` | DBC ref l.149 | `claims.test.ts` | ✓ |
| M19 | `creator.claimCreatorTradingFee`, `creatorWithdrawSurplus`, `creatorWithdrawMigrationFee` | `claims.ts` | DBC ref l.173, l.176, l.178 | `claims.test.ts`, `LaunchClaimChain.test.ts` | ✓ |
| M20 | `deriveDammV2PoolAddress`, `DAMM_V2_MIGRATION_FEE_ADDRESS[option]` | `pools.ts`, `migration.ts`, `buyback.ts` | DBC guide l.141–147 (the seven migration configs) | `pools.test.ts`; `migration.test.ts` derives the exact pool the rehearsal migration created | ✓ |
| M21 | `deriveDbcPoolAddress`, `deriveDbcPoolAuthority`, `deriveDbcTokenVaultAddress`, `deriveDbcEventAuthority`, `deriveMintMetadata` | launch CLI, `events.ts`, `tokenMetadata.ts` | DBC ref l.283–298 | `cpiParity.test.ts`, `tokenMetadata.test.ts` | ✓ |
| M22 | `getCurrentPoint`, `getFeeMode`, `getProtocolMigrationFee` | `trade.ts`, `buyback.ts`, `math.ts` | DBC ref l.246, l.274, l.414; DBC fees l.108 (0.2%) | `math.test.ts` | ✓ |
| M23 | IDL event decoding (`EvtSwap2` and the other 11 names `events.ts` maps) | `events.ts`, `idlCoder.ts` | DBC ref l.53 | `events.test.ts` (2 new tests: every name and field against the bundled IDLs) | **fixed** (test, `99b24b1`) |
| M24 | Pool and config reads (`poolState.*`, `isMigrated`, `migrationProgress`, `quoteReserve`, `migrationQuoteThreshold`, fees), curve progress and fee split | `pools.ts`, `claims.ts`, `migration.ts` | DBC ref l.204–206, l.210; DBC program accounts l.57 (mdx); DBC accounts and permissions l.29–33 (mdx) | `stateParity.test.ts` (against the SDK's `getPoolQuoteTokenCurveProgress` and `getPoolFeeBreakdown`), `migration.test.ts` | **fixed** (`c9a0484`, below) |

## 2. DAMM v2 SDK 1.5.1

| # | Call | Where | Doc | Test | Status |
| --- | --- | --- | --- | --- | --- |
| M30 | `new CpAmm(connection)` | `pools.ts` | DAMM ref l.109 | `pools.test.ts` | ✓ |
| M31 | `fetchPoolState` | `pools.ts` | DAMM ref l.126 | `pools.test.ts` | ✓ |
| M32 | `fetchPositionState` | `claims.ts` | DAMM ref l.129 | `claims.test.ts` | ✓ |
| M33 | `getQuote2` (`currentPoint`, `SwapMode`, `TradeDirection`, `inputTokenMint`, slippage in bps) | `trade.ts`, `buyback.ts` | DAMM ref l.157, l.507–525 | `quoteParity.test.ts` (real SDK on the rehearsal's graduated pool), `trade.test.ts`, `buyback.test.ts` | **fixed** (test, `766a91b`; docs error 2) |
| M34 | `swap2` | `trade.ts` | DAMM ref l.176, l.530–547 | `trade.test.ts` | ✓ |
| M35 | `claimPositionFee` | `claims.ts` | DAMM ref l.189 | `claims.test.ts` | ✓ |
| M36 | `derivePositionNftAccount`, `getTokenProgram`, `getUnClaimLpFee`, `getCurrentPoint`, `getFeeMode` | `claims.ts`, `trade.ts` | DAMM ref l.210, l.217, l.238 (1.5.x adds an optional `currentTime` that only projects `rewards`, which we do not read), l.296, l.446 | `claims.test.ts`, `trade.test.ts` | ✓ |
| M37 | `CpAmmIdl` event decoding (`EvtSwap2`) | `events.ts` | DAMM ref l.55, l.59, l.607 ("Prefer `EvtSwap2` for swap indexing") | `events.test.ts` (new IDL checks) | **fixed** (test, `99b24b1`) |

## 3. DAMM v2 data API (`https://damm-v2.datapi.meteora.ag`)

| # | Call | Where | Doc | Test | Status |
| --- | --- | --- | --- | --- | --- |
| M40 | `GET /pools/{address}` | `meteora/src/dataApi.ts` | data API overview l.6 (10 RPS), l.13 (base URL); OpenAPI path | `dataApi.test.ts` | ✓ |
| M41 | `GET /pools/{address}/ohlcv?timeframe=` | `dataApi.ts` | same; OpenAPI `timeframe` enum 5m–24h, `start_time`, `end_time` | `dataApi.test.ts` | ✓ |
| M42 | `GET /pools/{address}/volume/history` | `dataApi.ts` | same | `dataApi.test.ts` | ✓ |
| M43 | `GET /stats/protocol_metrics` | `dataApi.ts` | same | `dataApi.test.ts` | ✓ |

## 4. Program CPIs and account reads (`programs/epoch`, encoded by hand)

The doc for every row is the IDL Meteora bundles in the SDKs (DBC 0.2.1; cp_amm 0.2.5, identical to the 0.2.4 that
mainnet runs) plus the changelogs. Before this round nothing tied the Rust account lists and byte offsets to those IDLs,
so an SDK bump could have broken buybacks or claims only on chain. The new tests parse the Rust sources and compare.

| # | Call | Where | Test | Status |
| --- | --- | --- | --- | --- |
| M50 | DBC `swap2` (15 accounts, `SwapParameters2 { amount_0, amount_1, swap_mode }`) | `cpi/meteora.rs` `dbc_swap2_ix`, `revenue/execute_buyback.rs` | `cpiParity.test.ts`, `cpi/meteora.rs` unit tests (mainnet bytes) | **fixed** (test, `b79530f`) |
| M51 | DAMM v2 `swap2` (14 accounts) | `cpi/meteora.rs` `damm_swap2_ix` | same | **fixed** (test) |
| M52 | DBC `claim_trading_fee(max_a, max_b)` (14) | `cpi/meteora.rs`, `treasury/claim_trading_fee.rs` | same | **fixed** (test) |
| M53 | DBC `partner_withdraw_surplus` (10) | `cpi/meteora.rs`, `treasury/claim_quote.rs` | same | **fixed** (test) |
| M54 | DBC `withdraw_migration_fee(flag)` (10) | `cpi/meteora.rs`, `treasury/claim_quote.rs` | same | **fixed** (test) |
| M55 | DBC `withdraw_leftover` (10) | `cpi/meteora.rs`, `treasury/burn_leftover.rs` | same | **fixed** (test) |
| M56 | cp_amm `claim_position_fee` (15) | `cpi/meteora.rs`, `treasury/claim_lp_fee.rs` | same | **fixed** (test) |
| M57 | DBC `PoolConfig` and `VirtualPool` reads at fixed offsets, `check_launch_config` | `revenue/register.rs`, `venue.rs`, `sync_pool.rs`, `meteora_account.rs` | `layoutParity.test.ts` (77 literal reads by name and width, the curve at 408, sizes, discriminators), `meteora_account.rs` unit tests | **fixed** (test, `ca1f4d4`) |
| M58 | cp_amm `Pool` and `Position` reads | `revenue/venue.rs`, `treasury/claim_lp_fee.rs` | `layoutParity.test.ts` | **fixed** (test) |
| M59 | Program ids, event-authority PDAs, DAMM v2 migration config addresses | `constants.rs`, `cpi/meteora.rs` | `cpiParity.test.ts` | **fixed** (test) |

Both new tests were mutation-checked. Swapping two account slots in `meteora.rs` fails `cpiParity.test.ts`, and
moving one offset or changing one width fails `layoutParity.test.ts`.

## 5. Launch CLI, cranks and API

| # | Call | Where | Doc | Test | Status |
| --- | --- | --- | --- | --- | --- |
| M60 | `LaunchMigrationJob`: readiness, then `migrateToDammV2`, sent with a 600,000 CU limit | `cranks_app/src/Jobs/LaunchMigrationJob.ts`, `Launch/LaunchClaimChain.ts`, `meteora/src/migration.ts` | DBC ref l.190 and l.184 (`createLocker` "when locked vesting is configured"); DBC accounts and permissions l.29–33 (mdx); DBC program accounts l.57 (mdx). DAMM v2 needs no migration metadata (DBC ref l.186 lists it for DAMM v1 only) | `LaunchMigrationJob.test.ts`, `LaunchClaimChain.test.ts`, `migration.test.ts` (new, 8 tests) | **fixed** (`c9a0484`) |
| M61 | `LaunchFeeClaimJob`: partner trading fee, surplus, migration fee, leftover burn and LP fee, all through the program (M52–M56) | `Jobs/LaunchFeeClaimJob.ts`, `Launch/TreasuryClaims.ts` | DBC ref l.145, l.148, l.149, l.185; DAMM ref l.189 | `LaunchFeeClaimJob.test.ts`, `TreasuryClaims.test.ts`, `LaunchClaimChain.test.ts`, `cpiParity.test.ts` | ✓ |
| M62 | `BuybackJob`: `sync_revenue_token_pool`, then a quote (`swapQuote2` or `getQuote2`), then `execute_buyback` with slippage and venue | `Jobs/BuybackJob.ts`, `meteora/src/buyback.ts` | DBC ref l.160, l.598–610; DAMM ref l.157, l.507–525 | `BuybackJob.test.ts`, `buyback.test.ts`, `quoteParity.test.ts`, `cpiParity.test.ts` | ✓ |
| M63 | `GET /v1/launches` (list) and `GET /v1/launches/:mint` (detail) | `api_app/src/Routes/LaunchRouters.ts` | [`docs/pages/launch.md`](../pages/launch.md) l.112 | `LaunchService.test.ts`, `LaunchMapper.test.ts`, `LaunchRegistry.test.ts` | ✓ |
| M64 | `GET /v1/launches/:mint/page`, `market`, `trades`, `candles`, `holders`, `fees`, `indexed` | `Routes/LaunchPageRouters.ts` | `launch.md` l.100–107 (types, cache headers); data API rows M40–M43 for `indexed` | `LaunchPageRouters.test.ts`, `LaunchPageService.test.ts`, `LaunchIndexedSource.test.ts` | ✓ |
| M65 | `POST /v1/launches/:mint/quote` and `build` (`slippageBps` 1–5,000, compute budget) | `Routes/LaunchPageRouters.ts`, `meteora/src/trade.ts` | `launch.md` l.108–109, l.315–350; DBC ref l.598–620; DAMM ref l.507–547 | `LaunchPageRouters.test.ts`, `trade.test.ts` | ✓ |
| M66 | Holders: `getTokenLargestAccounts`, and `getProgramAccounts` on the token program with `dataSize: 165` and `memcmp` at offset 0 (the mint), `dataSlice` 32+40 (owner and amount) | `meteora/src/holders.ts`, `token.ts` | [Solana RPC `getProgramAccounts`](https://solana.com/docs/rpc/http/getprogramaccounts) (filters, `dataSlice`); [`getTokenLargestAccounts`](https://solana.com/docs/rpc/http/gettokenlargestaccounts) | `holders.test.ts`, `token.test.ts` | ✓ |

### The gap fixed: graduation now follows DBC's `migration_progress`

`migrationReadiness` gates the migration crank. It answered "ready" once the quote reserve reached the threshold.
Meteora's DBC accounts-and-permissions page (l.29–33) describes what happens at the threshold. A curve with locked vesting
moves to `PostBondingCurve` and waits for `create_locker`. Any other curve moves straight to `LockedVesting`, the only
state in which the DAMM pool can be created. So for a curve with vesting, the crank would have sent a `migration_damm_v2`
that fails on every run.

The gate now reads `migration_progress`. `PostBondingCurve` answers `LOCKER_REQUIRED`, which the job logs and skips.
`CreatedPool` counts as migrated. Epoch's own launches set no vesting (`curve.ts`), so they behave as before.
`migration.test.ts` runs the gate on the rehearsal's real DBC pool and config through the real SDK. Its "ready" case
derives the exact DAMM v2 pool that the rehearsal's migration created on the mainnet binary.

## 6. Two errors in Meteora's docs (our code is right in both)

1. **The DBC SDK reference (l.549) says `MigrationFee` is "required only when `migrationFeeOption` is `Customizable`".**
   The program and SDK apply it with every fee option. The config account has separate `migration_fee_option`,
   `migration_fee_percentage` and `creator_migration_fee_percentage` (DBC program accounts, l.79). The fees overview
   (l.99–108) and the formulas page (l.135–150) take the fee from the quote at graduation. Round 3's rehearsal, on the
   mainnet binary, paid the creator 70% with option 2. The sentence fits `migratedPoolFee` instead. We set
   `migrationFee` with option 2, which is right.
2. **The DAMM v2 SDK reference example (l.512–522) passes `slippage: 0.5` to `getQuote2`.** cp-amm 1.5.1 reads basis
   points (`getAmountWithSlippage(amount, slippageBps, swapMode)`, typed "1% = 100"), so 0.5 would mean 0.005%. We pass
   basis points, and `quoteParity.test.ts` pins this on the real SDK: a switch to a percent, which would zero every
   minimum, fails it.

Both are for the team to report to Meteora (t.me/meteora_dev). Nothing was sent through the MCP's `submit_feedback`.

## 7. Studio cross-check, 7 Oct 2026, 13:55–14:00 IST (local stand-in on port 58899)

Same question as round 3 ([STUDIO-CROSSCHECK.md](../meteora/STUDIO-CROSSCHECK.md)): given Epoch's preset, does
Meteora's studio build the DBC config our launch CLI builds? Commands:
[`scripts/meteora/studio-crosscheck.md`](../../scripts/meteora/studio-crosscheck.md), on port 58899.

- **Stand-in.** `solana-test-validator` 4.3.0 on RPC 58899, with Meteora's mainnet DBC, DAMM v2 and Metaplex binaries
  (round 3's dumps; sha256 prefixes `4c26a8a5da99f8ce`, `4d5b920baebc090f`, `31f0a627dba051a9`) and the seven DAMM v2
  migration configs. Throwaway keys outside the repo. The ledger was deleted afterwards.
- **Our launch CLI, dry run** (`pnpm --filter @epoch/meteora launch -- --config <rR4S> --cluster devnet --rpc
  http://127.0.0.1:58899 --revenue config --allow-unknown-genesis --skip-uri-check`, with round 3's program id, so the
  partner is round 3's treasury PDA `CNZNCChW…`). It planned `createConfigAndPoolWithFirstBuy`: `createConfig` (1
  instruction, 629 bytes) and `createPool` (7 instructions, 942 bytes, 0.02 SOL first buy). The `createConfig`
  simulation passed on the mainnet DBC binary: 31,489 CU, payer cost 0.00819496 SOL. The Meteora checks passed (programs,
  DAMM v2 migration config, `validateConfigParameters`, the `check_launch_config` mirror). The Epoch-program checks
  failed as expected, because this stand-in has no Epoch program. The planned `ConfigParameters` are byte-identical to
  round 3's.
- **Both configs on chain.** The studio's `dbc-create-config` ran as a dry run (simulated OK), then for real:
  `4Qw9M947…` created `EkURAVPk…`. The CLI's `createConfig`, with its exact arguments, ran as `3LpwErqt…` and created
  `3yrviLth…`. Both accounts are 1,048 bytes and owned by DBC.
- **Field by field** (the command sheet's `compare-configs.ts`, decoded by the DBC SDK): of 120 fields, 118 are
  identical. The two that differ are the known rounding units: `sqrtStartPrice` 1428878651784549120 (ours) against …121
  (studio's `Decimal` path), and `curve[0].liquidity` at the 18th digit. Epoch's `check_launch_config` mirror gives
  `{ ok: true, feeFloorBps: 100, maxImpactBound: 200 }` for both. This matches round 3 exactly.
- **Not re-run today:** pool creation, swaps against our `/quote`, migration and claims. Round 3 ran them (27 of 27
  agreed), and nothing they depend on has changed: same SDK pins, same studio commit, same mainnet binaries. Today's
  `migration.test.ts` and `quoteParity.test.ts` re-check the graduation and the quotes on the rehearsal's accounts.

## 8. Tests

| Command | Result |
| --- | --- |
| `pnpm --filter @epoch/meteora test` (full, after `c9a0484`) | 27 suites, 225 tests, all pass (main `31e3135`: 24 suites, 195 tests) |
| `cranks_app`: `jest LaunchMigrationJob LaunchFeeClaimJob BuybackJob src/Launch` | 5 suites, 40 tests, all pass |
| `api_app` (`TEST_DATABASE_URL=…epoch_test_r4_sidetracks`): `jest LaunchPageRouters BuybackRouters src/Services/Launch` | 17 suites, 147 tests, all pass |
| `tsc --noEmit` (`meteora`, `cranks_app`), eslint, prettier on the changed files | OK |

New tests this round: `cpiParity.test.ts` (12), `quoteParity.test.ts` (7), `layoutParity.test.ts` (13),
`events.test.ts` (+2), `migration.test.ts` (8).

## 9. Open

- Report the two docs errors to Meteora (section 6). That needs the team: we do not post anywhere ourselves.
- A launch with locked vesting would now wait in `LOCKER_REQUIRED` instead of failing. Sending `create_locker` from the
  crank is not built, because Epoch's launches have no vesting.
