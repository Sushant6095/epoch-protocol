# @epoch/api_app

REST API for the Epoch app. Every response is `{ ok: true, data }`; errors are
`{ ok: false, error: { code, message, details }, traceId }`. Payloads carry `schemaVersion`, `kind`,
`asOf` (IST) and `source`, and units live in field names (`…Sol`, `…Pct`, `…Epoch`). `null` means "not
known yet" and the app shows "—".

## Endpoints

| Method and path                                                                            | Returns                         | Cache | Data                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------- | ----- | ------------------------------------------------------------- |
| `GET /health`                                                                              | `{ status, time }`              | —     | —                                                             |
| `GET /v1/index?from=&to=&limit=`                                                           | `FeeIndexPoint[]`, newest first | —     | Postgres `epoch_index` (written by the indexer)               |
| `GET /v1/network`                                                                          | `NetworkSnapshot`               | 15 s  | mainnet RPC, Stakewiz, Jito Kobe, Jupiter, the delegator scan |
| `GET /v1/network/stake-history?epochs=64`                                                  | `StakeHistory`, oldest first    | 5 min | StakeHistory sysvar                                           |
| `GET /v1/validators?tab=&chips=&q=&sort=&dir=&fee=&client=&country=&votes=&cursor=&limit=` | `ValidatorList`                 | 30 s  | as `/v1/network`                                              |
| `GET /v1/delegators/biggest?limit=10`                                                      | `BiggestDelegators`             | 5 min | the delegator scan                                            |
| `GET /v1/delegators/retail-magnets?limit=10`                                               | `RetailMagnets`                 | 5 min | the delegator scan                                            |

`/v1/validators` query: `tab` = `all | healthy | watch | watchlist` (watch includes offline); `chips` =
comma list of `below, dep, hide-top18, firedancer, zero-fee`; `q` searches names and vote keys; `sort` =
`stake | apy | score | kept | dels | fee | blocks | up` with `dir` = `desc | asc` (nulls last, stake breaks
ties); `fee=0-10` (commission %); `client=agave,firedancer`; `country=DE,US`; `votes=<vote>,<vote>` (at most
200, the watchlist); `limit` 1–1,000 (default 50) and `cursor` from the previous page's `nextCursor`. The
Terminal's top validators are `?sort=stake&limit=8`. `facets` count clients and countries after the tab,
chips and search, before the popover's own filters.

The delegator endpoints answer `503 NOT_READY` (with scan progress in `details`) until the first stake-account
scan has finished, a few minutes after start. `/v1/network` answers right away with `delegators: null`
until then. On 1 Oct 2026 a full scan on the public RPC read 1,160,560 stake accounts (581,356 wallets) in
about 5 minutes, and the process sat at about 430 MB of memory afterwards: give the API at least 1 GB.

## How the derived figures are computed

- **Validators** = every vote account with stake (`getVoteAccounts` current + delinquent). **Delinquent** =
  delinquent now but earned vote credits in this or the last epoch (long-dead accounts are not counted).
- **Superminority** = the fewest largest validators holding more than a third of stake (`top18`).
- **Epoch Score** = the program's formula (`programs/epoch/src/math/score.rs`, ported in `Lib/EpochScore.ts`
  with the same tests): credits in the last finished epoch vs the cluster mean, commission = the higher of
  inflation and MEV commission, tenure from Stakewiz's first epoch with stake. Shown 0–100.
- **SOL kept per epoch** (`healthPerEpochSol`) = inflation commission (stake × gross staking yield per epoch
  × commission; yield = inflation rate × supply ÷ total stake ÷ epochs a year) + MEV commission (from the
  tips stakers earn, Stakewiz `jito_apy`, and the MEV commission) + block fees (blocks produced this epoch,
  scaled to a full epoch, × the average leader fee per block from a sample of recent blocks) − vote fees
  (slots per epoch × 5,000 lamports).
- **Break-even stake** = the stake at which a validator charging the median commission covers its vote fees
  from inflation commission plus the block fees its stake share earns.
- **Health** = the app's rules (`01-PRODUCT-AND-USERS.md`): offline when delinquent; watch when SOL kept < 0,
  one delegator holds over 50% or uptime < 99%; else healthy. "Commission raised in the last 10 epochs" waits
  for commission history from the indexer.
- **Client** = gossip `clientId` (`getClusterNodes`): Firedancer, Frankendancer, HarmonicFiredancer and FireBAM
  count as Firedancer; the rest (Agave, AgaveBam, JitoLabs, HarmonicAgave…) as Agave.
- **Median / top APY** = median and 90th percentile of Stakewiz `total_apy` across voting validators.
- **Delegators** = a scan of every delegated stake account (one filtered `getProgramAccounts` per vote account,
  136-byte slices), grouped by withdraw authority. Retail < 1,000 SOL in total, mid-size up to 100,000 SOL,
  allocators above. Stake pools on the configured stake-pool programs are named from their token symbol
  (JitoSOL, JupSOL…); other wallets are named only through `DELEGATOR_LABELS_PATH`.
- **Activating / deactivating this epoch** come from the scan when it ran this epoch, otherwise from the newest
  StakeHistory entry (the last finished epoch).

## Configuration (`MarketDataConfigSchema` in `@epoch/config-sdk`)

| Variable                        | Default                                    | Notes                                                                                                                               |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_RPC_URL`                  | `https://api.mainnet-beta.solana.com`      | Mainnet, even when the program runs on devnet. Use a paid RPC in production: the public one rate-limits (HTTP 429) during the scan. |
| `DATA_RPC_FALLBACK_URL`         | —                                          | Tried when the primary fails.                                                                                                       |
| `STAKEWIZ_API_URL`              | `https://api.stakewiz.com`                 | Names, countries, APY, uptime, tenure.                                                                                              |
| `JITO_KOBE_API_URL`             | `https://kobe.mainnet.jito.network`        | MEV commission.                                                                                                                     |
| `PRICE_API_URL`                 | `https://lite-api.jup.ag/price/v3`         | SOL/USD.                                                                                                                            |
| `TOKEN_API_URL`                 | `https://lite-api.jup.ag/tokens/v2/search` | Stake-pool token symbols.                                                                                                           |
| `FX_API_URL`                    | `https://open.er-api.com/v6/latest/USD`    | USD/INR.                                                                                                                            |
| `DELEGATOR_SCAN_ENABLED`        | `true`                                     |                                                                                                                                     |
| `DELEGATOR_SCAN_INTERVAL_HOURS` | `12`                                       | Plus one run at start.                                                                                                              |
| `DELEGATOR_SCAN_CONCURRENCY`    | `4`                                        | Parallel `getProgramAccounts` calls.                                                                                                |
| `DELEGATOR_SCAN_VOTE_LIMIT`     | `0`                                        | Development only: scan the N largest validators.                                                                                    |
| `DELEGATOR_LABELS_PATH`         | —                                          | JSON `[{ "address", "name", "kind", "entity"? }]`; rows sharing an `entity` are summed (several Foundation wallets → one row).      |
| `FOUNDATION_AUTHORITIES`        | —                                          | Comma list of the Solana Foundation's withdraw authorities; enables `foundationSharePct` and `dependOnFoundation`.                  |
| `STAKE_POOL_PROGRAM_IDS`        | SPL + two Sanctum programs                 | Stake-pool programs whose pools are named as liquid staking.                                                                        |

`API_PORT` and `API_CORS_ORIGINS` come from `ApiConfigSchema`; `DATABASE_URL` is only needed by `/v1/index`.
