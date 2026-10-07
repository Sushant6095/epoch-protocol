# Solami: every call, checked against the current docs

Round 4, 7 Oct 2026, 14:17–14:30 IST, branch `feat/r4-sidetracks`. Track: Solami (RPC, Yellowstone gRPC, Beam).
Every call Epoch makes to Solami was checked against Solami's current docs: the `indexer_app` streams, block fetcher and
checks, `packages/solana` (Beam sends, tip addresses, the usage report) and the `api_app` Live API. Solami's docs are
`https://solami.dev/llms.txt`, its text index, and the API reference at `https://solami.dev/docs`, a single-page app.
Its per-route pages ship as content-hashed chunks. Solami runs standard Yellowstone gRPC and Solana JSON-RPC, so the
field-level reference for those is Yellowstone's `geyser.proto` and Solana's RPC docs.

**Result.** All 13 rows below are backed by a doc line and a test. One gap was found and fixed: websocket URLs derived
from a Solami RPC URL pointed at the wrong host (`4b26415`). Solami's documented routes have not changed since the 5 Oct
reconcile.

## What changed at Solami since 5 Oct

| Source | 5 Oct | 7 Oct, 14:17 IST | Changed? |
| --- | --- | --- | --- |
| `https://solami.dev/llms.txt` | round-2 snapshot | same text | No |
| API reference (`/docs` bundle) | `index-oG1FcWUY.js` | `index-BGR53Mdb.js` (rebuilt) | Routes: no. All 250 per-route chunks keep their content hashes (for example `get_onchain-tip-addresses-KGECPomJ.js`, `get_swqos-tx-_signature_-Dp1kewv2.js`, `grpc_solami_swqos-swqosservice-submit-Bc4wZOOv.js`). Only the site's wallet UI chunks changed (`w3m-*`, `wui-*`, onramp, socials) |
| npm `solami` (the official SDK) | 0.1.56 | 0.1.56 (last publish 7 Jul) | No |
| `GET https://api.solami.dev/pricing` | snapshot | identical object | No |
| `GET https://api.solami.dev/onchain/tip-addresses` | 15 addresses | the same 15 | No. Our pinned fallback (the SDK's 10 `…beam` accounts) is a subset, so it stays valid |

Every request above went to a public, unauthenticated route, once each. No key was used.

## How to read the table

"llms l. N" is the line in `https://solami.dev/llms.txt` (fetched 7 Oct 2026, 14:17 IST). "Endpoints table" and "Auth,
by transport" are sections of Solami's API reference (`solami.dev/docs`, the guide pages in the current bundle).
"proto l. N" is `yellowstone-grpc-proto/proto/geyser.proto` on `rpcpool/yellowstone-grpc` `master`, fetched 7 Oct. Our
client, `@triton-one/yellowstone-grpc` ^7.0.1, types the same fields, and `master` only adds optional fields we do not
set (cuckoo-filter and token-account expansion). Solana RPC methods link to `solana.com/docs/rpc`.

## Calls

| # | Call | Where | Doc | Test | Status |
| --- | --- | --- | --- | --- | --- |
| S1 | Yellowstone `Subscribe` firehose: `transactions { vote: false }` (failed included), `slots { filterByCommitment: false, interslotUpdates: false }`, `blocksMeta`, `commitment: CONFIRMED`, `fromSlot` | `indexer_app/src/Streams/SlotRequest.ts`, `SlotStream.ts` | llms l.10 (Yellowstone gRPC streams); proto l.39–50 (`SubscribeRequest`: slots, transactions, blocks_meta, commitment, ping, from_slot), l.107–118 (slot and transaction filters) | `SlotStream.test.ts`, `SlotWatermark.test.ts`, `packages/solana` `GrpcStream.test.ts` | ✓ |
| S2 | Plan stream: `blocksMeta` and `slots` only, then RPC `getBlock` per slot | `SlotRequest.ts`, `BlockFetcher.ts` | proto l.41, l.45; [`getBlock`](https://solana.com/docs/rpc/http/getblock) | `SlotStream.test.ts`, `BlockFees.test.ts`, `SolanaRpc.test.ts` | ✓ |
| S3 | gRPC auth on `x-token`, `grpc.solami.dev:443`; reconnect with a `fromSlot` replay; server pings dropped, and 60 s of silence counts as a dead stream | `packages/solana` `GrpcStream.ts`, `SlotStream.ts` | Endpoints table ("gRPC / Geyser `https://grpc.solami.dev` (port 443) … `x-token` metadata"); Auth, by transport ("gRPC: `x-token` metadata"); proto l.49–50 (`ping`, `from_slot`). The docs ask no client pings | `GrpcStream.test.ts`, `SlotStream.test.ts` | ✓ |
| S4 | RPC `getBlock` (`encoding: 'base64'`, `maxSupportedTransactionVersion: 1`, `transactionDetails: 'full'`) | `indexer_app/src/Blocks/*`, `Rpc/SolanaRpc.ts` | [`getBlock`](https://solana.com/docs/rpc/http/getblock); llms l.9 (Solami RPC: Solana JSON-RPC on bare metal) | `SolanaRpc.test.ts`, `BlockFees.test.ts` | ✓ |
| S5 | RPC `getSlot`, `getEpochInfo`, `getEpochSchedule`, `getSlotLeaders`, `getVoteAccounts`, `getVersion` | `indexer_app`, `Check/SolamiCheck.ts` | [Solana HTTP methods](https://solana.com/docs/rpc/http); llms l.9 | `SolanaRpc.test.ts`, `SolamiCheck.test.ts`, `LeaderSchedule.test.ts`, `EpochTracker.test.ts` | ✓ |
| S6 | RPC `getSignaturesForAddress`, then `getTransaction` (program-event backfill) | `api_app` program event ingester | [`getSignaturesForAddress`](https://solana.com/docs/rpc/http/getsignaturesforaddress), [`getTransaction`](https://solana.com/docs/rpc/http/gettransaction) | `ProgramEventIngester.test.ts`, `ProgramLogsSource.test.ts` | ✓ |
| S7 | WS `logsSubscribe` (program mentions, `confirmed`): with a Solami RPC URL and no explicit WS URL, it now connects to `wss://[<region>.]ws.solami.dev/ws/sol?api_key=…` | `api_app/src/Sources/EpochProgramSource.ts` (`solamiWsUrl`, `toWsUrl`), `Sources/ProgramLogsSource.ts`, `Services/Launch/LaunchLive.ts` | Endpoints table ("WebSocket `wss://ws.solami.dev/ws/sol` … `?api_key=`"; a region prefixes every host); [`logsSubscribe`](https://solana.com/docs/rpc/websocket/logssubscribe) | `EpochProgramSource.test.ts` (new test: global, region-pinned, trailing slash, look-alike hosts and plain http left alone), `ProgramLogsSource.test.ts` | **fixed** (`4b26415`) |
| S8 | Beam: a `sendTransaction` (web3.js `sendRawTransaction`, base64, `skipPreflight: true`, `maxRetries: 0`) to the Solami RPC URL, carrying a transfer of at least 100,000 lamports to a current tip address | `packages/solana` `Beam.ts`, `TransactionSender.ts` | llms l.12 ("Beam … 0.0001 SOL minimum tip … beam-http.solami.dev (HTTP)") = `BEAM_MIN_TIP_LAMPORTS` | `Beam.test.ts`, `TransactionSender.test.ts` | ✓ |
| S9 | `GET https://api.solami.dev/onchain/tip-addresses` (no auth, cached 10 min, pinned fallback from SDK 0.1.56) | `Beam.ts` | llms l.78 (the four onchain routes, including `GET /onchain/tip-addresses`); route chunk `get_onchain-tip-addresses-KGECPomJ.js` (unchanged) | `Beam.test.ts` | ✓ |
| S10 | Beam landing: `GET api.solami.dev/swqos/tx/{signature}`; HTTP lane `beam-http.solami.dev` | `Beam.ts`, `SolamiUsage.ts` | route chunk `get_swqos-tx-_signature_-Dp1kewv2.js` (unchanged); llms l.12 | `Beam.test.ts`, `SolamiUsage.test.ts` | ✓ |
| S11 | Usage report `GET /v1/live/solami`: RPC per-method latency, gRPC bytes and updates, Beam landed and tips | `packages/solana` `SolamiUsage.ts`, `api_app` `LiveRouter` | [`docs/pages/live.md`](../pages/live.md) l.236; llms l.9–12 (what is billed: RPC compute units, gRPC GB, Beam tips) | `SolamiUsage.test.ts`, `LiveRouter.test.ts` | ✓ |
| S12 | `pnpm solami:check`, `pnpm demo:solami` | `indexer_app/src/Check/*` | the calls of S1–S5 and S8 | `SolamiCheck.test.ts`, `DemoReport.test.ts` | ✓ (the scripts need a Solami key: without `SOLAMI_TOKEN` the gRPC check fails, and without `SOLAMI_RPC_URL` the RPC checks are skipped; not run) |
| S13 | API `/v1/live/summary`, `slots`, `leaders`, `epochs/:e/distribution`, `solami`; WS `slots` and `index:live` on `/v1/stream` | `api_app/src/Routes/LiveRouter.ts`, `Services/Live` | `live.md` l.23, l.91, l.152, l.206, l.236, l.382 | `LiveRouter.test.ts`, `LiveService.test.ts`, `LiveFeed.test.ts`, `SolamiStream.test.ts` | ✓ |

### The gap fixed: Solami's websocket host

Solami serves JSON-RPC at `https://rpc.solami.dev/sol` but its WebSocket at `wss://ws.solami.dev/ws/sol`, both keyed by
`?api_key=`, and a region (`fra`, `ams`, `nyc`) prefixes either host (Endpoints table). With `EPOCH_RPC_WS_URL` unset,
the program-event listener derived its websocket by swapping `https` for `wss`, which gives
`wss://rpc.solami.dev/sol`. The Launch page's realtime connection let web3.js do the same. `solamiWsUrl` now maps the
documented RPC forms to the documented websocket host and returns `undefined` for any other URL. Every other provider,
and localnet with web3.js's port + 1, behaves as before. An explicit `EPOCH_RPC_WS_URL` or `LAUNCH_RPC_WS_URL` still
wins.

## Tests

| Command | Result |
| --- | --- |
| `pnpm --filter @epoch/solana test` | 8 suites, 75 tests, all pass |
| `indexer_app` (`TEST_DATABASE_URL=…epoch_test_r4_sidetracks`) | 11 suites, 76 tests, all pass |
| `api_app`: `jest Live Solami` | 5 suites, 27 tests, all pass |
| `api_app`: `EpochProgramSource`, `LaunchLiveChain`, `LaunchRealtime` (after `4b26415`) | 3 suites, 17 tests, all pass |
| `api_app`: `ProgramEventIngester`, `ProgramLogsSource`, `EpochProgramSource` | 3 suites, 21 tests, all pass |
| `tsc --noEmit` (`api_app`), eslint, prettier on the changed files | OK |

## Open

- `pnpm solami:check` and `pnpm demo:solami` need a Solami key (the user's), so they were not run here.
- Before the 13 Oct submission, repeat the freshness checks: `llms.txt`, the per-route chunk names in the `/docs` bundle,
  npm `solami`, and the tip-address list.
