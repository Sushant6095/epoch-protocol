# panta_bot_app

Creates Epoch's markets on [Panta](https://docs.panta.market) (USDC, Solana **mainnet**, real money; decision of
3 Oct 2026) on the Solana Fee Index, every epoch, and claims their creator fees (feature F10):

> Will the Solana Fee Index for epoch 1051 close above 1,300 micro-lamports per CU?

Validators use them to hedge priority-fee revenue; everyone trades them from the Predict page (`api_app`
`/v1/predict/panta`). Panta resolves them from Epoch's public endpoint `GET /v1/index/epochs/{N}` and the
[methodology](../../docs/FEE_INDEX_METHODOLOGY.md).

```bash
pnpm --filter @epoch/panta_bot_app build
node packages/panta_bot_app/dist/index.js --env .env      # or pm2 (pm2.config.js: epoch-panta-bot)
```

It starts in a **dry run** unless everything a real market needs is set (below): it then logs the full plan of every
market it would create (question, rule, sources, times in IST) and calls nothing that writes.

## What a tick does (every `PANTA_TICK_SECONDS`, 5 min)

1. **Recover.** `quoted` rows go back to `planned` (nothing was signed). A `signed` row is resolved from its stored
   signature: landed → `confirmed` and registered at once; failed, or expired (block height past its
   `lastValidBlockHeight`) → `planned` with one more attempt; still in flight → the same signed transaction is sent
   again. A `confirmed` row is registered.
2. **Plan.** For epochs current + 1 … current + `PANTA_EPOCHS_AHEAD` whose trading window is still at least
   `PANTA_MIN_TRADING_HOURS`, insert `PANTA_MARKETS_PER_EPOCH` markets into `panta_markets` (unique per epoch and
   threshold). Once an epoch has its markets, a newer index value never adds another.
3. **Create**, oldest epoch first, inside `PANTA_MAX_CREATE_USDC_PER_DAY` (rolling 24 h of signed fees):
   `POST /markets/create/quote/` → `POST /markets/create/build/` → **spend guard** → sign with the bot key → **store
   the signature and signed transaction** → broadcast (`@epoch/solana` `PrebuiltTransactionSender`, re-sending until
   confirmed or the blockhash expires) → `POST /markets/register/`.
4. **Creator fees.** Every `PANTA_CREATOR_FEE_CHECK_HOURS`, each registered market that has graduated (phase
   `secondary` or `resolved`) gets `POST /claim/creator-fees/build/`; the instructions are signed and sent with the
   bot key (`TransactionSender`). Not reported to `/trades/` (Panta does not accept those).
5. **Ops line.** One `tick` log line: epoch and progress, targets and thresholds, skipped epochs and why, planned,
   created, registered, recovered, markets waiting, fees spent in 24 h against the budget, creator fees claimed,
   errors.

### Never twice, never more than quoted

- Panta derives a market's address from the creator wallet and the exact question, and refuses a second one
  (`DUPLICATE_MARKET`). The question is a function of (epoch, threshold) only and ASCII; a planned row whose wording
  would differ is failed instead of created. On `DUPLICATE_MARKET` the bot finds the market in its own catalog
  (`GET /markets/?createdBy=me`, by title) and adopts it.
- Every status change is a compare-and-set on `panta_markets.status`, so two bots never act on one row; the signature
  is written before the transaction is sent, and a broadcast whose outcome is unknown (RPC trouble) stays `signed`
  for the next tick to resolve from the chain.
- **Spend guard** (`src/Chain/BotChain.ts`): Panta's unsigned create must be paid by the bot, need only the bot's
  signature and carry the blockhash of the build; it is then simulated against mainnet and refused (row `failed`,
  never retried) if it would move more USDC out of the bot's USDC account than the quoted fee, or more SOL than
  `PANTA_MAX_SOL_PER_CREATE`.
- A create that paid but could not be registered within Panta's ~5 minute session is checked in the catalog by its
  address; if it is not there the row becomes `unregistered` with the `createId` and signature to give Panta.

### Timing (`src/Markets/EpochSchedule.ts`)

From the mainnet slot clock (`EpochClock`) and the measured slot time (`getRecentPerformanceSamples`, ~0.4 s), with a
2% margin on every estimate that grows with how far ahead it is:

| Field | Value | Why |
| --- | --- | --- |
| `startTime` | now + 3,600 s (Panta's `minimumStartDelay`) + 10 min | room to quote, sign, land and register |
| `endTime` | epoch N's estimated start − margin − `PANTA_CLOSE_BEFORE_EPOCH_MINUTES` (60) | nobody trades while N's fees are public (same rule as fee swaps and points mode) |
| `resolutionTime` | N's estimated end + margin + `PANTA_RESOLUTION_BUFFER_HOURS` (6) | indexing, `post_index`, the dispute window, `finalize_index` |
| missing value | resolution time + `PANTA_RESOLUTION_GRACE_HOURS` (48) → NO | written into the rule |

An epoch whose window would be shorter than `PANTA_MIN_TRADING_HOURS` (6) is skipped (the next one is created).

### Thresholds (`src/Markets/Thresholds.ts`)

One market per epoch (default): the last finished epoch's value, rounded (steps of 1 / 10 / 50 / 500 by size), so each
market asks "higher than last epoch?", close to an even bet. More markets per epoch: evenly spaced quantiles of the
last `PANTA_THRESHOLD_LOOKBACK_EPOCHS` (16) values. History comes from `epoch_index`.

## Costs

Every market costs the creation fee Panta quotes (`paymentUsdc`; part of it, `liquidityInjectionUsdc`, seeds the
market's liquidity, the rest is Panta's). Panta's docs show 50 USDC (10 + 40) as an example; the real fee comes from
on-chain config and is logged at each quote. One market per ~2-day epoch is about 25 USDC a day at that price; the
default cap `PANTA_MAX_CREATE_USDC_PER_DAY=100` allows two creates in any 24 hours. Plus SOL for transaction fees and
rent (well under 0.05 SOL per create). Creator fees flow back once a market graduates.

## Configuration (`PantaBotConfigSchema`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANTA_API_KEY` | — (dry run) | `pk_live_…` from Panta's dashboard. Server-side only; never logged. |
| `PANTA_API_URL` | `https://live-api.panta.market/api/v1` | |
| `PANTA_BOT_KEYPAIR_PATH` | — (dry run) | keypair FILE of the market creator (pays fees in USDC and SOL). Outside the repo; never logged. |
| `PANTA_MARKET_IMAGE_URL` | — (dry run) | public https image for the catalog, 1024×1024 |
| `PUBLIC_API_URL` | — (dry run) | Epoch's public https API: markets resolve from `{PUBLIC_API_URL}/v1/index/epochs/{N}` |
| `EPOCH_PROGRAM_ID`, `EPOCH_CLUSTER` | — (dry run), devnet | the program whose FeeIndex account finalizes values (listed as a source) |
| `DATABASE_URL` | — (dry run) | `panta_markets` (state) and `epoch_index` (thresholds) |
| `PANTA_RPC_URL`, `PANTA_RPC_FALLBACK_URL` | `DATA_RPC_URL`, else the public mainnet RPC | MAINNET: clock, simulation, broadcast |
| `PANTA_DRY_RUN` | false | force a dry run |
| `PANTA_MAX_CREATE_USDC_PER_DAY` | 100 | creation fees in any rolling 24 h |
| `PANTA_MARKETS_PER_EPOCH` | 1 | ladder size (1–5) |
| `PANTA_EPOCHS_AHEAD` | 2 | how far ahead markets are opened |
| `PANTA_MIN_TRADING_HOURS` | 6 | skip an epoch below this |
| `PANTA_CLOSE_BEFORE_EPOCH_MINUTES` | 60 | trading closes this long before N's start |
| `PANTA_RESOLUTION_BUFFER_HOURS` | 6 | after N's end |
| `PANTA_RESOLUTION_GRACE_HOURS` | 48 | no final value by then → NO |
| `PANTA_THRESHOLD_LOOKBACK_EPOCHS` | 16 | ladder quantiles |
| `PANTA_TICK_SECONDS` | 300 | loop interval |
| `PANTA_CREATOR_FEE_CHECK_HOURS` | 6 | per market |
| `PANTA_MAX_SOL_PER_CREATE` | 0.05 | spend guard, SOL |
| `PANTA_USDC_MINT` | mainnet USDC | spend guard |
| `PANTA_REGION` | Global | catalog region |
| `PANTA_METHODOLOGY_URL` | the repo's `docs/FEE_INDEX_METHODOLOGY.md` | listed as a source |
| `PANTA_BOT_RATE_LIMIT_SHARE` | 0.2 | the bot's share of Panta's per-account limits (the API's `PANTA_RATE_LIMIT_SHARE` is 0.8: one key, shares add up to 1) |
| `PANTA_CU_PRICE_MICROLAMPORTS` | 10,000 | priority fee of the creator-fee claims |

## Check it

1. Dry run first (no key, or `PANTA_DRY_RUN=true`): the log shows `DRY RUN: would create` with the exact question,
   rule, sources and IST times, then the `tick (DRY RUN)` line with the reasons.
2. Live: the start line shows the wallet's USDC and SOL and `canCreateMarkets`; a create logs `creating market`
   (quoted fee and the fee the simulation showed) and `market registered on Panta`. Then
   `select epoch, threshold, status, market_id, paid_usdc_base, error from panta_markets order by epoch desc;`,
   `GET /v1/predict/panta/markets` (our market with prices), and `GET {PUBLIC_API_URL}/v1/index/epochs/{N}`.

Tests: `pnpm --filter @epoch/panta_bot_app test` (timing, thresholds, words, the lifecycle on fakes: idempotency,
budget, dry run, crash recovery, duplicates, the spend guard, creator fees; the store on Postgres with
`TEST_DATABASE_URL`).
