# Epoch against Meteora's own rules: the skill audit

Round 3 (6 Oct 2026). Every rule in Meteora's agent skill ([`.claude/skills/meteora/`](../../.claude/skills/meteora/SKILL.md),
commit `dd77ef3`, MIT) that touches a DBC launch, its DAMM v2 graduation, the trades and the claims, checked against
Epoch's code. The skill was read whole. The docs MCP (`https://docs.meteora.ag/mcp`, `search` and `fs`) supplied the DBC
and DAMM v2 core-product and developer-guide pages and the DAMM v2 data-API reference. Each rule was then checked on the
round-3 localnet, which runs Meteora's mainnet binaries
([results](../runbooks/meteora-e2e-2026-10-06.json)), and against Meteora's studio CLI
([STUDIO-CROSSCHECK.md](STUDIO-CROSSCHECK.md)).

Status: **✓** followed · **gap → fixed** found in this audit and fixed in round 3 (with tests) · **N/A** does not apply,
with the reason. Paths are from the repo root; `meteora/` means `packages/meteora/`.

## SDK versions

The skill pins DBC SDK **1.5.11** and cp-amm SDK **1.4.5**, and so does the studio. Epoch runs **1.5.13** and **1.5.1**.
These are the changes in between, from the SDKs' changelogs:

| SDK | Version | Change | Effect on Epoch |
| --- | --- | --- | --- |
| DBC | 1.5.12 | Program IDL 0.2.1: new configs refuse the rate limiter and DAMM v1 (`MET_DAMM`); token badge support | None. We use a fixed fee and DAMM v2. `validateConfigParameters` (now in our preflight) refuses both. |
| DBC | 1.5.12 | `getBaseFeeParams` drops `tokenQuoteDecimal` and `activationType`; `getOrCreateATAInstruction` gains `commitment` | None. We build fees through `buildCurveWithCustomSqrtPrices`. |
| DBC | 1.5.12 | Bundled DAMM v2 IDL synced to cp_amm 0.2.4 (permission bitmask) | None for migration. The migrated pool reads the same. |
| DBC | 1.5.13 | `tokenQuoteDecimal` takes any quote decimals | None. The quote is SOL (9). |
| cp-amm | 1.4.6 | Rate limiter deprecated; `getBaseFeeParams` signature break | None. We only read and swap. |
| cp-amm | 1.4.7 | `mergePosition` fixes | None. |
| cp-amm | 1.4.8 | cp_amm 0.2.4 IDL, `ConfigPermission`; `NATIVE_MINT_2022` refused | None. |
| cp-amm | 1.4.9 / 1.4.10 | ScaledUiAmount helpers; Token-2022 deposit netting | None. SPL Token only. |
| cp-amm | 1.5.0 | cp_amm 0.2.5; Compounding allows `compoundingFeeBps` 0; `getDeadLiquidityReward`; fee and reward wrap fixes | None. Our migrated pools use the fixed-fee configs. |
| cp-amm | 1.5.1 | **Breaking:** `updateDelegatePermission` takes `position` and `positionNftAccount`; adds `getPositionsByDelegate` | None. We do not delegate positions. |

The studio cross-check ran 1.5.11 and 1.4.5 against our pins, on the same chain. The two produced the same config to
the field, except one unit of start price, and the same swap outputs to the token unit.

## 1. Launch intake contract and gates (SKILL.md "Intake", dbc.md "Launch intake contract")

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Network: ask; devnet first; mainnet behind an explicit confirmation | `meteora/scripts/launch-revenue-token.ts` (`--cluster`, genesis-hash check `checkCluster`, type-the-symbol confirmation) | ✓ | Dry run by default; `--execute` sends. Mainnet needs the symbol typed back. |
| RPC from config, never hard-coded; paid RPC on mainnet | `LAUNCH_RPC_URL`, `LAUNCH_RPC_FALLBACK_URL` (`config-sdk` `LaunchPage`/`LaunchClaims` schemas) | ✓ | The public RPCs are only defaults. The runbook asks for a paid RPC. |
| Wallet: keys from files, never printed, logged or committed | `LAUNCH_KEYPAIR_PATH`, `LAUNCH_OPERATOR_KEYPAIR_PATH`, `CRANK_KEYPAIR_PATH` (paths only) | ✓ | The CLIs print public keys only. Round 3's throwaway keys stayed in the scratch harness. |
| Funding checked before any write | `meteora/src/launchCost.ts` (`estimateLaunchCost`), `checkPayerBalance` in `meteora/src/launchPreflight.ts` | ✓ | The rehearsal measured the cost: about 0.035 SOL plus the first buy. |
| Amounts and units restated (human units vs lamports) | `meteora/src/units.ts` (exact decimal ↔ base units), the launch report (`launchReport.ts`) | ✓ | All SDK amounts are `BN` in base units. The report prints SOL and tokens. |
| Addresses the owner controls (fee claimer, leftover receiver, creator) are asked, not defaulted silently | `meteora/src/launch.ts`, `launchPreflight.ts` | ✓ (by design, fixed) | Epoch fixes the fee claimer and the leftover receiver to the treasury PDA `["treasury", pool]`, which `register_revenue_token` requires. The creator is the validator's wallet, named in the launch file. |
| Protocol params: the flow's intake contract, documented defaults for the rest | `meteora/src/curve.ts` (`revenueCurveConfig`), `constants.ts` | ✓ | Epoch's preset replaces the skill's defaults. See sections 2–5 for each departure. |
| Gate 1: dry run or simulate first | launch and register CLIs (dry run by default; register simulates the instruction), `LaunchMigrationJob` (simulates when dry run or keyless), `LAUNCH_CLAIMS_DRY_RUN` | ✓ | Round 3 also dry-ran every studio action before sending it. |
| Gate 2: mainnet only after explicit confirmation | launch CLI (type the symbol), runbook `docs/runbooks/meteora-mainnet-launch.md` | ✓ | |
| Gate 3: verify on chain after executing; never claim unverified success | launch CLI re-reads the config and pool (`partner = Epoch treasury PDA`, threshold, creator…); the crank jobs re-read before each run | ✓ | |

## 2. Curve mode and points (dbc.md "Curve shape", DBC docs "curve")

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Pick one build mode and set only its fields | `meteora/src/curve.ts`: `buildCurveWithCustomSqrtPrices` (studio mode 5) | ✓ | The revenue band (60% → 95% of the share's value per token) fixes the prices, so the custom-sqrt-price mode is the only fit. |
| 1–16 curve points, strictly increasing sqrt prices, positive liquidity | `curvePointsForBand` (2–17 sqrt prices, so 1–16 segments), `isqrt` | ✓ | Tested in `curve.test.ts`. The SDK's checks run again in `validateConfigParameters`. |
| Start sqrt price within [4295048016, 79226673521066979257578248091) | `meteora/src/launchPreflight.ts` `checkMeteoraValidation` | gap → fixed | The launch never ran the SDK's own validator. It now does, before anything is sent. Preflight row "Meteora config validation". |
| Token decimals 6–9; supply in human units | `launch.ts` (`decimals` 6–9), `curve.ts` | ✓ | Default 6, as Meteora's. |
| Graduation cost is read from the built config, not guessed | `curve.ts` (`migrationThresholdSol` from `migrationQuoteThreshold`), launch report | ✓ | The raise target is solved by scaling the leftover. The threshold printed is the config's own. |
| Leftover: tokens the curve and seed do not use; a fixed supply needs a leftover receiver | `curve.ts` (`leftover`, `fit()` pad), `launch.ts` (`leftoverReceiver` = treasury) | ✓ | The unsold supply goes to the treasury PDA, and `burn_leftover` burns it. |

## 3. Fees (dbc.md "Fees", DBC docs "Fee scheduler", "Dynamic fee", "Fee distribution")

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Base fee at least 25 bps (`MIN_FEE_BPS`) and at most 99% | `meteora/src/launch.ts` (`tradingFeeBps` 25–9,900) | ✓ | Epoch's preset is 100 bps. |
| Fee scheduler: a fixed fee is all three schedule fields 0 (mixed zeros are invalid) | `curve.ts` (`FeeSchedulerLinear`, 100→100, `numberOfPeriod: 0`, `totalDuration: 0`) | ✓ | |
| Rate limiter (`baseFeeMode` 2) deprecated for new configs (program 0.2.1) | `curve.ts` | N/A | Not used. `validateConfigParameters` would refuse it. |
| Dynamic fee: the helper adds up to 20% of the base fee (bin step 1, filter < decay, reduction ≤ 10,000) | `curve.ts` (`dynamicFeeEnabled: false`) | N/A (deliberate) | The program's impact bound rests on the fee floor (`max_impact_bps ≤ 2 × fee floor`). A flat fee keeps the floor exact and every quote reproducible. |
| Anti-sniper: a decaying start fee (scheduler) or the rate limiter | `curve.ts`, launch flow | N/A (deliberate) | The creator's first buy is in the pool-creation transaction (`createPoolWithFirstBuy`), so no window opens between creation and the first trade. Everyone after that buys on the same curve at the same 1%. |
| `collectFeeMode` 0 (quote) or 1 (output); the enum differs per SDK | `curve.ts` (`CollectFeeMode.QuoteToken` from the DBC SDK) | ✓ | Fees are in SOL, which is what the treasury pays lenders. DAMM v2's collect mode is read from the pool, never carried across SDKs. |
| Fee split: protocol 20% of the trading fee (referral 20% of that); creator share = `creatorTradingFeePercentage` of the LP fee | `meteora/src/claims.ts` (`launchClaimsFromState`), `stateParity.test.ts` | ✓ | `creatorTradingFeePercentage: 0`: all of the partner share goes to the treasury, then to lenders. The parity test matches the SDK's `getPoolFeeBreakdown` exactly. |
| Pool creation fee 0 or 0.001–100 SOL (90% partner, 10% protocol) | `curve.ts` (`poolCreationFee: 0`) | ✓ | |
| `enableFirstSwapWithMinFee` only for bundled creator buys | `curve.ts` (false) | ✓ | The bundled first buy pays the normal 1%, so every quote can pass `eligibleForFirstSwapWithMinFee: false`. |

## 4. Migration (dbc.md "Migration target", `client.migration`; DBC docs "Migration", "Migration keepers")

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| `migrationOption` 1 (DAMM v2); DAMM v1 deprecated for new configs | `curve.ts` (`MigrationOption.MET_DAMM_V2`) | ✓ | `register_revenue_token` refuses anything else. |
| `migrationFeeOption` 0–5 fixed tiers, 6 customizable (needs `migratedPoolFee`) | `launch.ts` (`dammFeeBps` 25/30/100/200/400/600 → options 0–5) | ✓ | The preset is option 2 (1%), the program's fee floor. Option 6 is not offered. |
| Migration fee up to 99% of the threshold; 0% forces a 0 creator share | `constants.ts` (`MIGRATION_FEE_PCT` 70, `CREATOR_MIGRATION_FEE_SHARE_PCT` 100) | ✓ | 70% goes to the validator as its upfront. The studio template's comment says "0% to 50%", but the SDK and program accept 70 (round 3: studio created the same config). |
| Migration quote amount = ceil(threshold × (100 − fee%) / 100) | `meteora/src/math.ts` (`dammSeedLamports`) | ✓ | |
| **Meteora takes a fixed 0.2% protocol fee on the migrated liquidity** | `math.ts` (`PROTOCOL_MIGRATION_FEE_BPS`, `dammSeedLamports`, `dammSeedSol`), `launchReport.ts` | gap → fixed | The plan and the page said the whole 30% seeded DAMM v2. They now subtract 0.2% (SDK `getProtocolMigrationFee`). Checked in `math.test.ts` against the rehearsal's deposit (within a lamport). On the r3 chain, both our pool's and the studio's seeded 0.149702 SOL out of 0.5. |
| `migrateToDammV2` returns two position-NFT keypairs that must sign | `meteora/src/migration.ts` (`buildMigrateToDammV2Tx` returns `signers`), `cranks_app/src/Launch/LaunchClaimChain.ts` (`sendMigration`) | ✓ | |
| No `createDammV2MigrationMetadata` step (removed in 1.4.6); `createLocker` only with locked vesting | `migration.ts` | ✓ | No locked vesting, so no locker. |
| Migration keepers: Meteora's mainnet keepers only migrate SOL curves whose threshold is 10 SOL (or the manual migrator) | `cranks_app/src/Jobs/LaunchMigrationJob.ts`, `launchClaims.ts`, `launch-claims.ts`; `LAUNCH_MIGRATE_ENABLED` | gap → fixed | Epoch's raises are 0.5–5 SOL. Nothing would have migrated them, and the runbook said "Meteora's migrator does it". Epoch's crank now migrates every completed curve, idempotently, before each claims pass. It graduated `rR3E` on the r3 chain (`LaunchMigrationJob.test.ts`, 4 tests). |
| DAMM v2 migration config by `migrationFeeOption` (`DAMM_V2_MIGRATION_FEE_ADDRESS[i]`) | `migration.ts` (`migrationReadiness` checks the config) | ✓ | Option 2 → `Hv8Lmzmn…`. The crank refuses a config it does not recognise. |
| Migration compute: the SDK sets 600k CU | `LaunchClaimChain.ts` (`MIGRATION_COMPUTE_UNITS`, strips the SDK's limit for the sender's) | ✓ | 144,479 CU measured. |

## 5. LP distribution (dbc.md "LP distribution"; DBC docs)

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Percentages total 100 across partner/creator × claimable/locked | `curve.ts` (partner permanent-locked 100, the rest 0) | ✓ | |
| At least 10% locked or vesting for at least a day after migration | `curve.ts` | ✓ (exceeded) | 100% is permanently locked with the treasury PDA. `register_revenue_token` requires it (`LiquidityNotLocked`), so the pool can never be drained. The preflight now checks this through the program's `check_launch_config`. |
| LP vesting at most 2 years; locked vesting optional | `curve.ts` (no vesting) | N/A | Permanent lock instead. |

## 6. Roles and every claim (dbc.md "Mental model", `client.partner` / `client.creator`; DBC docs "Fee claims")

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Partner = the config's `feeClaimer`; creator = the pool's creator | `launch.ts`, `launch-revenue-token.ts` (`transferPoolCreator` to the validator) | ✓ | Partner = the treasury PDA; creator = the validator. |
| **Leftover receiver**: fixed supply needs one; it withdraws once, after `CreatedPool` | `launchPreflight.ts` (`checkLeftoverReceiver`), `cranks_app` `burn_leftover` | gap → fixed | The preflight only warned when the receiver was not the treasury. It now **fails**, as the program refuses that config (`NotTreasuryLeftoverReceiver`). |
| Partner trading fee (`claimPartnerTradingFee`) | `cranks_app/src/Launch/TreasuryClaims.ts` (`claim_partner_trading_fee` through the program) | ✓ | The PDA cannot sign, so the Epoch program claims by CPI. On r3: 0.00641591 SOL (rR3E) and 0.004040452 SOL (the studio-built rSTU). |
| Creator trading fee | `meteora/src/claims.ts` (`claimCreatorTradingFee`) | N/A | `creatorTradingFeePercentage: 0`. |
| Surplus (partner + creator 80% of reserve − threshold, split by the creator share) | `claims.ts` (`surplusSplit`), program `claim_partner_surplus` | ✓ | Surplus is a few lamports at most: the last buy is a partial fill. |
| Migration fee: creator share (the validator's 70%) and partner share | `claims.ts` (`creatorWithdrawMigrationFee`, `partnerWithdrawMigrationFee` → program) | ✓ | The creator withdraws with its own key (simulated by the crank without one). |
| Leftover withdraw and burn | program `burn_leftover` via `LaunchFeeClaimJob` | ✓ | On r3: 917,983.00023 rR3E and 917,983.000231 rSTU burned. |
| DAMM v2 LP fees of the locked position | program `claim_treasury_lp_fee` via `LaunchFeeClaimJob` | ✓ | On r3: 0.00101914 SOL. |
| Pool creation fee claim | — | N/A | The fee is 0. |
| Who may claim: partner needs `fee_claimer`, creator the current creator; `withdraw_leftover` is permissionless but pays the receiver | crank jobs | ✓ | Studio's `dbc-claim-trading-fee` dry run confirmed it: the studio wallet (creator) is "not the launchpad fee claimer". The partner's fees can only move through the Epoch program. |

## 7. Quoting and swaps (dbc.md "quote + swap", damm-v2.md "quote + swap", SKILL.md BUILD rule 6)

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Refresh state before quoting | `meteora/src/trade.ts` (`quoteTrade` reads pool, config and clock on every quote), `buyback.ts` | ✓ | The page's 10 s market cache is for display only. Quotes and builds always read fresh. |
| `swapQuote` needs `currentPoint` (block time for timestamp activation, slot otherwise) | `trade.ts` (`currentPointOrNow`), `buyback.ts` (`pointNow`) | ✓ | |
| `eligibleForFirstSwapWithMinFee` true only for the very first swap of a config that enables it | `trade.ts`, `buyback.ts` (false) | ✓ | Our configs do not enable it. |
| `swap2` modes: ExactIn, PartialFill, ExactOut | `trade.ts` (buys PartialFill, sells ExactIn; DAMM v2 ExactIn) | ✓ | PartialFill lets the last buy complete the raise. Studio's ExactIn `swapQuote` throws "Insufficient Liquidity" there; our `/quote` caps the input instead (round-3 cross-check). |
| Pre-activation swaps fail | `trade.ts` (`currentPoint < activationPoint` → `NOT_ACTIVE`) | ✓ | |
| Token-2022 transfer-fee quote params | — | N/A | SPL Token only (the program refuses Token-2022). |
| Quotes match on-chain execution | `trade.ts`; round-3 studio cross-check | ✓ | Studio's swaps received exactly our `/quote` `amountOut`: 22,986.563809 and 37,573.636893. |

## 8. Post-graduation routing (dbc.md "Post-graduation detection")

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Detect graduation by `poolState.isMigrated`; find the DAMM v2 pool with `deriveDammV2PoolAddress(config, base, quote)` | `meteora/src/pools.ts` (`graduatedDammPool`) | ✓ | |
| A trading UI must switch venues at graduation | `trade.ts` (DBC → DAMM v2), API `market.venue` (`null` while the raise waits to migrate) | ✓ | |
| The migrated LP is position NFTs split per `liquidityDistribution` | `claims.ts` (`readDammPositions`), `/fees` `lp.positions` | ✓ | One partner position, 100% locked, owned by the treasury PDA (studio's `damm-v2-get-positions` shows none for the creator). |
| Buybacks follow the venue | `cranks_app` BuybackJob (`sync_revenue_token_pool`), `buyback.ts` | ✓ | |

## 9. Version fences (dbc.md, damm-v2.md)

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| No `new DynamicBondingCurve()` / `dbc.buy()` (never existed) | `meteora/src/pools.ts` (`DynamicBondingCurveClient`) | ✓ | |
| `createPool` is on `client.creator` (1.5.8); combos on `client.partner` | `launch-revenue-token.ts` (`client.creator.createPoolWithFirstBuy`, `client.partner.createConfig`) | ✓ | |
| Nested `buildCurve` params (1.5.3) | `curve.ts` | ✓ | |
| Nested pool fields (`pool.poolState.*`, 1.5.8) | `pools.ts`, `trade.ts` | ✓ | |
| `virtualPool` → `pool` in migration, surplus and creator-transfer params | `claims.ts`, `migration.ts` | ✓ | |
| `claim*TradingFee2` is for transfer-hook pools | `claims.ts` | ✓ | Not used. |
| `TokenType.SPLToken`, `TokenAuthorityOption`, `MAX_BASIS_POINT` | `curve.ts` | ✓ | |
| Base fee under 25 bps refused (1.4.6) | `launch.ts` | ✓ | |
| `swapQuote` with `currentPoint` and `eligibleForFirstSwapWithMinFee` (1.5.2) | `trade.ts`, `buyback.ts` | ✓ | Both use `swapQuote2`. |
| cp-amm: `new CpAmm(connection)` takes one argument; `getQuote2` needs `currentPoint` | `pools.ts` (`cpAmmClient`), `trade.ts` | ✓ | |
| cp-amm 1.5.1 `updateDelegatePermission` break | — | N/A | Not used. |

## 10. Priority fees and slippage (SKILL.md "Safety invariants", wallets-and-txs.md)

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Set a compute-unit price on every transaction | `meteora/src/trade.ts` (`buildTradeTx` → `computeBudgetInstructions`), `LAUNCH_TRADE_PRIORITY_MICROLAMPORTS` | gap → fixed | Trade transactions from `/build` had no compute budget. They now carry a 200,000-unit limit (measured: curve buy 56,900, DAMM v2 buy 37,834) and a 100,000 µlamport price by default, and `/build` reports `priorityFeeSol` (0.00002). |
| Same for the other senders | launch CLI `--priority-fee` (100,000 on mainnet), crank `TransactionSender` (`computeUnitPriceMicroLamports`), `LAUNCH_CLAIM_CU_PRICE_MICROLAMPORTS` | ✓ | |
| Compute-unit limit (implicit in the skill: a price without a limit is charged on the default) | `trade.ts` (`TRADE_COMPUTE_UNIT_LIMIT`) | ✓ | Studio sets a price only. Its swap paid 100,600 lamports of priority fee, priced on the default ~1M CU for 58,549 used. Ours would pay 20,000. |
| Slippage explicit on every swap; never 0 or unlimited | `trade.ts` (`MIN_SLIPPAGE_BPS` 1, `MAX_SLIPPAGE_BPS` 5,000), `api_app` `LaunchQuoteBodyDto` (`min(1)`) | gap → fixed | `slippageBps: 0` was accepted. It is now a 400. Buybacks: crank 100 bps under the program's 300 bps bound. |

## 11. Verification (SKILL.md "Verification")

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| Confirm the signature landed | launch and register CLIs (`Finalized`), crank `TransactionSender` | ✓ | |
| Re-read state after the write | launch CLI (config and pool checks), crank jobs (read before each run) | ✓ | |
| Report addresses, costs and next steps | launch report and registry entry (`LaunchRegistryEntry.signatures`) | ✓ | |
| Progress and fees from the SDK state service | `pools.ts` (`mapLaunchPool`), `claims.ts`, `stateParity.test.ts` | gap → fixed | Our curve progress truncated the ratio (off by up to 1e-6 against `getPoolQuoteTokenCurveProgress`). It now divides at full precision and matches the SDK to 12 digits. The fee breakdown matches `getPoolFeeBreakdown` exactly. |

## 12. Data APIs (data-and-apis.md; DAMM v2 API reference)

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| No DBC REST API: use the SDK state service | `pools.ts`, `claims.ts` | ✓ | |
| DAMM v2 REST for indexed state, candles, volume, protocol totals (`damm-v2.datapi.meteora.ag`, 10 RPS) | `meteora/src/dataApi.ts` (`DammDataApi`), `api_app/src/Services/Launch/LaunchIndexedSource.ts`, `LaunchPageService` (`market.indexed`, `GET /:mint/indexed`) | gap → fixed | Not used before. Graduated launches now get Meteora's TVL, 24 h volume and fees, locked liquidity and candles. Cached 60 s (protocol totals 5 min), so the page stays far under 10 RPS. Each read carries a freshness label. |
| REST lags a few seconds: never for pre-trade exactness | `trade.ts` | ✓ | Quotes and builds read the chain only. The indexed block is display data with its own `freshness`, and the on-chain fields never depend on it. |
| The API indexes mainnet | `LaunchLive.ts` (`launchIndexedSource`: `auto` = mainnet only) | ✓ | On devnet `indexed` is `null` and `/indexed` says why. |
| Error shapes: 404 `{"message":"Pool not found: …"}`, 400 plain text for a bad timeframe; the open volume bucket reads 0 | `dataApi.ts` (`DataApiError`, 404 → `null`, timeframe validated before the request) | ✓ | Tested with real responses (`__fixtures__/datapi/`, 6 tests). |

## 13. Universal SDK rules and safety (SKILL.md "BUILD Quick Start", "Safety invariants", "Operating rules")

| Rule | Our file(s) | Status | Fix or rationale |
| --- | --- | --- | --- |
| web3.js v1 only | all packages | ✓ | |
| Anchor 0.31 for DBC and DAMM v2; DAMM v1 isolated | `meteora/package.json` | ✓ | No DAMM v1 SDK. |
| Builders return unsigned transactions; check extra signers | `trade.ts` (unsigned, for the wallet), `migration.ts` (NFT signers), launch (config keypair) | ✓ | |
| `CollectFeeMode` differs per SDK | `curve.ts`, `pools.ts` | ✓ | |
| `BN` in base units | `units.ts` | ✓ | |
| Verify any transaction you did not assemble before signing | wallet signs `/build` output after the review; the API never signs | ✓ | `docs/pages/launch.md` asks the UI to show the reviewed `minimumOut`. |
| Devnet first, smallest amounts on first mainnet run | runbook | ✓ | |
| Secrets only in key files | all CLIs | ✓ | |

## 14. `troubleshooting.md`, case by case

| Case | Our file(s) | Status | How we handle it |
| --- | --- | --- | --- |
| `Configuration validation failed` | `launchPreflight.ts` (`checkMeteoraValidation`, `checkRegistrationConfig`) | ✓ (new) | Caught before sending, with the SDK's and the program's own checks. |
| `Insufficient SOL balance` | `checkPayerBalance`, `estimateLaunchCost` | ✓ | |
| RPC connection failed / rate limits | `ConnectionManager` failover, `retryRateLimited` | ✓ | |
| `Transaction simulation failed` | register CLI simulation; crank simulations | ✓ | Program logs are decoded into Epoch error names. One exception is listed under gaps: without a fallback RPC, `@epoch/solana` loses the logs. |
| Keypair file not found | CLIs read keys from paths and fail with the path | ✓ | |
| `bigint: Failed to load bindings` | — | ✓ | Harmless. We see it too. |
| Transfer-hook config mismatch | — | N/A | No hooks. |
| Migration action fails (threshold not reached, wrong option) | `migration.ts` (`migrationReadiness`: `CURVE_INCOMPLETE`, `ALREADY_MIGRATED`, config checks) | ✓ | |
| Hallucinated or stale SDK API | typecheck against 1.5.13 / 1.5.1 | ✓ | |
| BN or type identity across packages | one `bn.js` through the SDKs | ✓ | |
| Stale quote | fresh reads per quote | ✓ | |
| Token-2022 fee math | — | N/A | |
| `Signature verification failed` (extra signers) | config keypair; migration NFT keypairs | ✓ | |
| Only the first of several transactions lands | launch CLI sends config then pool, each confirmed (`dependsOnPrevious`) | ✓ | |
| Blockhash expired / timeout | `TransactionSender` (fresh blockhash per attempt) | ✓ | |
| Slippage error | `/quote` → review → `/build` with the reviewed `minimumOut`; the buyback crank re-quotes on every tick | ✓ | |
| Pool disabled or pre-activation | `NOT_ACTIVE` in `trade.ts` | ✓ | |
| Simulation `AccountNotFound` (unfunded payer) | balance preflight | ✓ | |

## Gaps found and fixed in round 3

1. The 0.2% protocol migration fee was missing from the DAMM v2 seed (plan, report, page). (`math.ts`, `launchReport.ts`)
2. Meteora's keepers do not migrate raises under 10 SOL, so Epoch's crank now migrates them. (`LaunchMigrationJob`)
3. A leftover receiver other than the treasury was only a warning; it now fails. (`checkLeftoverReceiver`)
4. The program's `check_launch_config` now runs in the launch and register preflights, through the SDK.
   (`checkRegistrationConfig`)
5. The SDK's own `validateConfigParameters` now runs in the launch preflight. (`checkMeteoraValidation`)
6. Trade transactions had no compute budget. They now carry a limit and a price, and report `priorityFeeSol`.
7. `slippageBps: 0` was accepted. The range is now 1–5,000.
8. Curve progress was truncated. It now matches the SDK at full precision.
9. Meteora's DAMM v2 data API is used for graduated pools, with freshness labels and the on-chain fallback kept.
10. Found by the round-3 e2e (close, then re-registration): `/buybacks` forgot a closed token's history, and the detail's
    escrow showed the next token's balance. Fixed. (`BuybackFeed.closedFeed`, `LaunchChain`, `RevenueTokenSource`)

## Program-side gaps (not edited here; for the program engineer)

- **To confirm: buybacks continue after the term.** `execute_buyback` requires the sweep only in the term. After it,
  slices keep spending the escrow, alongside redemptions, until the token closes. The crank's "close once spent"
  design suggests this is intended. On r3, rSTU's slice in epoch 74 (term 63–72) spent 19,743,847 lamports. If it is
  not intended, `require!(rt.term_active(epoch))` belongs in `execute_buyback`.
- **To confirm: pause does not cover the sweep.** `set_paused` stops buybacks, registration and the treasury claims
  (round 3 saw slices refused while paused, then run once unpaused). `sweep` has no pause check, so the share still
  reaches the escrow. That is probably right, since the validator's revenue keeps flowing. It is listed here so it is a
  decision rather than an accident.
- **Escrow PDA per vote, not per mint.** After `close_revenue_token`, a re-registration reuses `["buyback", vote]` and
  `["revenue_token", vote]`. Off-chain readers must key history by mint and slot, as the API now does.
- No new on-chain issue was found in the Meteora interface. The config checks (`check_launch_config`) accepted the
  studio-built config and our own alike (fee floor 100 bps, bound 200).

## Outside this area (reported, not fixed)

- **Solami (`@epoch/solana`):** `ConnectionManager.withFailover` wraps the primary RPC's error in
  `ChainException('RPC call failed', { cause: String(error) })` when no fallback is set, and drops the
  `SendTransactionError` logs. `TransactionSender` then retries a deterministic program error twice, and the cranks
  cannot read the Epoch error name. On r3 (pool paused), BuybackJob logged "RPC call failed" for `Paused` and gave up the
  slice for that epoch after 3 attempts, where `Paused` should wait without spending one. Fix: rethrow the original
  error when there is no fallback (`throw primaryError`), or carry `logs`.
- **Solami (`ProgramEventIngester`):** the trimmed-ledger `until` problem reported in round 2 still applies.
