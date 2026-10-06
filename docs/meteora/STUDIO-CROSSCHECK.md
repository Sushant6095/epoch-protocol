# Studio cross-check: Epoch's launch against Meteora's own CLI

Round 3, 6 Oct 2026, 01:35–01:45 IST. The question was whether Meteora's studio CLI (`meteora-invent/studio`), given
Epoch's launch preset, builds the same DBC config Epoch's launch CLI builds, and whether our API's quotes, fees and
progress agree with what the studio does and reports. Everything ran on the round-3 localnet: `solana-test-validator`
with Meteora's mainnet DBC, DAMM v2 and Metaplex binaries and the round-3 Epoch program. The studio wallet was a
throwaway localnet key (`8nid7A35…`), and nothing touched mainnet.

Result: **27 of 27 comparisons agree**
([`studio-crosscheck-2026-10-06.json`](studio-crosscheck-2026-10-06.json)). There is one 1-unit rounding difference in
the start price, explained below. Commands: [`scripts/meteora/studio-crosscheck.md`](../../scripts/meteora/studio-crosscheck.md).

## Setup

| | Studio | Epoch |
| --- | --- | --- |
| Code | `MeteoraAg/meteora-invent` `dd77ef3`, `studio/` | `feat/r3-meteora`: `packages/meteora/scripts/launch-revenue-token.ts` |
| SDKs | DBC 1.5.11, cp-amm 1.4.5 | DBC 1.5.13, cp-amm 1.5.1 |
| Config | `studio/config/dbc_config.jsonc`, edited to Epoch's preset | `revenueCurveConfig` (`packages/meteora/src/curve.ts`) from `launch.json` |
| Launch | `rSTU`, mint `7M3xZjTX…`, config `RMasYVFR…`, pool `EnJsEeTK…` | `rR3E`, mint `8VnLEEgA…`, config `6ebZFQ68…`, pool `DSdtEHjG…` |

The preset as studio input (the full file is in the command sheet):

```jsonc
"buildCurveMode": 5,                        // buildCurveWithCustomSqrtPrices, as Epoch's CLI
"prices": [0.000006, 0.0000095],            // the revenue band: 60% → 95% of the share's value per token
"token": { "totalTokenSupply": 1000000, "tokenBaseDecimal": 6, "tokenQuoteDecimal": 9, "tokenType": 0,
           "tokenAuthorityOption": 1, "leftover": 917983 },
"fee": { "baseFeeParams": { "baseFeeMode": 0, "feeSchedulerParam": { "startingFeeBps": 100, "endingFeeBps": 100,
         "numberOfPeriod": 0, "totalDuration": 0 } }, "dynamicFeeEnabled": false, "collectFeeMode": 0,
         "creatorTradingFeePercentage": 0, "poolCreationFee": 0, "enableFirstSwapWithMinFee": false },
"migration": { "migrationOption": 1, "migrationFeeOption": 2, "migrationFee": { "feePercentage": 70, "creatorFeePercentage": 100 } },
"liquidityDistribution": { "partnerPermanentLockedLiquidityPercentage": 100, "partnerLiquidityPercentage": 0,
                           "creatorLiquidityPercentage": 0, "creatorPermanentLockedLiquidityPercentage": 0 },
"activationType": 1,
"leftoverReceiver": "CNZNCChW34nbLnrJy5YfQbZNytnkBNUFg3HvN7DPdXsA",   // the Epoch treasury PDA
"feeClaimer": "CNZNCChW34nbLnrJy5YfQbZNytnkBNUFg3HvN7DPdXsA"
```

## What ran

Every action was dry-run first (`"dryRun": true`); each simulation passed before the real send.

| Step | Tool | Signature | Result |
| --- | --- | --- | --- |
| Create the config | studio `dbc-create-config` | `4EntU1AS…oNeDT` | `RMasYVFR…`, threshold 500,005,536 lamports (ours too) |
| Create the pool | studio `dbc-create-pool --config` | `28HMPApC…jCwU1` | mint `7M3xZjTX…`, pool `EnJsEeTK…` |
| **Register it with Epoch** | our `register-revenue-token.ts` (operator key) | `5m3dNKcd…c9ZZah` | Preflight "Registration checks PASS: check_launch_config passes: fee floor 100 bps …"; the program accepted it (term 63–72) |
| Allow redemption in term | `configure_revenue_token` flags 2 | `58x6f9hc…PRKQp` | used for the redeem check |
| Buy 0.15 SOL | our `/quote`, then studio `dbc-swap` | `38JrDdwv…dLmup8` | received **22,986.563809**; `/quote` said **22,986.563809** |
| Buy past the threshold (0.315470133 SOL) | studio `dbc-swap` (dry) | — | the SDK's `swapQuote` threw `Insufficient Liquidity`; our `/quote` capped the input at 0.314470133 |
| Buy 0.314470133 SOL (completes the curve) | studio `dbc-swap` | `55jrKdmE…tDipj45Q` | received **37,573.636893**; `/quote` said **37,573.636893** |
| Status | studio `dbc-get-status` | — | reserve 500,005,537 / threshold 500,005,536, 100.00%, partner fees 4,040,452 |
| Migrate | studio `dbc-migrate-to-damm-v2` | `4skt5B62…Q5Upt9` | DAMM v2 pool `CYxNoLcZ…`, seeded 0.149702 SOL (`dammSeedSol`) |
| Positions | studio `damm-v2-get-positions` | — | none for the studio wallet: the only position is the treasury's, 100% locked |
| Claim trading fees | studio `dbc-claim-trading-fee` (dry) | — | "Is creator: true · Is partner: false · This is not the launchpad fee claimer": the treasury PDA cannot sign outside the program |
| Treasury claims | our `launch-claims --once` | `2TVQjX3S…` (trading fee), `4HrtHcBU…` (leftover) | 0.004040452 SOL to the pool; 917,983.000231 rSTU burned |

## The configs, field by field

The DBC SDK decoded both config accounts: 120 fields compared, **118 identical**.

| Field | Epoch (`6ebZFQ68…`) | Studio (`RMasYVFR…`) |
| --- | --- | --- |
| `sqrtStartPrice` | 1428878651784549120 | 1428878651784549**121** |
| `curve[0].liquidity` | 460982943221986947540000000000 | 460982943221986949040000000000 |
| `migrationQuoteThreshold` | 500005536 | 500005536 |
| `swapBaseAmount` | 66227351178 | 66227351178 |
| `migrationBaseThreshold` | 15789648594 | 15789648594 |
| `migrationSqrtPrice` | 1797966206465980980 | 1797966206465980980 |
| `curve[0].sqrtPrice` | 1797966208177705269 | 1797966208177705269 |
| fees (`cliffFeeNumerator`, dynamic fee) | 10,000,000 (1%), off | same |
| migration (option, fee option, fee %, creator %) | 1, 2, 70, 100 | same |
| LP (partner locked, the rest) | 100, 0 | same |
| fee claimer, leftover receiver, quote mint | treasury PDA ×2, SOL | same |
| Epoch's `check_launch_config` (SDK mirror) | ok, floor 100 bps, bound 200 | ok, floor 100 bps, bound 200 |

The one difference is rounding. Epoch's `priceToSqrtPriceX64` takes the exact integer square root (floor) of the price
in Q128. The studio's `getSqrtPriceFromPrice` goes through `Decimal` and lands one unit higher, a relative 7e-19 of the
square root. The curve's liquidity follows in its 18th digit. Thresholds, amounts, the migration price and every fee are
identical, and so were both swaps' outputs. No change: floor rounding is the conservative side. A one-unit difference
cannot change a quote by a base unit of the token.

## Our API against the studio

| What | Studio | Epoch API | |
| --- | --- | --- | --- |
| Tokens for 0.15 SOL | 22,986.563809 received | `/quote` `amountOut` 22,986.563809 | equal |
| Tokens for the curve-completing buy | 37,573.636893 received | `/quote` 37,573.636893 (input capped at 0.314470133) | equal |
| Quote reserve after the first buy | 148,500,000 | `/market` `liquiditySol` 0.1485 | equal |
| Partner fees unclaimed after the first buy | 1,200,000 | `/fees` `partner.tradingFeesSol.unclaimed` 0.0012 | equal |
| Progress after the first buy | 29.70% | 148,500,000 / 500,005,536 = 29.6997% (same formula, parity-tested against the SDK's `getPoolQuoteTokenCurveProgress`) | equal |
| Partner fees unclaimed at completion | 4,040,452 | 0.004040452 | equal |
| State at completion | 100.00%, not migrated | `graduation.state` `complete`, `venue` null | equal |
| Creator migration fee (validator upfront) | — | 0.350003875 = 70% of the threshold | as configured |
| DAMM v2 seed | (migration) | `liquiditySol` 0.149702 = 30% less the 0.2% protocol fee | equal to `dammSeedSol` |
| LP | no position for the creator | one partner position, 100% locked, owner the treasury PDA | consistent |

## Findings

1. **The preset reproduces exactly**, so the launch CLI and Meteora's reference tooling agree on what Epoch's config
   means. The program accepted the studio-built config through our own register script, so Epoch could also accept
   launches made with Meteora's tools when their config has the treasury as fee claimer and leftover receiver.
2. **Curve completion:** the studio's ExactIn swap cannot complete the curve with a rounded-up amount; it has to be
   given the exact remainder. Epoch's `/quote` and `/build` use `swap2` PartialFill for buys, so the last buyer can ask
   for more and pays only what the threshold needs. Keep it.
3. **Priority fees:** studio sets a compute-unit price without a limit, so its first swap paid 100,600 lamports of
   priority fee: the price on the default limit (≈ 1,006,000 CU) for 58,549 CU used. Epoch's trade transactions now set
   a 200,000-unit limit, so the same price costs 20,000 lamports. This confirms the round-3 trade fix.
4. **Docs drift in Meteora's tooling** (not ours to fix):
   - the studio template says the migration fee is "0% to 50%", but 70% is accepted by the SDK and the program;
   - the skill's `damm-v2.md` says there is no studio swap, while `studio-actions.md` lists `damm-v2-swap`;
   - `dbc-get-status` does not print the graduated DAMM v2 pool (our API's `graduation.dammPool` gave it).
5. **What only Epoch can do:** register the token with the program, claim the treasury's partner fees and LP fees, and
   burn the leftover. The fee claimer is a PDA, so studio's claim actions stop at the creator path, as designed.

No discrepancy needed a code change. The round-3 fixes the cross-check confirms are the DAMM v2 seed (0.2% protocol
fee), the compute-unit limit and progress precision.
