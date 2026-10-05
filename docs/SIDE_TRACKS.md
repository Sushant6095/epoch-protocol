# Side tracks

| Track | What we integrate | Code |
| --- | --- | --- |
| Solami | The Fee Index computed live from mainnet: Solami Yellowstone gRPC firehose (or block meta + Solami RPC on a plan stream), RPC gap fill, leader schedule and stake snapshots; Live page via `/v1/live` and WS `slots` / `index:live`; Beam for mainnet `post_index` | packages/indexer_app, packages/api_app, packages/solana, app (page contract: docs/pages/live.md) |
| RPC Fast | Crank transactions land via RPC Fast; failover data stream | packages/cranks_app, packages/indexer_app |
| Panta | Real-money USDC markets on Solana mainnet: each epoch the bot creates "Will the Solana Fee Index for epoch N close above X µL/CU?" (trading closes before N starts); users trade them and Panta's catalog from the Predict page, every trade attributed to Epoch. Resolution: Epoch's `GET /v1/index/epochs/{N}`, value counts once `status` is `final` (posted on chain, dispute window passed), per [the methodology](FEE_INDEX_METHODOLOGY.md); missing → NO, vetoed → the corrected final value | packages/panta, packages/panta_bot_app, packages/api_app (`/v1/predict/panta`), [docs/pages/predict.md](pages/predict.md) |
| Meteora | Validators sell a fixed share of their commission as a revenue token launched on a Meteora DBC curve (Epoch is the DBC partner); every epoch the program buys the token back (on the curve via DBC `swap2`, after graduation on its DAMM v2 pool) out of the validator's revenue and burns it. The program also claims Epoch's partner fees (DBC trading fees, surplus, migration fee, its DAMM v2 LP fees) into the lending pool as income and burns the token side and the unsold supply | programs/epoch `instructions/revenue/`, `instructions/treasury/`, packages/epoch-sdk, packages/meteora, packages/cranks_app (BuybackJob, LaunchFeeClaimJob), app |
| Superteam India | The India page: live SOL in ₹, validators hosted in India (share, cities, comparison, estimated Epoch advance) and a wallet's staking rewards in ₹ per Indian financial year with a CSV; 5,000 USDG, India-based teams only ([page contract](pages/india.md)) | packages/api_app `/v1/india`, app |

Open question: confirm in Panta's Discord (#dev-chat) that markets can resolve from our endpoint (listed in each market's `sourcesOfTruth`).

## Meteora: Best use of Dynamic Bonding Curve (DBC)

| | |
| --- | --- |
| Prize | 20,000 USDC: 10,000 / 5,000 / 3,000 / 1,500 / 500 |
| Eligibility | Global |
| Winners announced | By 31 Oct 2026 |
| Judged on | Depth of Meteora integration, technical execution, originality and taste, impact potential (a new class of assets), traction and volume on mainnet |
| Our entry | Validator revenue tokens: launch on DBC, buyback at source on DAMM v2 ([ADR 0006](adr/0006-revenue-tokens-on-meteora.md), plan feature F13) |
| Launch side | Launch CLI (devnet and mainnet, dry run by default; the program's treasury PDA as fee claimer and leftover receiver; `register_revenue_token` signed by the validator's operator, in the launch or with `pnpm register`) in packages/meteora/scripts; Launch page API and trade feed in packages/api_app; fee claims in packages/cranks_app. Runbooks: [mainnet launch](runbooks/meteora-mainnet-launch.md), [rehearsal](runbooks/meteora-devnet-rehearsal.md). Page contract: [pages/launch.md](pages/launch.md) |
| Resources | DBC guide docs.meteora.ag/developer-guides/dbc · DAMM v2 guide docs.meteora.ag/developer-guides/damm-v2 · DBC SDK github.com/MeteoraAg/dynamic-bonding-curve-sdk · DAMM v2 SDK github.com/MeteoraAg/damm-v2-sdk · Dev support t.me/meteora_dev |

All side tracks close 13 Oct 2026, 12:29 IST (06:59 UTC), the same moment as the main Colosseum deadline.

The four special pages (Live, Predict, Launch, India), with their routes, WS channels and contracts:
[docs/pages/README.md](pages/README.md).

What is left to go live with real money (keys, funds, deploy order, decisions, submission checklist):
[GO_LIVE_SIDE_TRACKS.md](GO_LIVE_SIDE_TRACKS.md).
