# Side tracks

| Track | What we integrate | Code |
| --- | --- | --- |
| Solami | Indexer + Terminal stream live mainnet data via Solami Yellowstone gRPC | packages/indexer_app, app |
| RPC Fast | Crank transactions land via RPC Fast; failover data stream | packages/cranks_app, packages/indexer_app |
| Panta | Parimutuel market per epoch on the fee index | packages/panta_bot_app |
| Meteora | Validators sell a fixed share of their commission as a revenue token launched on a Meteora DBC curve (Epoch is the DBC partner); every epoch the program buys the token back on its DAMM v2 pool out of the validator's revenue and burns it | programs/epoch `instructions/launch/`, packages/meteora, packages/cranks_app, app |

Open question: can a Panta market resolve from our index? Ask in Panta's Discord.

## Meteora: Best use of Dynamic Bonding Curve (DBC)

| | |
| --- | --- |
| Prize | 20,000 USDC: 10,000 / 5,000 / 3,000 / 1,500 / 500 |
| Eligibility | Global |
| Winners announced | By 31 Oct 2026 |
| Judged on | Depth of Meteora integration, technical execution, originality and taste, impact potential (a new class of assets), traction and volume on mainnet |
| Our entry | Validator revenue tokens: launch on DBC, buyback at source on DAMM v2 ([ADR 0006](adr/0006-revenue-tokens-on-meteora.md), plan feature F13) |
| Resources | DBC guide docs.meteora.ag/developer-guides/dbc · DAMM v2 guide docs.meteora.ag/developer-guides/damm-v2 · DBC SDK github.com/MeteoraAg/dynamic-bonding-curve-sdk · DAMM v2 SDK github.com/MeteoraAg/damm-v2-sdk · Dev support t.me/meteora_dev |

All side tracks close 13 Oct 2026, 12:29 IST (06:59 UTC), the same moment as the main Colosseum deadline.
