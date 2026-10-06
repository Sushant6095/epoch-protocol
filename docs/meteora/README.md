# How Epoch uses Meteora

A validator's revenue token launches on a Meteora **Dynamic Bonding Curve** (DBC) and graduates to a **DAMM v2** pool.
The Epoch program buys it back with the validator's revenue share and burns it (ADR 0006,
[REVENUE_TOKENS_MAINNET.md](../REVENUE_TOKENS_MAINNET.md)). This page maps what Epoch uses from Meteora and where it
lives. Round 3's audit against Meteora's own rules is [SKILL-AUDIT.md](SKILL-AUDIT.md). The comparison with Meteora's
studio CLI is [STUDIO-CROSSCHECK.md](STUDIO-CROSSCHECK.md).

## Programs

| Program | ID (mainnet = devnet) | Epoch uses it for |
| --- | --- | --- |
| DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | The launch: config (curve, fees, migration, LP), pool and first buy, curve trades, partner and creator claims, migration |
| DAMM v2 (cp-amm) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | The graduated pool: trades, buybacks, the treasury's locked LP position and its fees |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | The token's metadata (immutable) |

The Epoch program talks to both by CPI. `register_revenue_token` checks the DBC config (`check_launch_config`).
`execute_buyback` swaps on the venue. The treasury PDA `["treasury", pool]` is the DBC partner (fee claimer and leftover
receiver), and the program signs its claims (`claim_partner_trading_fee`, `claim_partner_surplus`,
`claim_partner_migration_fee`, `burn_leftover`, `claim_treasury_lp_fee`).

## SDKs

| Package | Version | Where |
| --- | --- | --- |
| `@meteora-ag/dynamic-bonding-curve-sdk` | 1.5.13 (the skill pins 1.5.11) | `packages/meteora` |
| `@meteora-ag/cp-amm-sdk` | 1.5.1 (the skill pins 1.4.5) | `packages/meteora` |

All Meteora code goes through `@epoch/meteora` ([`packages/meteora`](../../packages/meteora)): browser-safe and on
web3.js v1. The differences between the pinned and installed versions are listed in
[SKILL-AUDIT.md § SDK versions](SKILL-AUDIT.md#sdk-versions).

| Concern | Code |
| --- | --- |
| The revenue-anchored curve (custom sqrt prices, Epoch's preset) | [`src/curve.ts`](../../packages/meteora/src/curve.ts), [`src/constants.ts`](../../packages/meteora/src/constants.ts), [`src/math.ts`](../../packages/meteora/src/math.ts) (DAMM v2 seed with Meteora's 0.2% protocol fee) |
| The launch CLI and its preflight (Meteora's `validateConfigParameters`, the program's `check_launch_config`) | [`scripts/launch-revenue-token.ts`](../../packages/meteora/scripts/launch-revenue-token.ts), [`src/launchPreflight.ts`](../../packages/meteora/src/launchPreflight.ts), [`scripts/register-revenue-token.ts`](../../packages/meteora/scripts/register-revenue-token.ts) |
| Pool reads (curve progress, graduation, the DAMM v2 pool) | [`src/pools.ts`](../../packages/meteora/src/pools.ts) |
| Quotes and unsigned trade transactions (`swapQuote2`/`swap2`, `getQuote2`; compute budget; slippage 1–5,000 bps) | [`src/trade.ts`](../../packages/meteora/src/trade.ts) |
| Buyback quotes for the crank | [`src/buyback.ts`](../../packages/meteora/src/buyback.ts) |
| Claims (partner, creator, surplus, migration fee, leftover, LP fees) | [`src/claims.ts`](../../packages/meteora/src/claims.ts) |
| Graduation (`migrateToDammV2`) | [`src/migration.ts`](../../packages/meteora/src/migration.ts) |
| Trade and fee events from DBC / DAMM v2 transactions | [`src/events.ts`](../../packages/meteora/src/events.ts) |
| Parity with the SDK's own state helpers (`getPoolQuoteTokenCurveProgress`, `getPoolFeeBreakdown`) | [`src/stateParity.test.ts`](../../packages/meteora/src/stateParity.test.ts) |

The rest of the system uses `@epoch/meteora`:

- **api_app:** the Launch page ([`Services/Launch/`](../../packages/api_app/src/Services/Launch), contract in
  [docs/pages/launch.md](../pages/launch.md)).
- **cranks_app:**
  - `LaunchMigrationJob`, which graduates completed curves, since Meteora's keepers only take 10 SOL raises;
  - `LaunchFeeClaimJob`, the treasury and creator claims;
  - `BuybackJob`, the program's slices
  ([cranks_app README](../../packages/cranks_app/README.md#launch-fee-claims-plan-f13-adr-0006)).

## Meteora's agent skill

Vendored, unmodified, at [`.claude/skills/meteora/`](../../.claude/skills/meteora/SKILL.md) (MIT, commit `dd77ef3`;
[`SOURCE.md`](../../.claude/skills/meteora/SOURCE.md) says how to update it). An agent working in this repo picks it up
for any DBC, DAMM v2 or studio task. Read it with [SKILL-AUDIT.md](SKILL-AUDIT.md), where Epoch's preset departs from
Meteora's defaults on purpose:

- a fixed 1% fee with no dynamic fee;
- a creator trading-fee share of 0;
- a 70% migration fee to the validator;
- 100% of the LP locked with the treasury;
- the treasury PDA as fee claimer and leftover receiver.

## Meteora's docs MCP

[`.mcp.json`](../../.mcp.json) declares `meteora-docs`, an HTTP MCP server at `https://docs.meteora.ag/mcp`. It has search
and read tools over docs.meteora.ag, always current. Use it before trusting an SDK snippet from memory. Every page is
also raw markdown (index: `https://docs.meteora.ag/llms.txt`). The pages Epoch relies on most:

- DBC: what-is-dbc, fee scheduler, migration (the keepers and the 0.2% protocol migration fee), LP distribution, the
  TypeScript SDK guide.
- DAMM v2: what-is-damm-v2, fee modes, position NFTs, the data-API reference.

## Meteora's studio CLI

[`meteora-invent/studio`](https://github.com/MeteoraAg/meteora-invent) runs Meteora's flows from a JSONC config, with a
dry-run mode. Epoch does not launch with it: Epoch's CLI adds the program's registration and checks. It is the
reference implementation, and round 3 used it to cross-check the launch, quotes, fees and migration on localnet.
Commands are in [scripts/meteora/studio-crosscheck.md](../../scripts/meteora/studio-crosscheck.md); the results, 27
of 27 agreeing, are in [STUDIO-CROSSCHECK.md](STUDIO-CROSSCHECK.md). It needs Node 22.12+ and pnpm 10. Use a throwaway
key on localnet or devnet only, in `studio/.env`, never committed.

## Meteora's data APIs

| API | Epoch uses | Code |
| --- | --- | --- |
| DAMM v2 (`https://damm-v2.datapi.meteora.ag`, 10 RPS, mainnet only) | For graduated launches: `/pools/{address}` (TVL, 24 h volume and fees, locked liquidity, price), `/pools/{address}/ohlcv`, `/pools/{address}/volume/history`, `/stats/protocol_metrics` | [`packages/meteora/src/dataApi.ts`](../../packages/meteora/src/dataApi.ts) (`DammDataApi`), [`api_app/.../LaunchIndexedSource.ts`](../../packages/api_app/src/Services/Launch/LaunchIndexedSource.ts) (cache: 60 s; protocol 5 min), `market.indexed` and `GET /v1/launches/:mint/indexed` |
| DBC | No REST API exists: the SDK's state service | `pools.ts`, `claims.ts` |

The indexed data is display depth only, labelled with its freshness. Quotes, builds and the page's on-chain fields never
depend on it (it lags, and it does not index devnet). Settings: `LAUNCH_INDEXED_DATA` (`auto` = mainnet only, `on`,
`off`) and `LAUNCH_DAMM_DATA_API_URL`.

## Checked end to end

- Round 3 e2e on the hardened program: [`docs/runbooks/meteora-e2e-2026-10-06.json`](../runbooks/meteora-e2e-2026-10-06.json).
  58 of 58 API checks passed, plus pause, redeem and close.
- Round 2: [`docs/runbooks/meteora-e2e-2026-10-05.json`](../runbooks/meteora-e2e-2026-10-05.json).
- The rehearsals: [`docs/runbooks/meteora-devnet-rehearsal.md`](../runbooks/meteora-devnet-rehearsal.md).
- Mainnet: [`docs/runbooks/meteora-mainnet-launch.md`](../runbooks/meteora-mainnet-launch.md).
