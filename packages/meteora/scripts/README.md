# Launch a revenue token with Epoch

A validator sells a fixed share of its commission for a fixed term as a token on a Meteora Dynamic Bonding Curve, with
Epoch as the curve's partner (ADR 0006, plan F13). There is no launch flow in the app (decision 22): a launch is set up
with Epoch through this script. It runs on **devnet**. Nothing here is an offer: revenue tokens can be securities in many
countries, and a public launch needs legal review and a region-restricted front end first.

```bash
# See every account and parameter; nothing is signed or sent
pnpm --filter @epoch/meteora launch -- --config scripts/launch-config.example.json --dry-run

# Launch on devnet
LAUNCH_KEYPAIR_PATH=~/.config/solana/epoch-launch.json \
EPOCH_TREASURY=<Epoch's treasury address> \
LAUNCHES_PATH=/srv/epoch/launches.json \
pnpm --filter @epoch/meteora launch -- --config my-launch.json
```

## What it does

1. Reads and checks the launch config (below).
2. Prices the share from the validator's 10-epoch average revenue: `avgRevenueSol` from the config, or the average of
   the vote account's mainnet `getInflationReward` over the last 10 epochs (inflation commission only; give
   `avgRevenueSol` to include MEV and block fees).
3. Builds the curve: from 60% to 95% of the share's value per token (average × share × term ÷ supply), as sqrt prices
   for the DBC SDK's `buildCurveWithCustomSqrtPrices`, in Epoch's partner preset: fixed supply, no mint authority and
   immutable metadata; a 1% curve fee, all to the partner; at the raise target the token graduates to a DAMM v2 pool,
   the validator gets 70% of the raise and the other 30% seeds the pool with its liquidity locked forever.
4. Creates the DBC config and pool in one transaction (`createConfigAndPool`; split into `createConfig` then
   `createPool` if it ever exceeds 1,232 bytes). The partner (fee claimer) and the leftover receiver are Epoch's
   treasury (`EPOCH_TREASURY`); the payer is the pool creator.
5. Appends the launch to the registry the API reads (`LAUNCHES_PATH`, `GET /v1/launches`).
6. With `creator` in the config, hands the pool's creator role to the validator's wallet (`transferPoolCreator`), so
   the validator can withdraw its 70% at graduation.

`--dry-run` prints the plan, every account (labelled), the DBC config parameters, the transaction's instructions with
their accounts, and the registry entry, then stops. It needs no keypair: the payer, the new config and mint accounts and
(without `EPOCH_TREASURY`) the partner are placeholders. It reads the launch cluster's epoch (when `startEpoch` is not
given) and, without `avgRevenueSol`, ten mainnet `getInflationReward` results.

**Still to do in the program:** `register_revenue_token` is not in the Epoch program yet, so the registry file stands in
for the on-chain registration; `execute_buyback` (12 slices in the first hour of each epoch) and the `redeem` fallback
follow (plan F13).

## Options and environment

| Flag                        | Default                                                            |                                               |
| --------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `--config <file>`           | —                                                                  | The launch config (JSON).                     |
| `--dry-run`                 | off                                                                | Print everything, send nothing.               |
| `--registry <path>`         | `LAUNCHES_PATH`                                                    | The registry to append to (required to send). |
| `--rpc <url>`               | `LAUNCH_RPC_URL`, else `EPOCH_RPC_URL`, else the public devnet RPC | The launch cluster.                           |
| `--revenue-rpc <url>`       | `DATA_RPC_URL`, else the public mainnet RPC                        | Mainnet, for the revenue average.             |
| `--cluster devnet\|mainnet` | `devnet`                                                           | Written to the registry entry.                |

| Variable              |                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `LAUNCH_KEYPAIR_PATH` | Path to the payer's Solana CLI keypair file, kept outside the repo. Read only when sending; never printed or written. |
| `EPOCH_TREASURY`      | Epoch's treasury address (a public key): the DBC partner and fee claimer, and the leftover receiver.                  |
| `LAUNCHES_PATH`       | The registry file (`packages/api_app/launches.example.json` shows the format).                                        |

The two new accounts, the DBC config and the token mint, get fresh signers in memory when the script sends; only their
public keys are printed.

## Launch config

`scripts/launch-config.example.json` (fictional validator):

| Field                   | Required                        |                                                                                 |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `validator.name`        | yes                             | Up to 64 characters.                                                            |
| `validator.vote`        | when `avgRevenueSol` is missing | The validator's mainnet vote account, or null.                                  |
| `symbol`, `name`, `uri` | yes                             | Token metadata: up to 10, 32 and 200 characters.                                |
| `shareBps`              | yes                             | Share of the commission sold, 1–10,000 bps. Immutable once registered.          |
| `termEpochs`            | yes                             | Epochs of revenue bought back. Immutable once registered.                       |
| `avgRevenueSol`         | no                              | 10-epoch average revenue per epoch, SOL.                                        |
| `supply`, `decimals`    | yes                             | Fixed supply in whole tokens; decimals 6–9.                                     |
| `raiseTargetSol`        | no                              | The raise that graduates the token (2–5 SOL for the demo).                      |
| `tradingFeeBps`         | no                              | Curve fee, 25–9,900 bps (default 100).                                          |
| `dammFeeBps`            | no                              | DAMM v2 pool fee after graduation: 25, 30, 100, 200, 400 or 600 (default 100).  |
| `curvePoints`           | no                              | Sqrt-price points of the curve, 2–17 (default 2: one constant-product segment). |
| `startEpoch`            | no                              | First epoch of the term, on the launch cluster (default: the next epoch).       |
| `creator`               | no                              | The validator's wallet, to receive the pool's creator role.                     |

**Raise target and leftover.** A curve over the band raises about 61% of the share's value whatever the supply
(rKEST: 63.4 SOL of a 104 SOL share). With a smaller `raiseTargetSol` the unused supply becomes DBC leftover, which the
treasury can withdraw after graduation (rKEST at 5 SOL: 92,113 of 100,000 tokens). Pick a smaller share or term instead
to sell the whole supply on the curve. What the treasury does with leftover tokens is still to be decided.

## After the launch

- The token trades on the curve at once; the Launch page reads it from the API and trades it through `@epoch/meteora`.
- When the raise is complete, the pool graduates through DBC `migrateToDammV2` (Meteora's migrator service, or anyone:
  the call is permissionless, and Meteora's manual migrator works on devnet). The API finds the DAMM v2 pool from the
  curve; add `dammPool` to the registry entry to pin it.
- Partner trading fees accrue to the treasury (`claimPartnerTradingFee`), for the Senior tranche.
