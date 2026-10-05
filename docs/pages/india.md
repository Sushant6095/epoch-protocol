# India page: page contract

The special page for the **Superteam India** side track: Epoch for Indian stakers and validators, in rupees, on real
mainnet data. Backend: `packages/api_app`, router `/v1/india` (`src/Routes/IndiaRouters.ts`, types in
`src/types/India.types.ts`). Every example below was answered by this API on **3 Oct 2026** against mainnet, unless it
says _illustrative_.

## The track

| | |
| --- | --- |
| Listing | superteam.fun/earn/listing/colosseum-crypto-worlds-fair-hackathon-superteam-india-track |
| Prize | 5,000 USDG: 2,500 / 1,500 / 1,000, plus a Member role in Superteam India for winners |
| Who | Built on Solana; team based in India; registered on Colosseum with **India** as the country; eligible under the global rules |
| Submit | To the Colosseum portal **and** Superteam Earn (human submission only) by 13 Oct 2026, 12:29 IST. The Earn form asks for the GitHub link, a pitch deck or Loom video, and whether the project is on Colosseum |
| Judged on | **Ecosystem impact** (real value to Solana: infrastructure, tooling, or a product people need) · **Product-market fit** (clear problem, defined user, early traction) · **Growth potential** (brings new users to Solana or deepens engagement) |
| Winners | By 28 Oct 2026 |

How the page answers them:

- **Product-market fit**: Indian taxpayers keep their books and file returns by financial year (1 April to 31 March)
  in rupees; wallets show staking rewards in SOL, per epoch. This page turns a wallet's rewards into rupees at each
  day's price, by FY, with a CSV for their chartered accountant (CA).
- **Ecosystem impact**: on 3 Oct 2026 Stakewiz placed **0 of 683** staked validators in India (Singapore hosts 44).
  The page shows that gap with live numbers and what Epoch's revenue-based credit means for a validator started in
  India.
- **Growth potential**: a rupee-first view of Solana staking for Indian users (prices, rewards, validator economics),
  all from public mainnet data, no sign-in.

## Suggested layout

1. **Hero**: SOL in ₹ (`summary.price`), 24 h change, "as of" time in IST and the source. A 30-day sparkline from
   `GET /v1/india/price?days=30`.
2. **Your staking income in ₹**: wallet input (or the connected wallet), FY picker, the year's total, months chart,
   epoch table, **Download CSV**. Polls `GET /v1/india/wallets/:address/rewards`.
3. **India on the Solana map**: India's validators and share of stake, rank, cities, the country comparison
   (`summary.validators`).
4. **Validators hosted in India**: the table (`GET /v1/india/validators`), each with revenue and Epoch's estimated
   advance. When the list is empty, show **Start a validator in India** (`summary.prospect`) instead.
5. Footer: the disclaimer (`summary.disclaimer`), sources.

## Conventions

- Envelope: `{ ok: true, data }`; errors `{ ok: false, error: { code, message, details }, traceId }`.
- Every payload has `schemaVersion`, `kind: 'real'`, `asOf` (IST, `2026-10-03T18:50:11+05:30`), `source`, and `note`
  when something is partial or estimated. Show `note` in small print.
- **Rupees** always come as an object, so the page never formats money itself:

  ```json
  { "inr": 12345678.9, "formatted": "₹1,23,45,678.90", "compact": "₹1.23 Cr" }
  ```

  `formatted` uses the Indian numbering system (last three digits, then pairs) with paise; `compact` is for headline
  figures (`₹56,789`, `₹45.60 L` from one lakh, `₹1.23 Cr` from one crore). Negative amounts are `-₹2,75,325.30`.
  Unknown is `{ "inr": null, "formatted": "—", "compact": "—" }`: render the dash, never ₹0.
- `null` anywhere means "not known"; show "—". `0` is a real zero.
- Dates are IST (`+05:30`). Dates without a time (`date`, `priceDate`) are IST calendar dates.
- SOL amounts are plain numbers (`…Sol`); show up to 4 decimals (9 in the CSV). For large SOL counts the India-first
  form is lakh/crore too: 44.2 crore SOL, 1.5 lakh SOL.

## `GET /v1/india/summary`

First paint. Cache 30 s (no-store while the price is stale). One section failing does not fail the response: it is
`null` and `errors` says why. 503 `INDIA_UNAVAILABLE` only when the price and the validators both fail.

```json
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "kind": "real",
    "asOf": "2026-10-03T18:50:11+05:30",
    "source": "Solana mainnet RPC, Stakewiz, Jito Kobe, CoinGecko",
    "price": {
      "inr": 11501.2,
      "formatted": "₹11,501.20",
      "change24hPct": -2.31,
      "source": "CoinGecko",
      "asOf": "2026-10-03T18:48:50+05:30",
      "stale": false,
      "staleReason": null
    },
    "fy": {
      "label": "2026-27",
      "name": "FY 2026-27",
      "assessmentYear": "AY 2027-28",
      "startsAt": "2026-04-01T00:00:00+05:30",
      "endsAt": "2027-03-31T23:59:59+05:30",
      "current": true
    },
    "network": {
      "epoch": 1048,
      "validators": 683,
      "stakeSol": 442013190,
      "stakeValueInr": { "inr": 5083682102796.29, "formatted": "₹50,83,68,21,02,796.29", "compact": "₹5,08,368.21 Cr" }
    },
    "validators": {
      "status": "empty",
      "india": {
        "countryData": "available",
        "validators": 0,
        "listed": 0,
        "stakeSol": 0,
        "stakeValueInr": { "inr": 0, "formatted": "₹0.00", "compact": "₹0" },
        "stakeSharePct": 0,
        "validatorSharePct": 0,
        "rank": null,
        "countriesWithValidators": 30
      },
      "cities": [],
      "top": [],
      "comparison": {
        "top": [
          { "countryCode": "DE", "country": "Germany", "validators": 191, "stakeSol": 151779160, "stakeSharePct": 34.338, "validatorSharePct": 27.96, "rank": 1 },
          { "countryCode": "NL", "country": "Netherlands", "validators": 122, "stakeSol": 87876990, "stakeSharePct": 19.881, "validatorSharePct": 17.86, "rank": 2 },
          { "countryCode": "US", "country": "United States", "validators": 115, "stakeSol": 65786701, "stakeSharePct": 14.883, "validatorSharePct": 16.84, "rank": 3 }
        ],
        "india": { "countryCode": "IN", "country": "India", "validators": 0, "stakeSol": 0, "stakeSharePct": 0, "validatorSharePct": 0, "rank": null },
        "peers": [
          { "countryCode": "SG", "country": "Singapore", "validators": 44, "stakeSol": 18099847, "stakeSharePct": 4.095, "validatorSharePct": 6.44, "rank": 7 },
          { "countryCode": "AE", "country": "United Arab Emirates", "validators": 0, "stakeSol": 0, "stakeSharePct": 0, "validatorSharePct": 0, "rank": null },
          { "countryCode": "HK", "country": "Hong Kong", "validators": 17, "stakeSol": 2898865, "stakeSharePct": 0.656, "validatorSharePct": 2.49, "rank": 11 },
          { "countryCode": "JP", "country": "Japan", "validators": 55, "stakeSol": 25188058, "stakeSharePct": 5.698, "validatorSharePct": 8.05, "rank": 5 }
        ],
        "unknown": { "validators": 6, "stakeSol": 41956 }
      }
    },
    "prospect": {
      "note": "Estimate for a new validator hosted in India at today's network rates (5% commission, 5% MEV commission, median tips APY). Credit limits apply after 10 epochs of swept revenue, before the bond and cap rules; not an offer.",
      "assumptions": { "commissionPct": 5, "mevCommissionPct": 5, "tipsApyPct": 0.165, "epochsPerMonth": 22.5, "advanceBpsUnhedged": 2500, "advanceBpsHedged": 4000, "revenueWindowEpochs": 10 },
      "breakEvenStakeSol": 100000,
      "tiers": [
        {
          "stakeSol": 150000,
          "revenuePerEpochSol": 1.1286,
          "revenuePerMonthSol": 25.4,
          "revenuePerMonthInr": { "inr": 292106.37, "formatted": "₹2,92,106.37", "compact": "₹2.92 L" },
          "creditLimitUnhedgedSol": 3.68,
          "creditLimitHedgedSol": 5.89,
          "creditLimitUnhedgedInr": { "inr": 42307.26, "formatted": "₹42,307.26", "compact": "₹42,307" },
          "creditLimitHedgedInr": { "inr": 67691.61, "formatted": "₹67,691.61", "compact": "₹67,692" }
        }
      ]
    },
    "errors": {},
    "disclaimer": "Informational only, not tax advice. Covers the protocol staking rewards of this wallet's current stake accounts (getInflationReward), credited when each epoch ends; Jito MEV tips, liquid-staking tokens and stake accounts closed before today are not included. Rupee values use the daily SOL/INR price nearest each credit (CoinGecko; days it cannot serve: Binance SOL/USDT × the ECB's USD/INR). Check the figures with a chartered accountant before you file."
  }
}
```

`prospect.tiers` has three stake sizes (50,000, 150,000 and 500,000 SOL; one shown). At 50,000 SOL the revenue is
negative: vote fees (2.16 SOL an epoch) exceed what that stake earns. Show it, it is the honest answer.

| Section | Loading | Empty | Stale | Error |
| --- | --- | --- | --- | --- |
| `price` | skeleton | — | `stale: true`: show the price greyed with "Last known price · {staleReason}"; never as live | `null` + `errors.price`: hide the hero number, show "Price unavailable, retrying" |
| `validators` | skeleton | `status: 'empty'`: "No Solana validator is hosted in India yet", comparison + prospect | — | `null` + `errors.validators`: "Validator data unavailable" |
| `validators.status: 'unknown'` | — | — | — | Stakewiz has no country data: "Can't tell where validators are right now"; India's figures are `null` |
| `prospect` | skeleton | — | — | `null` with `validators` |

## `GET /v1/india/price?days=0`

Live SOL/INR. Read from CoinGecko at most once a minute; if CoinGecko fails or stands still, Jupiter SOL/USD ×
USD/INR. `days` (0–365) adds CoinGecko's daily price for a sparkline. Cache 15 s; `no-store` when stale.

```json
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "kind": "real",
    "asOf": "2026-10-03T18:48:50+05:30",
    "source": "CoinGecko",
    "pair": "SOL/INR",
    "inr": 11501.2,
    "formatted": "₹11,501.20",
    "usd": 119.4,
    "usdInr": 96.325,
    "change24hPct": -2.31,
    "observedAt": "2026-10-03T18:48:50+05:30",
    "fetchedAt": "2026-10-03T18:50:09+05:30",
    "ageSeconds": 80,
    "stale": false,
    "staleReason": null,
    "refreshSeconds": 60,
    "history": [
      { "date": "2026-10-02", "at": "2026-10-02T05:30:00+05:30", "inr": 11391.28 },
      { "date": "2026-10-03", "at": "2026-10-03T05:30:00+05:30", "inr": 11400.26 }
    ]
  }
}
```

- `source` is `CoinGecko` or `Jupiter SOL/USD × open.er-api USD/INR`. Show it next to the price.
- **Stale**: `stale: true` with a reason (`price sources unavailable since …`, `CoinGecko has not updated for 20
  minutes`). The value is the last known one; label it as such and use `ageSeconds`.
- **Error**: 503 `PRICE_UNAVAILABLE` (with `details.retryAfterSeconds`) only when no source has answered since the
  API started. Retry after that many seconds.
- Poll every 60 s at most (`refreshSeconds`).

## `GET /v1/india/validators`

The validators on the India list, with the `/v1/validators` query: `tab` (`all | healthy | watch | watchlist`), `chips`
(`below, dep, hide-top18, firedancer, zero-fee`), `q`, `sort` (`stake | apy | score | kept | dels | fee | blocks |
up`), `dir`, `fee=0-10`, `client`, `votes`, `cursor`, `limit` (default 50). No `country`: it is always India. Cache 30 s.

On the list: validators Stakewiz geolocates in India (`inIndiaBy: 'ip-geolocation'`), plus any vote accounts in
`INDIA_VALIDATOR_VOTES` (`inIndiaBy: 'listed'`: operator-declared, hosted elsewhere; badge them "Indian operator").
India's share, rank and cities count geolocated validators only.

Real answer on 3 Oct 2026:

```json
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "kind": "real",
    "asOf": "2026-10-03T18:50:11+05:30",
    "source": "Solana mainnet RPC, Stakewiz, Jito Kobe, CoinGecko",
    "status": "empty",
    "rows": [],
    "total": 0,
    "nextCursor": null,
    "facets": { "client": {}, "country": {} },
    "india": { "countryData": "available", "validators": 0, "listed": 0, "stakeSol": 0, "stakeValueInr": { "inr": 0, "formatted": "₹0.00", "compact": "₹0" }, "stakeSharePct": 0, "validatorSharePct": 0, "rank": null, "countriesWithValidators": 30 },
    "cities": [],
    "price": { "inr": 11501.2, "formatted": "₹11,501.20", "change24hPct": -2.31, "source": "CoinGecko", "asOf": "2026-10-03T18:48:50+05:30", "stale": false, "staleReason": null }
  }
}
```

_Illustrative_ row (a made-up Mumbai validator from the tests), so the table can be built before one appears:

```json
{
  "name": "Mumbai One",
  "vote": "Mumb1VoteAccount111111111111111111111111111",
  "identity": "Mumb1Identity1111111111111111111111111111",
  "voteShort": "Mumb…1111",
  "inIndiaBy": "ip-geolocation",
  "city": "Mumbai",
  "country": "India",
  "countryCode": "IN",
  "hostingOrg": "Equinix India",
  "client": "Agave",
  "stakeSol": 200000,
  "stakeValueInr": { "inr": 2300240000, "formatted": "₹2,30,02,40,000.00", "compact": "₹230.02 Cr" },
  "commissionPct": 5,
  "mevCommissionPct": 5,
  "apyPct": 6.1,
  "stakingApyPct": 4.8,
  "tipsApyPct": 0.2,
  "epochScore": 96,
  "health": "healthy",
  "healthReasons": [],
  "delinquent": false,
  "uptimePct": 100,
  "delegators": 1988,
  "top18": false,
  "revenue": {
    "epoch": 1047,
    "endedAt": "2026-10-03T03:20:01+05:30",
    "basis": "validator-profile",
    "sol": { "inflationCommission": 1.8, "tipsCommission": 0.25, "blockFeesEstimate": 1.6, "voteFees": -2.16, "net": 1.49 },
    "netInr": { "inr": 16986.39, "formatted": "₹16,986.39", "compact": "₹16,986" },
    "priceInr": 11400.26,
    "priceSource": "CoinGecko"
  },
  "credit": {
    "estimate": true,
    "basis": "validator-profile",
    "sweepablePerEpochSol": 2.05,
    "sweepableLast10EpochsSol": 20.4,
    "limitUnhedgedSol": 5.1,
    "limitHedgedSol": 8.16,
    "limitUnhedgedInr": { "inr": 58656.12, "formatted": "₹58,656.12", "compact": "₹58,656" },
    "limitHedgedInr": { "inr": 93849.79, "formatted": "₹93,849.79", "compact": "₹93,850" },
    "note": "limit = min(25% or 40% hedged of 10 epochs' swept revenue, 4 x bond, cap); swept revenue = inflation commission + tips commission; planned Pool parameters"
  }
}
```

- `revenue` is the last finished epoch, in SOL and in rupees at the price of the day it ended. `basis:
  'validator-profile'` = the same figures as the validator's profile page (`/v1/validators/:vote`); `table-estimate` =
  computed from today's stake, commission and APY while the profile loads (say "estimated").
- `credit` is **always an estimate** (`estimate: true`): label it "Estimated Epoch advance", show the hedged figure as
  "with a fee hedge", and print `note` small. Rupees are at the live price.
- `city` is `Unknown` when Stakewiz has no city. `status: 'unknown'` (Stakewiz has no country data): India's figures
  are `null`; say "Can't tell where validators are hosted right now", not "0".
- Errors: 400 `BAD_REQUEST` for a bad query (e.g. `sort=nonsense`).

## `GET /v1/india/wallets/:address/rewards?fy=2026-27`

A wallet's staking rewards for one Indian financial year (default: the current one). `fy` accepts `2026-27`,
`2026-2027` or `FY2026-27`, from `2020-21` to the current year. Read from the chain on first request: about 100–200
`getInflationReward` calls a year, **one to four minutes on the public RPC** (faster on a paid one), so the page polls.

Polling flow:

1. Call it. The first call waits up to 8 s; if the year is not read by then it answers `status: 'loading'` or
   `'partial'` with what is read so far and `retryAfterSeconds: 4`.
2. While `status` is `loading` or `partial`, call again every `retryAfterSeconds`; polls answer at once. Show
   progress: `stage: 'accounts'` → "Finding your stake accounts…"; `stage: 'rewards'` → "Reading epoch
   {coverage.epochsRead} of {coverage.epochsInYear}…" with the partial totals.
3. `complete`: done (cached 10 minutes). `incomplete`: done, but `coverage.failedEpochs` could not be read; show
   "{n} epochs couldn't be read; totals leave them out" and a retry button (retried after one minute).

Real answer for a public wallet, FY 2026-27 (trimmed to the last two epochs and months):

```json
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "kind": "real",
    "asOf": "2026-10-03T18:52:33+05:30",
    "source": "Solana mainnet RPC (stake accounts, getInflationReward), Stakewiz (epoch times), CoinGecko",
    "note": "the year so far: epochs that have ended",
    "wallet": "C9MDVY8HjxbsgiEDfPefxTvA63Ps39E5XHxGiZt4PDdd",
    "fy": { "label": "2026-27", "name": "FY 2026-27", "assessmentYear": "AY 2027-28", "startsAt": "2026-04-01T00:00:00+05:30", "endsAt": "2027-03-31T23:59:59+05:30", "current": true },
    "availableFys": ["2026-27", "2025-26", "2024-25", "2023-24", "2022-23", "2021-22", "2020-21"],
    "status": "complete",
    "stage": "done",
    "retryAfterSeconds": null,
    "coverage": { "epochsInYear": 99, "epochsRead": 99, "epochsPending": 0, "epochsFailed": 0, "failedEpochs": [], "firstEpoch": 949, "lastEpoch": 1047, "stakeAccounts": 5 },
    "totals": {
      "rewardSol": 3.583438592,
      "rewardInr": { "inr": 29082.3, "formatted": "₹29,082.30", "compact": "₹29,082" },
      "valueTodayInr": { "inr": 41205.53, "formatted": "₹41,205.53", "compact": "₹41,206" },
      "epochsWithRewards": 99,
      "epochsWithoutPrice": 0
    },
    "months": [
      { "month": "2026-09", "label": "Sep 2026", "rewardSol": 0.552563549, "rewardInr": { "inr": 5701.11, "formatted": "₹5,701.11", "compact": "₹5,701" }, "epochs": 21 },
      { "month": "2026-10", "label": "Oct 2026", "rewardSol": 0.046859611, "rewardInr": { "inr": 534, "formatted": "₹534.00", "compact": "₹534" }, "epochs": 2 }
    ],
    "epochs": [
      { "epoch": 1046, "endedAt": "2026-10-01T19:11:02+05:30", "date": "2026-10-01", "rewardSol": 0.023443413, "priceInr": 11391.28, "priceDate": "2026-10-02", "priceSource": "CoinGecko", "rewardInr": { "inr": 267.05, "formatted": "₹267.05", "compact": "₹267" } },
      { "epoch": 1047, "endedAt": "2026-10-03T03:20:01+05:30", "date": "2026-10-03", "rewardSol": 0.023416198, "priceInr": 11400.26, "priceDate": "2026-10-03", "priceSource": "CoinGecko", "rewardInr": { "inr": 266.95, "formatted": "₹266.95", "compact": "₹267" } }
    ],
    "livePrice": { "inr": 11498.88, "formatted": "₹11,498.88", "change24hPct": -2.32, "source": "CoinGecko", "asOf": "2026-10-03T18:51:00+05:30", "stale": false, "staleReason": null },
    "csvPath": "/v1/india/wallets/C9MDVY8HjxbsgiEDfPefxTvA63Ps39E5XHxGiZt4PDdd/rewards.csv?fy=2026-27",
    "disclaimer": "Informational only, not tax advice. …"
  }
}
```

The same wallet's FY 2025-26: 185 epochs read in about four minutes on the public RPC, 3.767 SOL = ₹47,793.07; 18
epochs (29 Aug to 2 Oct 2025, older than CoinGecko's free 365 days) priced with `Binance SOL/USDT × ECB USD/INR`, the
rest with CoinGecko. On 4 Oct 2025 the two sources differed by 0.04%.

- Each epoch's reward is credited when the epoch ends; `endedAt` decides the FY (31 Mar 23:59 IST is the old year,
  1 Apr 00:00 IST the new one). `rewardInr` uses the daily price nearest `endedAt` (`priceDate`, `priceSource`).
- `epochs` lists epochs with a reward only, oldest first. `months` covers April to the current month (all twelve for
  a past year), for a bar chart.
- `totals.rewardInr` is the sum of the rows as shown (each rounded to paise), so the CSV adds up. If
  `epochsWithoutPrice > 0` it leaves those epochs out: say so. `valueTodayInr` is the same SOL at today's price
  ("worth ₹41,205.53 today").
- Show `disclaimer` verbatim near the totals and the CSV button.
- Empty: a wallet with no stake accounts answers `complete` with zeros and a note ("This wallet has no stake
  accounts. Rewards appear here once you stake.").
- Not included (the disclaimer says so): Jito MEV tips claimed into stake accounts, liquid-staking tokens (JitoSOL,
  mSOL…: their rewards are in the token price) and stake accounts closed before today.

Errors: 400 `BAD_REQUEST` (not a Solana address, or a year outside 2020-21 to now) · 429 `TOO_MANY_REQUESTS` (60
requests a minute per IP, or 20 new wallet-years an hour per IP; `details.retryAfterSeconds`) · 502 `CHAIN_ERROR`
(stake accounts unreadable; retry) · 503 `EPOCH_TIMES_UNAVAILABLE` (Stakewiz epoch times never loaded; retry in 30 s)
· 503 `BUSY` (25 wallets loading at once; retry in 30 s).

## `GET /v1/india/wallets/:address/rewards.csv?fy=2026-27`

The same year as a spreadsheet: `text/csv; charset=utf-8`, a UTF-8 byte-order mark (Excel then shows ₹), CRLF line
ends, `Content-Disposition: attachment; filename="epoch-staking-rewards-FY2026-27-C9MD-PDdd.csv"`. Link to `csvPath`
(on the API's origin) with a plain `<a href>` once the JSON says `complete` or `incomplete`: the browser saves it
under that name; a `fetch` from another origin cannot read the file name. While the year is loading it answers 503
`REWARDS_LOADING` (`details.retryAfterSeconds`, `epochsRead`, `epochsInYear`). 10 downloads a minute per IP.

```text
Epoch,Credited at (IST),Date (IST),Financial year,Reward (SOL),SOL price (₹),Price date (IST),Price source,Reward (₹),"Reward (₹, formatted)"
949,2026-04-02 03:41:01,2026-04-02,2026-27,0.040947090,7550.59,2026-04-02,CoinGecko,309.17,₹309.17
…
1047,2026-10-03 03:20:01,2026-10-03,2026-27,0.023416198,11400.26,2026-10-03,CoinGecko,266.95,₹266.95
Total,,,2026-27,3.583438592,,,,29082.30,"₹29,082.30"

Wallet,C9MDVY8HjxbsgiEDfPefxTvA63Ps39E5XHxGiZt4PDdd
Financial year,"FY 2026-27 (AY 2027-28), 2026-04-01T00:00:00+05:30 to 2027-03-31T23:59:59+05:30"
Status,complete: 99 of 99 epochs read
Generated (IST),2026-10-03 18:52:33
Notes,the year so far: epochs that have ended
Disclaimer,"Informational only, not tax advice. …"
```

## Copy suggestions (India-first)

- Title: **Solana staking, in rupees.** Optional Hindi line under it: _आपकी स्टेकिंग, रुपयों में_.
- Price hero: "1 SOL = ₹11,501.20" (₹ first, SOL second everywhere). Under it: "CoinGecko · 18:48 IST". Stale:
  "Last known price · 6 min old" in amber, never green.
- Lakh and crore, not millions: "₹2.92 L a month", "₹230.02 Cr staked", "44.2 crore SOL staked on Solana".
- Financial-year language: "FY 2026-27 (AY 2027-28)", "1 Apr – 31 Mar", "so far this year". FY picker: "This year
  (2026-27)", "Last year (2025-26)", then older years.
- Rewards headline: "₹29,082.30 earned in FY 2026-27 so far · worth ₹41,205.53 today". Button: **Download CSV for
  your CA**. Under it, the disclaimer verbatim.
- Loading: "Reading your rewards from Solana: epoch 37 of 99…" (a year takes a minute or two the first time).
- India on the map, empty: "No Solana validator is hosted in India yet. Singapore hosts 44." Then: "Start one:
  from about 1 lakh SOL of stake (`breakEvenStakeSol`) a validator here covers its vote fees. At 1.5 lakh SOL, after
  10 epochs, Epoch could advance up to ₹67,692 against its revenue (estimate, not an offer)."
- Credit figures: always "Estimated Epoch advance", never "your credit limit".
- Avoid tax claims ("tax-ready", "ITR-compliant"); say "a record for your CA".
