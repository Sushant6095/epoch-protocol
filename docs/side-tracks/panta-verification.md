# Panta: every call, checked against the current docs

Round 4, 7 Oct 2026, 14:11–14:20 IST, branch `feat/r4-sidetracks`. Track: Panta (prediction markets). Every call Epoch
makes to Panta's public API (`packages/panta`, used by `panta_bot_app` and `api_app`) was checked against Panta's public
docs (`https://docs.panta.market`) and its official playground (`github.com/Kaito-HQ/panta-api-playground`). **Panta's
live API was never called**, by their terms: the docs site and the playground's source are not the API, and every test
answers from a fake `fetch`.

**Result.** Nothing has changed at Panta since the 5 Oct reconcile. All 26 rows below are backed by a doc line and a
test, and no gap was found. The 7 fixes from 5 Oct
([`packages/panta/README.md`](../../packages/panta/README.md#reconciled-with-the-live-api-5-oct-2026)) still hold.

## What changed at Panta since 5 Oct: nothing

| Source | 5 Oct | 7 Oct, 14:11 IST | Changed? |
| --- | --- | --- | --- |
| `https://docs.panta.market/llms.txt` (the index) | 39 pages | 39 pages, same text | No |
| The 39 pages (`<page>.md`) | round-2 snapshot | fetched again, diffed page by page (trailing spaces ignored) | No: 39 of 39 identical |
| Playground `main` | — | `a92b0db`, committed 9 Sep 2026 (`git ls-remote`, shallow clone, no code run) | No: the last commit is older than the reconcile. The 29 source files the reconcile read are identical at `a92b0db` |
| Playground files not read on 5 Oct | — | `src/app/api/admin-probe/route.ts` (calls `GET /admin/metrics/`, admin keys only), `favicon.ico` | Not relevant: Epoch is not a Panta admin |

## How to read the table

"l. N" is the line in the page's Markdown export, `https://docs.panta.market/<page>.md`, fetched 7 Oct 2026 at
14:11 IST. For the endpoints it is the line of the documented request (`curl …`). Pages are under `api-reference/`
unless they start with `guides/`. Tests are in `packages/panta/src/` unless a package is named. Every client test answers
from a fake `fetch` built from the documented examples and the playground's live shapes (`src/__fixtures__`).

Base URL `https://live-api.panta.market/api/v1` (`index.md`), `X-Api-Key` on every call (`guides/authentication.md`).
Every path ends with a slash.

## Calls

| # | Call | Client method | Doc | Test | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | `GET /account/` | `account()` | `account/get` l.45 | `client.test.ts` | ✓ |
| P2 | `GET /account/dashboard/` | `dashboard()` | `account/dashboard` l.33 | `client.test.ts` | ✓ |
| P3 | `GET /account/metrics/?limit=` | `metrics()` | `account/metrics` l.78 | `client.test.ts` | ✓ |
| P4 | `GET /account/creates/?limit=&status=` | `creates()` | `account/creates` l.41 | `client.test.ts` | ✓ |
| P5 | `GET /account/trades/?limit=&kind=` | `attributedTrades()` | `account/trades` l.37 | `client.test.ts` | ✓ |
| P6 | `GET /markets/?category=&status=&limit=&cursor=` | `listMarkets()` | `markets/list` l.69 (catalog rows, not a chain scan: l.15) | `client.test.ts`, `schemas.test.ts` | ✓ |
| P7 | `GET /markets/{marketId}/` | `getMarket()` | `markets/get` l.27 (errors `MARKET_NOT_FOUND`, `RATE_LIMITED`) | `client.test.ts` | ✓ |
| P8 | `GET /markets/{marketId}/trades/` | `marketTrades()` | `markets/trades` l.49 | `client.test.ts` | ✓ |
| P9 | `GET /categories/` | `categories()` | `markets/categories` l.23 | `client.test.ts` | ✓ |
| P10 | `GET /wallets/{wallet}/trades/` | `walletTrades()` | `markets/wallet-trades` l.37 | `client.test.ts` | ✓ |
| P11 | `POST /markets/create/quote/` | `quoteCreate()` | `markets/quote` l.117; body l.29–88. The bot sends all 9 required fields (`wallet`, `question`, `resolutionRule`, `sourcesOfTruth`, `category`, `startTime`, `endTime`, `resolutionTime`, `imageUrl`) and `marketType`, `title`, `description`, `region` | `client.test.ts`, `panta_bot_app` `MarketLifecycle.test.ts` | ✓ |
| P12 | `POST /markets/create/build/` | `buildCreate()` | `markets/build` l.47; `markets/overview` l.26–27 | `client.test.ts`, `MarketLifecycle.test.ts` | ✓ |
| P13 | `POST /markets/register/` | `registerMarket()` | `markets/register` l.39; `markets/overview` l.7 ("register after the wallet broadcasts") | `client.test.ts`, `MarketLifecycle.test.ts` | ✓ |
| P14 | `POST /primaryorderquote/` | `quoteBuy()` | `orders/quote` l.57 | `client.test.ts` | ✓ |
| P15 | `POST /primaryorderbuild/` (`maxSlippageBps` whole, at most 5,000) | `buildBuy()` | `orders/build` l.51; l.27–29 ("Default `100` (1%); maximum `5000`"); l.13 (`QUOTE_STALE`) | `client.test.ts` (request validation) | ✓ |
| P16 | `POST /primaryordersubmit/` | `submitBuy()` | `orders/submit` l.33 | `client.test.ts` | ✓ |
| P17 | `POST /primaryorderverify/` | `verifyBuy()` | `orders/verify` l.35 | `client.test.ts` | ✓ |
| P18 | `GET /positions/?wallet=` | `positions()` | `positions` l.69 | `client.test.ts` | ✓ |
| P19 | `POST /claim/build/` | `buildWinClaim()` | `claims/build` l.51 | `client.test.ts` | ✓ |
| P20 | `POST /claim/creator-fees/build/` | `buildCreatorFeeClaim()` | `claims/creator-fees` l.59 | `client.test.ts` | ✓ |
| P21 | `POST /trades/` (attribution report) | `reportTrade()` | `trades/report` l.62 | `client.test.ts` | ✓ |
| P22 | `GET /trades/{signature}/` | `tradeStatus()` | `trades/status` l.32; its status table (`processed`, `pending_attribution`, `unknown`, `failed`) is exactly `PANTA_ATTRIBUTION_STATUSES` (`schemas.ts` l.517) | `client.test.ts`, `schemas.test.ts` | ✓ |
| P23 | Errors `{ code, message, field?, fields? }`, rate-limit families, `X-RateLimit-*`, `Retry-After` | `errors.ts`, `budget.ts`, `client.ts` | `guides/errors` l.11–25 (envelope), l.41 (`429`), l.69 (`RATE_LIMITED`), l.72–94 (headers; families `read` 120, `positions` 60, `quote` 30, `build` 20, `register` 40 per 60 s = `budget.ts` l.18–26). All 23 error codes the docs name (the errors guide's table, l.45–70) occur in `packages/panta/src` | `budget.test.ts`, `client.test.ts` (Retry-After, rate headers, error mapping, backoff) | ✓ |
| P24 | Instruction lists compiled into one unsigned v0 transaction (no lookup tables), with its signers | `transactions.ts` | `orders/build` l.13 ("Compile a versioned transaction from `instructions` and `recentBlockhash`, sign with `wallet`"); `markets/overview` l.27. The docs name no lookup tables, and we compile none | `transactions.test.ts` | ✓ |
| P25 | Bot lifecycle: quote, build, sign, register. `sourcesOfTruth` points at Epoch's `/v1/index/epochs/{N}`. `DUPLICATE_MARKET` adopts the existing market. Dry run is forced while the key, keypair, public https image URL or public API URL is missing (so `imageUrl`, required by `markets/quote` l.61–63, is never sent empty) | `panta_bot_app` `MarketLifecycle.ts`, `Settings.ts`, `Markets/*` | `markets/overview` l.7–27; `markets/quote` l.41 (`sourcesOfTruth`, required `string[]`) | `MarketLifecycle.test.ts`, `Markets.test.ts`, `Settings.test.ts`, `MarketStore.test.ts` (Postgres) | ✓ |
| P26 | API `/v1/predict/panta/*`: 8 GET (`markets`, `markets/:marketId`, `categories`, `positions`, `stats`, `forecast`, `market-image.png`, `status/:tradeId`) and 4 POST (`quote`, `build`, `submit`, `claim/build`); resolution source `GET /v1/index/epochs/:epoch` | `api_app` `Routes/PantaRouters.ts` | [`docs/pages/predict.md`](../pages/predict.md) l.38–300 (routes), l.306 (resolution source); "Powered by Panta" l.15 | `PantaRouters.test.ts`, `PantaSupport.test.ts`, `PantaStores.test.ts`, `CrowdForecast.test.ts`, `StreamHubPanta.test.ts`, `MarketImage.test.ts` | ✓ |

Not used, on purpose (unchanged): `/auth/*`, `/account/keys/` and `POST /markets/create/image-upload/`. Keys are made by
a person in Panta's dashboard, and the market image is Epoch's own (`PANTA_MARKET_IMAGE_URL`).

## Tests

| Command | Result |
| --- | --- |
| `pnpm --filter @epoch/panta test` | 5 suites, 29 tests, all pass |
| `panta_bot_app` (`TEST_DATABASE_URL=…epoch_test_r4_sidetracks`) | 5 suites, 46 tests, all pass (including the 5 Postgres store tests) |
| `api_app` (`TEST_DATABASE_URL=…`): `jest Panta` | 6 suites, 42 tests, all pass |

## Open

Nothing for Panta. The playground and docs should be checked again before the 13 Oct submission (the same two diffs:
`llms.txt` plus the 39 pages, and `git ls-remote` on the playground).
