# @epoch/meteora

Helpers for Epoch's validator revenue tokens on Meteora ([ADR 0006](../../docs/adr/0006-revenue-tokens-on-meteora.md),
plan F13): a validator sells a fixed share of its commission for a fixed term as a token on a Meteora Dynamic Bonding
Curve (DBC), with Epoch as the DBC partner; at the raise target the token graduates to a DAMM v2 pool. This package
reads those pools, quotes and builds trades for the Launch page (request #23), builds the revenue-anchored curve for the
launch script (request #24, [scripts/README.md](scripts/README.md)) and holds the spec's math. It wraps the official
SDKs, `@meteora-ag/dynamic-bonding-curve-sdk` and `@meteora-ag/cp-amm-sdk` (DAMM v2).

```ts
import { Connection, PublicKey } from '@solana/web3.js';
import { buildTradeTx, quoteTrade, readLaunchPool } from '@epoch/meteora';

const connection = new Connection(process.env.NEXT_PUBLIC_EPOCH_RPC_URL!); // devnet
const launch = { dbcPool, dbcConfig, dammPool, mint, decimals: 6 }; // from GET /v1/launches/:mint

const quote = await quoteTrade({ connection, launch, side: 'buy', amount: 0.5 }); // LaunchTradeQuote, 1% slippage
const tx = await buildTradeTx({
  connection,
  launch,
  side: 'buy',
  amount: 0.5,
  owner: wallet.publicKey,
  minimumOut: quote.minimumOut,
});
const signature = await wallet.sendTransaction(tx, connection); // blockhash, lastValidBlockHeight and fee payer are set

const curve = await readLaunchPool({ connection, dbcPool }); // price, raise progress, graduation, fees
```

## Design rules

- **Browser-safe.** No Node built-ins, no `process`, no `Buffer` identifier, no `@epoch/*` imports in `src`
  (`index.test.ts` enforces it). It runs wherever `@solana/web3.js` and the Meteora SDKs run (they need the usual
  `Buffer` polyfill in a browser bundle, nothing more). The launch script in `scripts/` is the only Node code.
- **Units in names.** Every amount out of this package is a UI number (`…Sol`, tokens, `…Pct`); amounts going into a
  transaction are converted exactly (`toBaseUnits` parses the decimal string, so 0.1 SOL is exactly 100,000,000
  lamports).
- **Few RPC reads.** `readLaunchPool` reads the pool and its config (one round trip when the config is known);
  `readDammPool` the pool, then its vaults and mints in one call; a quote adds the clock. One SDK client per connection.
- **Typed failures.** Trades throw `LaunchTradeError` with a `code`: `NOT_LAUNCHED`, `NOT_OPEN`, `CURVE_COMPLETE`
  (the raise is full and the token waits to graduate), `NOT_TRADING`, `AMOUNT_TOO_SMALL`, `INSUFFICIENT_LIQUIDITY`,
  `WRONG_TOKEN`.

## What is exported

| Area          | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pool reads    | `readLaunchPool({ connection, dbcPool, dbcConfig? })` → `LaunchPoolState` (reserves, price in SOL per token, `curveProgressPct` = quote reserve ÷ `migrationQuoteThreshold` like `getPoolQuoteTokenCurveProgress`, threshold, `curveComplete`, `migrated`, `dammPool` after migration, migration fee split, locked LP, partner/creator trading fees as `getPoolFeeBreakdown` splits them, fixed supply) · `readDammPool({ connection, pool })` → `DammPoolState` (price, vault reserves, oriented token vs SOL) · `readCurveAccounts`, `graduatedDammPool`, `mapLaunchPool`, `mapDammPool`, `dbcClient`, `cpAmmClient` |
| Trades        | `quoteTrade({ connection, launch, side, amount, slippageBps = 100 })` → `LaunchTradeQuote` · `buildTradeTx({ …, owner, minimumOut? })` → unsigned `Transaction` · `toTradeQuote`, `dbcSwapAmounts`, `dammSwapAmounts` (pure) · `LaunchTradeError`                                                                                                                                                                                                                                                                                                                                                                      |
| Curve         | `curvePointsForBand({ bandLowSol, bandHighSol, baseDecimals, points? })` → sqrt prices for `buildCurveWithCustomSqrtPrices` · `revenueCurveConfig(…)` → Epoch's DBC config (the partner preset) · `priceToSqrtPriceX64`, `sqrtPriceX64ToPrice`, `isqrt`                                                                                                                                                                                                                                                                                                                                                                |
| Math          | `launchBand`, `curveBand`, `shareRevenuePerEpochSol`, `shareValueSol`, `marketCapSol`, `impliedYieldPctPerEpoch`, `backingRatio`, `epochsLeft`, `endEpochOf`, `upfrontToValidatorSol`, `dammSeedSol`, `averageRevenueSol`                                                                                                                                                                                                                                                                                                                                                                                              |
| Tokens        | `readTokenMint` (supply, decimals, mint authority, token program), `countTokenHolders` (one filtered `getProgramAccounts`), `decodeMintAccount`, `tallyHolders`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Launch script | `parseLaunchConfig`, `planLaunch`, `registryEntryFor`, `appendRegistryEntry`, `LaunchRegistryEntry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Units         | `toBaseUnits`, `fromBaseUnits`, `parseDecimal`, `toBN`, `toBigInt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Events        | `normalizeTransaction` (a raw JSON-RPC or web3.js `getTransaction` answer, any version) · `decodeMeteoraEvents` (Anchor CPI events of DBC and DAMM v2, with the instruction that emitted them; IDL-driven `IdlCoder`) · `launchTradesFromTransaction` → `LaunchTradeEvent` (side, trader, SOL and token amounts, fee, execution and post-trade price; DBC's twin `EvtSwap`/`EvtSwap2` counted once) · `launchFeeEventsFromTransaction` (claims, leftover, LP fees, curve completion, DAMM v2 pool creation) · `base58Encode`/`base58Decode` |
| Candles       | `buildCandles(points, interval, { from, to, fill, previousClose })`, `fillCandles` (SQL-bucketed candles), `CANDLE_INTERVALS` 1m–1d, `MAX_CANDLES` |
| Claims        | `readLaunchClaims({ connection, dbcPool, dbcConfig?, dammPool? })` → `LaunchClaimsState` (partner and creator trading fees, the migration fee split, surplus, leftover, DAMM v2 positions with locked share and fees, and every `ClaimableItem` with its signer and receiver) · `buildClaimTx` · `launchClaimsFromState`, `migrationFeeSplit`, `surplusSplit`, `dammPositionClaim` (pure, the DBC program's own arithmetic) |
| Graduation    | `migrationReadiness(connection, dbcPool)`, `buildMigrateToDammV2Tx` (the permissionless `migrateToDammV2`)                                     |
| Holders       | `readTopHolders` (`getTokenLargestAccounts` + owners, labelled), `mapTopHolders`                                                                 |
| Revenue       | `readRevenueHistory({ connection, vote, epochs })` (inflation commission, sampled block revenue, MEV commission per epoch), `summarizeRevenue`, `estimateBlockRevenue`, `retryRateLimited` |
| Launch CLI    | `estimateLaunchCost`, `rentExemptLamports`, the pre-flight checks (`checkCluster`, `checkProgram`, `checkRegistry`, `checkExistingConfig`, `checkMetadataJson`, `checkPayerBalance`, `checkInitialBuy`, `summarizePreflight`, `GENESIS_HASH`), the Epoch program's checks for `register_revenue_token` (`treasuryMismatch`, `checkEpochPool`, `checkRevenueTokenTerms`, `checkValidatorPosition`, `checkLeftoverReceiver`, `checkStartEpoch`, `checkRegistrableConfig`, `checkRegistrableMint`), `launchPlanLines`, `revenueTableLines`, `launchRecordFor`, `withRegistration`, `readTokenMetadata`/`decodeTokenMetadata` |

## Quotes and trades

On the curve, quotes use DBC `swapQuote2` and trades `swap2`: buys in `PartialFill` mode, so the buy that completes the
raise fills up to the threshold and returns the rest of the SOL (the quote's `amountIn` is what is used); sells
`ExactIn`. After graduation (`migrated`, or a `dammPool` passed in), quotes use DAMM v2 `getQuote2` and trades `swap2`,
`ExactIn`. `minimumOut` is the output after the slippage (default 1%). `priceImpactPct` compares the execution price
before fees with the spot price, so it measures the pool's move alone; `tradingFeeSol` is every fee (trading, protocol,
referral) in SOL, a fee charged in the token valued at the spot price. Pass the reviewed quote's `minimumOut` to
`buildTradeTx` so the transaction enforces exactly what the review showed.

## The curve (partner preset)

`revenueCurveConfig` builds one DBC config per launch with `buildCurveWithCustomSqrtPrices`: an SPL token with a fixed
supply, no mint authority and immutable metadata; prices from 60% to 95% of the share's value per token (10-epoch average
revenue × share × term ÷ supply); a flat curve fee (100 bps by default), all of it to the partner; graduation to DAMM v2
with a 70% migration fee paid to the pool creator (the validator's upfront SOL) and 100% of the DAMM v2 liquidity
permanently locked with the partner. `curvePointsForBand` computes the sqrt prices with exact integer math; they agree
with the SDK's own `createSqrtPrices` to within 1e-18 (the SDK rounds to 20 significant digits), which the tests check.

**The raise and the supply.** A constant-product curve over the band raises about 61% of the share's value whatever the
supply (for rKEST, 63.4 SOL of a 104 SOL share). A smaller `raiseTargetSol` (2–5 SOL for the demo) leaves the unused
supply as DBC _leftover_, which the config's leftover receiver can withdraw after graduation: 92,113 of rKEST's 100,000
tokens at a 5 SOL target. The receiver is the Epoch program's treasury PDA, and the program burns the leftover. The
market cap stays fully diluted (price × supply not burned), as the spec defines it. The alternative is a smaller share or
term, so that 61% of the share's value is the raise.

## Devnet

The DBC (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) and DAMM v2 (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`)
programs have the same IDs on devnet and mainnet, and so do the DAMM v2 graduation configs. A full curve graduates when
`migrateToDammV2` runs: Meteora's migrator service, or anyone (the call is permissionless; Meteora's manual migrator UI
works on devnet).

## TypeScript note

The DBC SDK is `"type": "module"` and its `exports` map gives every resolver its ESM types, which TypeScript's `Node16`
resolution refuses to import from a CommonJS package (TS1479). The package loads the SDK's CommonJS build at runtime, so
its `tsconfig.json` type-checks with `module: commonjs` and `moduleResolution: node10`; consumers with `skipLibCheck`
(every package here) are unaffected.

## Tests

`pnpm --filter @epoch/meteora test`: the spec's fixture numbers (band, market cap, implied yield, backing), sqrt prices
against the SDK, the preset through the SDK's own `validateConfigParameters`, quotes simulated on a fresh curve with the
SDK's `getQuoteFromInputAmount`, pool and mint decoding, the launch config and the browser-safety scan. No test touches
the network.

The event decoders, the claims arithmetic and the token metadata decoder are tested on the rehearsal's recorded
transactions and accounts (`src/__fixtures__/rehearsal/`, Meteora's mainnet programs on a local validator:
`docs/runbooks/meteora-devnet-rehearsal.md`).
