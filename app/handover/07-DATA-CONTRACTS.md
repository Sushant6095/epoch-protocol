# 07 · Data contracts

The browser never scans the chain itself: heavy reads go through the repo's indexer and `api_app`, and
the page gets small JSON plus one websocket. Only the wallet's own actions go straight to RPC.

What exists today, which API and which program instruction each screen uses, and the words for every
program error: `13-BACKEND-AND-PROGRAM-MAP.md`.

- **Types:** `contracts/epoch-data.ts` → copy to `src/lib/data/types.ts`. Units live in field names
  (`…Sol`, `…Pct` 0–100, `…Share` 0–1, `…Epoch`). Every payload carries `kind` (real/sample/demo),
  `asOf`, `source`.
- **Fixtures:** `fixtures/*.json` match those types exactly (schemaVersion 1) → copy to `src/fixtures/`.
- **API base:** `NEXT_PUBLIC_EPOCH_API_URL` (local `http://localhost:4000`, which `api_app` already allows
  through `API_CORS_ORIGINS=http://localhost:3000`). Put the variable name in `app/.env.example`; the
  value lives in your untracked `.env.local`.
- **Every response is wrapped** (`packages/common_http_server`): `{ ok: true, data }` on success,
  `{ ok: false, error: { code, message, details }, traceId }` on failure (`ApiResponse<T>` in the contract).
  `apiGet` unwraps it, so hooks get `data` and errors carry the code.
- **Live examples:** `api-samples/*.json` are real responses (envelope included) captured on 1 Oct from the API
  build below. Use them to test a hook's switch from fixture to API; they match the contract types.

**Built and tested on 1 Oct, waiting to be committed.** `GET /v1/network`, `/v1/network/stake-history`,
`/v1/validators`, `/v1/delegators/biggest` and `/v1/delegators/retail-magnets` are built in `packages/api_app` for the
branch `feat/api-network-validators-delegators` (README there); Sushant commits, merges and deploys them (#25). Once
the branch is pushed, run it with
`pnpm --filter @epoch/api_app build && API_PORT=4000 node packages/api_app/dist/index.js`; it reads mainnet
through `DATA_RPC_URL` (the public RPC by default). The delegator endpoints answer `503 NOT_READY` for about
five minutes after the API starts, while the stake-account scan runs, and `/v1/network` sends `delegators: null`
until then.

## Hooks → endpoints → fixtures

| Hook (`src/lib/data/`) | Endpoint | Status | Fixture | Type | Refresh |
| --- | --- | --- | --- | --- | --- |
| `useFeeIndex({ from, to, limit })` | `GET /v1/index?from=&to=&limit=` → `FeeIndexPoint[]` newest first | **exists** in `packages/api_app`: `{ epoch, value, status?, mainnetEpoch, clusterEpoch }`, numbered by mainnet epoch | `fee-index.sample.json` | `FeeIndexSeries` | per epoch |
| `useNetwork()` | `GET /v1/network` | **built** 1 Oct (to deploy, #25) | `network.real.json` | `NetworkSnapshot` | 1 min; slot/epoch live over WS |
| `useStakeHistory(64)` | `GET /v1/network/stake-history?epochs=64` | **built** 1 Oct (to deploy, #25) | `stake-history-64.real.json` | `StakeHistory` | per epoch |
| `useValidators(query)` | `GET /v1/validators?tab=&chips=&q=&sort=&dir=&fee=&client=&country=&votes=&cursor=&limit=` | **built** 1 Oct (to deploy, #25) | `validators.real.json` (26 of 683) | `ValidatorList` | 1 min |
| `useTopValidators()` | `GET /v1/validators?sort=stake&limit=8` (a `ValidatorList`; keep its `rows`, which carry every `TopValidatorRow` field) | **built** 1 Oct (to deploy, #25) | `top-validators.real.json` | `TopValidators` | 1 min |
| `useValidator(vote)` | `GET /v1/validators/:vote` | requested | `validator-ntt-docomo.real.json` | `ValidatorProfile` | 1 min |
| `useOperatorPosition(vote)` | `GET /v1/validators/:vote/position` (ValidatorPosition + open Advance) | requested | `operator-position.sample.json` | `OperatorPosition` | on change |
| `useBiggestDelegators()` · `useRetailMagnets()` | `GET /v1/delegators/biggest?limit=10` · `/v1/delegators/retail-magnets?limit=10` | **built** 1 Oct (to deploy, #25); `503 NOT_READY` until the first scan | `biggest-delegators.real.json` · `retail-magnets.real.json` | `BiggestDelegators` · `RetailMagnets` | every 12 h (the scan) |
| `useActivity()` | `WS /v1/stream` channel `activity` (+ `GET /v1/activity?limit=50` for first paint) | requested | `activity.sample.json` | `ActivityFeed` | live |
| `useVault()` | `GET /v1/vault` | requested | `vault.sample.json` | `VaultSnapshot` | on change (WS `vault`) |
| `useMyStake(wallet)` | `GET /v1/wallets/:address/stake` | requested | `my-stake.demo.json` | `MyStake` | on sign-in, then per epoch |
| `usePredict()` | `GET /v1/predict/markets` + `GET /v1/predict/leaderboard`, served by `api_app` in points mode; a call is `POST /v1/predict/calls { marketId, side, points }` with the session cookie, no wallet transaction | requested (#11) | `predict.sample.json` | `PredictSnapshot` (call body: `PredictCallRequest`) | live; refetch after each call |
| `useSession()` | `POST /v1/auth/siws/nonce` · `POST /v1/auth/siws/verify` · `POST /v1/auth/logout` | requested | — | `{ address, roles[] }` | on sign-in |
| `useLenderPosition(address)` | `GET /v1/wallets/:address/lender` (or RPC reads of the Lender PDAs with the IDL) | requested (#8d) | — (the boards use the demo wallet) | `LenderPosition` | on sign-in, then on WS `vault` |
| `useWatchlist()` | `GET` · `PUT /v1/me/watchlist`; signed out: local storage `epoch.watchlist` | requested (#14) | — | `Watchlist` | on change |
| `useAlerts()` | `GET` · `PUT /v1/me/alerts` | requested (#15) | — | `AlertPrefs` | on change |
| `useFeeMarket()` | `GET /v1/market` (Epoch's quotes with their index status, stats, the session wallet's swaps, `myHedge` for operators); transactions through epoch-sdk `openSwap`, `openSwaps`, `settleSwap` on the devnet RPC | requested (#19, #20) | `fee-market.sample.json` | `FeeMarketSnapshot` (ticket body: `OpenSwapRequest`) | on WS `feeIndex` and `activity` (kind `swap`), after each transaction |
| `useLaunches()` · `useLaunch(mint)` | `GET /v1/launches` · `GET /v1/launches/:mint`; trades through `@epoch/meteora` (DBC `swapQuote2` + `swap2` on the curve, DAMM v2 after graduation) | requested (#22, #23) | `launches.sample.json` · `launch-rkest.sample.json` | `LaunchList` · `LaunchDetail` (quotes: `LaunchTradeQuote`) | 1 min; on WS `activity` (kind `buyback`); after each trade |

Fields the click map needs on existing types (optional in `contracts/epoch-data.ts` until they ship): `ValidatorRow`
`mevCommissionPct`, `delinquent`, `commissionHistory`, `stakeHistorySol`; `ValidatorList` `total`, `nextCursor`, `facets`
(request #5b; the 1 Oct build sends all of them except `commissionHistory` and `stakeHistorySol`); `BiggestDelegators.rows[].address`, `RetailMagnets.rows[].vote` (#6b); `Advance.vote`,
`withdrawQueue[].signature` and `isMine`, `VaultSnapshot.cycle` (#8c); `MyStakeAccount.stakeAccount` (#10b);
`LenderPosition.withdrawRequests[].status` (`"bounced"`, #8d).

Websocket `WS /v1/stream` channels: `slot` (slot, epoch, slotIndex, leader), `activity`, `vault`, `feeIndex`.
Push updates into the query cache with `queryClient.setQueryData`; charts call `series.update()` only.

## The hook pattern (fixture now, API later — one line to switch)

```ts
// src/lib/data/api.ts
import type { ApiResponse } from "./types";

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_EPOCH_API_URL}${path}`, { credentials: "include" });
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.ok) throw new ApiError(body.error.code, body.error.message, res.status, body.error.details);
  return body.data;
}

// One switch per resource: flip it when the endpoint is deployed.
export const USE_API = { feeIndex: true, network: false, stakeHistory: false, validators: false, delegators: false };
```

```ts
// src/lib/data/useNetwork.ts
import { useQuery } from "@tanstack/react-query";
import type { NetworkSnapshot } from "./types";
import fixture from "@/fixtures/network.real.json";
import { apiGet, USE_API } from "./api"; // USE_API reads NEXT_PUBLIC_EPOCH_API_URL

export function useNetwork() {
  return useQuery({
    queryKey: ["network"],
    queryFn: () => (USE_API.network ? apiGet<NetworkSnapshot>("/v1/network") : (fixture as NetworkSnapshot)),
    staleTime: 60_000,
  });
}
```

`USE_API` is a per-resource map so each hook flips when its endpoint ships (`{ feeIndex: true, … }`).
Components never import fixtures or call `fetch` directly.

**Fee Index adapter.** The live `GET /v1/index` returns a bare `FeeIndexPoint[]` (newest first), while the
fixture is a `FeeIndexSeries`. `useFeeIndex` always returns `FeeIndexSeries`, wrapping the API array:

```ts
const points = await apiGet<FeeIndexPoint[]>(`/v1/index?limit=${limit}`);
return { schemaVersion: 1, kind: "real", asOf: new Date().toISOString(), source: "api_app /v1/index",
         unit: "µL/CU", unitLong: "micro-lamports per compute unit", points } satisfies FeeIndexSeries;
```

**What a hook returns while it is still on fixtures** (so no page silently shows the wrong entity):

| Hook | Argument matches the fixture | Anything else |
| --- | --- | --- |
| `useValidator(vote)` | NTT DOCOMO's vote key → the full profile | build a partial profile from that vote's row in `validators.real.json` (name, stake, APY, fee, score, health); every other field renders "—" with a quiet "Full history arrives with the API" note; unknown vote → 404 |
| `useOperatorPosition(vote)` | NTT DOCOMO → `not_onboarded`; Northwind (by name, fictional) → `advance_open` | `not_onboarded` with the limit computed from the validator's row, marked Sample |
| `useMyStake(wallet)` | the demo wallet → the demo | any signed-in or pasted wallet also gets the demo, with a "Demo data" badge on the page header, until `GET /v1/wallets/:address/stake` ships |
| `useValidators(query)` | — | filter and sort the 26 fixture rows client-side with the same URL params the API will take |
| `useBiggestDelegators()` · `useRetailMagnets()` on the API | — | on `503 NOT_READY` keep showing the fixture (Sample badge) with "Delegator scan running: N of 682 validators" from `error.details`, and retry every 30 s |
| `useFeeMarket()` | — | the fixture with the Sample badge; `myPositions` and `myHedge` belong to the demo wallet ("You", the operator of the fictional Fernhill Validator) |
| `useLaunch(mint)` | `rKEST` → the detail fixture | another symbol from `launches.sample.json` → its summary with "—" for the detail blocks; unknown → 404 |

## Where every number comes from (for Sushant's endpoints and for tooltips)

| What the UI shows | Source | Method | Refresh | Today |
| --- | --- | --- | --- | --- |
| Slot, epoch, progress, countdown, leader | Solana RPC / Yellowstone gRPC (Solami) | `getEpochInfo`, slot stream, `getLeaderSchedule` | every slot | live |
| Validators: stake, commission, credits, delinquent | Solana RPC | `getVoteAccounts` | 1 min; full per epoch | live |
| Names, logos, location, host, client version | validators.app, Stakewiz, gossip | REST; `getClusterNodes` | daily | live |
| APY split (staking + tips) | Stakewiz; Jito Kobe | REST | per epoch | live |
| Blocks per day, skip rate | Solana RPC | `getBlockProduction` | hourly | live |
| Delegators per validator, biggest share, median wallet | Stake program accounts | `getProgramAccounts` (Stake), cached in Postgres | nightly | live (heavy) |
| Stake moves, network in/out | indexer; StakeHistory sysvar | stake-account changes | per epoch | live |
| Health per epoch (SOL kept after vote fees) | derived | commission + tips + block fees − ≈ 2.2 SOL vote fees | per epoch | live, estimated |
| Epoch Score | program `ValidatorPosition.score`; same formula off-chain before onboarding | account read | per epoch | live formula |
| SOL price, INR rate | Jupiter price API; an FX API | REST | 1 min; 1 h | live |
| A wallet's stake accounts and rewards | Solana RPC | `getProgramAccounts` by staker/withdrawer; `getInflationReward` | on sign-in, then per epoch | live |
| Vault, tranches, advances, lenders, queue | program `Pool`, `ValidatorPosition`, `Advance`, `LenderShares`, `WithdrawRequest` | indexer + websocket | on change | sample |
| Fee Index | program `FeeIndex`, posted by `publisher_app` | account read / `GET /v1/index` | per epoch | sample |
| Fee Market quotes, swaps and settlements | program `FeeQuote`, `SwapPosition`, `FeeIndex` on devnet; `SwapOpened` / `SwapSettled` events for history | indexer + `GET /v1/market` | on change | sample |
| Revenue tokens: curve, price, buybacks | Meteora DBC pool (`getPool`, `getPoolQuoteTokenCurveProgress`), DAMM v2 pool, Epoch's revenue-token and escrow accounts | indexer + `GET /v1/launches` | 1 min; buybacks live | sample |
| Predict markets, calls and leaderboard (points) | `api_app` in points mode; each market resolves from the final Fee Index value (Panta only behind `PREDICT_REAL_SOL`, off) | `GET /v1/predict/markets`, `GET /v1/predict/leaderboard`, `POST /v1/predict/calls` | live; settles when the Fee Index turns final | sample |

## Explorer links (formats tested 29 Sep 2026) — build them in `src/lib/explorers.ts`

| Explorer | Account or vote | Transaction |
| --- | --- | --- |
| Solana Explorer | `https://explorer.solana.com/address/<key>` | `https://explorer.solana.com/tx/<sig>` |
| Orb | `https://orbmarkets.io/address/<key>` | `https://orbmarkets.io/tx/<sig>` |
| Solscan | `https://solscan.io/account/<key>` | `https://solscan.io/tx/<sig>` |
| Solana Beach | `https://solanabeach.io/validator/<vote>` | — |
| validators.app | `https://www.validators.app/validators/<identity>?network=mainnet` (identity, not vote) | — |
| Stakewiz | `https://stakewiz.com/validator/<vote>` | — |

Add `?cluster=devnet` on Solana Explorer and Solscan for anything on the Epoch program while it runs on devnet
(decision 6): Vault, Manage, Fee Market and Launch accounts and transactions. Devnet links go to Solana Explorer, which
takes `?cluster=devnet`; Orb stays for mainnet (decision 24). Mainnet data and staking links stay as they are.

## Rules

- A missing value renders "—", never 0. Every number has a timestamp tooltip (`asOf` + `source`).
- Two networks (decision 6, settled 1 Oct), two RPC variables. `NEXT_PUBLIC_SOLANA_RPC_URL`: mainnet, for the
  live data on the Terminal, Validators and My Stake and for native staking (Stake program: stake, move,
  unstake). `NEXT_PUBLIC_EPOCH_RPC_URL`: devnet, for the Epoch program (Vault, Validator → Manage, onboarding
  and Borrow, the Fee Market, Launch and its Meteora pools) during the demo and the 5 Oct gate. Names only in `app/.env.example`; values
  live in `.env.local`.
- Every screen that uses the Epoch program shows a "Devnet" network badge and one line: "Epoch's program runs
  on devnet for now. Switch your wallet to devnet to sign." The footer's network badge reads mainnet (the
  chain data).
- `kind: "sample"` or `"demo"` → Sample badge. Badges disappear by themselves the moment the program's
  accounts exist on devnet.
- Protocol parameters come from `VaultSnapshot.params` (the Pool account), never from literals.
- A dropped live feed keeps the last value, greys the live dot and says "updated N min ago".
- Never log or send a wallet's full address to any third-party analytics.
