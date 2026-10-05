# Launch a revenue token with Epoch

A validator sells a fixed share of its commission for a fixed term as a token on a Meteora Dynamic Bonding Curve, with
Epoch as the curve's partner (ADR 0006, plan F13). There is no launch flow in the app (decision 22): a launch is set up
with Epoch through this script, on devnet or mainnet. Nothing here is an offer: revenue tokens can be securities in many
countries, and a public launch needs legal review and a region-restricted front end first. Mainnet:
[docs/runbooks/meteora-mainnet-launch.md](../../../docs/runbooks/meteora-mainnet-launch.md). A full rehearsal:
[docs/runbooks/meteora-devnet-rehearsal.md](../../../docs/runbooks/meteora-devnet-rehearsal.md).

```bash
# Dry run (the default): every account, parameter, cost and pre-flight check; nothing is signed or sent
pnpm --filter @epoch/meteora launch -- --config scripts/launch-config.example.json

# Launch on devnet (asks you to type the symbol). The treasury PDA comes from EPOCH_PROGRAM_ID; with the operator's
# key the launch also registers the token with the program, else it prints what the operator signs.
LAUNCH_KEYPAIR_PATH=~/.config/solana/epoch-launch.json \
EPOCH_PROGRAM_ID=<the Epoch program> \
LAUNCHES_PATH=/srv/epoch/launches.json \
[LAUNCH_OPERATOR_KEYPAIR_PATH=<the validator's operator keypair>] \
pnpm --filter @epoch/meteora launch -- --config my-launch.json --execute

# The operator registers a launched token itself (dry run first, then --execute)
LAUNCH_OPERATOR_KEYPAIR_PATH=<operator keypair> EPOCH_PROGRAM_ID=<the Epoch program> LAUNCHES_PATH=/srv/epoch/launches.json \
pnpm --filter @epoch/meteora register -- --symbol rXXX

# Mainnet: the same with --cluster mainnet and a paid RPC (LAUNCH_RPC_URL, DATA_RPC_URL)
```

## What it does

1. Reads and checks the launch config (below).
2. Prices the share from the validator's revenue (`--revenue`): the config's `avgRevenueSol`, or 10 epochs read from
   mainnet — inflation commission (`getInflationReward`, exact), block revenue (the leader's slots from
   `getLeaderSchedule`, `--block-samples` blocks read per epoch with `getBlock`, scaled to all its slots), and Jito MEV
   commission (Kobe) — or Epoch's API (`GET /v1/validators/:vote`). It prints the table and the math: share revenue per
   epoch, share value, value per token, the band, the raise, the supply split, the 70/30 graduation, market cap and
   implied yield per epoch.
3. Builds the curve: from 60% to 95% of the share's value per token, as sqrt prices for the DBC SDK's
   `buildCurveWithCustomSqrtPrices`, in Epoch's partner preset: SPL token, fixed supply, no mint authority, immutable
   metadata (`TokenAuthorityOption.Immutable`); a 1% curve fee, all to the partner; at the raise target
   (`migrationQuoteThreshold`) the token graduates to DAMM v2, the pool creator gets 70% of the raise
   (`migrationFeePercentage` 70, creator share 100%) and the other 30% seeds the pool with 100% of its LP permanently
   locked with the partner. The partner (`feeClaimer`) is the Epoch program's treasury PDA `["treasury", pool]`,
   derived from `EPOCH_PROGRAM_ID` (`register_revenue_token` refuses any other fee claimer). The leftover receiver is
   the config's `leftoverReceiver`, else `LAUNCH_LEFTOVER_RECEIVER`, else the treasury PDA, which burns it.
4. Pre-flight. A dry run stops here. It checks:
   - **the cluster and Meteora:** the genesis hash; the DBC, DAMM v2 and Metaplex programs; the DAMM v2 migration
     config; DBC's pool authority (it fronts the DAMM v2 rent at graduation);
   - **the Epoch program:**
     - the program is deployed on this cluster, and its Pool exists and is not paused;
     - the treasury PDA is the partner, and the leftover receiver (a warning if it is not the PDA);
     - the terms are within `register_revenue_token`'s limits (1–5,000 bps, 10–1,000 epochs);
     - the validator's position is onboarded and Active, the program holds its withdraw authority, it has no revenue
       token yet, and the operator key matches. These are warnings on devnet and failures on mainnet;
     - the start epoch is the one registration gives;
   - **the launch itself:**
     - the registry: symbol and validator not already live;
     - fresh config and mint addresses (or `--config-account`: it must match the plan and have no pool yet);
     - the first buy;
     - the metadata JSON: reachable, name and symbol match (required on mainnet);
     - the vote account (mainnet);
     - the payer's balance against the itemized cost;
     - a simulation of each transaction.

   The output also lists what the registration signs: every account and the instruction data.
5. With `--execute` and every check passing: asks for the symbol (`--yes` skips it), sends `createConfig` and
   `createPool` (with the first buy when `initialBuySol` is set; one combined transaction when it fits), then
   `transferPoolCreator` to the validator's wallet (`creator`) unless the validator co-signs as pool creator
   (`LAUNCH_CREATOR_KEYPAIR_PATH`). Each signature is printed as it is sent, with its explorer link.
6. Appends the launch record to the registry (`LAUNCHES_PATH`, `GET /v1/launches`). It holds public keys and
   signatures only: `mint`, `dbcPool`, `dbcConfig`, `creator`, `feeClaimer`, `leftoverReceiver`, the program's
   `programId`, `revenueToken` and `escrow`, `signatures`, the terms, and the revenue it was priced from. If writing
   fails, the record is printed to add by hand.
7. Reads the launch back and checks it: partner = the treasury PDA, leftover receiver, creator, threshold, 70% / 100%,
   locked LP, fixed supply, no mint or freeze authority, immutable metadata, name and symbol.
8. **Registers the token.** With `LAUNCH_OPERATOR_KEYPAIR_PATH`, and the position ready, it sends
   `register_revenue_token(shareBps, termEpochs)`, signed and paid by the operator (0.00732192 SOL of rent). It then
   writes `registeredEpoch`, the program's `startEpoch` and `signatures.registerRevenueToken` into the record. Without
   the key, it prints the `register` command for the operator. Then it waits for finalization.

Keys come from paths only and are never printed or written; the new config and mint accounts get fresh signers in
memory, and only their public keys are shown.

## Options and environment

| Flag                           | Default                                                              |                                                               |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `--config <file>`              | —                                                                    | The launch config (JSON).                                     |
| `--cluster devnet\|mainnet`    | `devnet`                                                             | The launch cluster; written to the launch record.             |
| `--execute`                    | off (dry run)                                                        | Send the transactions.                                        |
| `--yes`                        | off                                                                  | Skip the "type the symbol" confirmation.                      |
| `--rpc <url>`                  | `LAUNCH_RPC_URL`, else the public RPC of `--cluster`                 | The launch cluster's RPC.                                     |
| `--revenue auto\|config\|rpc\|api` | `auto` (the config's `avgRevenueSol`, else `rpc`)                | Where the revenue comes from.                                 |
| `--revenue-rpc <url>`          | `DATA_RPC_URL`, else the public mainnet RPC                          | Mainnet, for the revenue read (rate limits are retried).      |
| `--api <url>`                  | `EPOCH_API_URL`                                                      | For `--revenue api`.                                          |
| `--block-samples <n>`          | 6                                                                    | Blocks read per epoch; 0 leaves block revenue out.            |
| `--no-mev`                     | off                                                                  | Leave Jito MEV commission out.                                |
| `--registry <path>`            | `LAUNCHES_PATH`                                                      | The registry to append to (required to send).                 |
| `--config-account <pubkey>`    | —                                                                    | Reuse an existing DBC config (a launch that stopped halfway). |
| `--priority-fee <µlamports>`   | 100,000 on mainnet, 0 on devnet                                      | Compute-unit price.                                           |
| `--allow-unknown-genesis`      | off                                                                  | Accept an RPC that is not the public cluster (a local stand-in). |
| `--skip-uri-check`             | off                                                                  | Do not fetch the metadata URI (a failure on mainnet).         |
| `--program-id <pubkey>`        | `EPOCH_PROGRAM_ID`                                                   | The Epoch program: its treasury PDA becomes the fee claimer.  |

| Variable                      |                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `LAUNCH_KEYPAIR_PATH`         | The payer's keypair file, outside the repo: pays, and is the first pool creator. Read only to send.   |
| `EPOCH_PROGRAM_ID`            | The Epoch program (required to send). Its treasury PDA `["treasury", pool]` is the DBC partner and fee claimer, fixed in the config forever. |
| `EPOCH_TREASURY`              | Optional. If set, it must equal the treasury PDA, or the CLI refuses to run.                          |
| `LAUNCH_OPERATOR_KEYPAIR_PATH` | Optional: the validator's operator keypair file. With it, the launch ends with `register_revenue_token`. |
| `LAUNCH_LEFTOVER_RECEIVER`    | Who may withdraw the unsold supply after graduation, when the config has no `leftoverReceiver` (default: the treasury PDA, which burns it). |
| `LAUNCH_CREATOR_KEYPAIR_PATH` | Optional: the validator's keypair file, to co-sign as pool creator instead of the hand-over.          |
| `LAUNCHES_PATH`               | The registry file (`packages/api_app/launches.example.json` shows the format).                        |
| `LAUNCH_RPC_URL`, `DATA_RPC_URL`, `EPOCH_API_URL` | As the flags above.                                                               |

## Launch config

`scripts/launch-config.example.json` (fictional validator):

| Field                   | Required                        |                                                                                 |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `validator.name`        | yes                             | Up to 64 characters.                                                            |
| `validator.vote`        | when `avgRevenueSol` is missing | The validator's mainnet vote account, or null.                                  |
| `symbol`, `name`, `uri` | yes                             | Token metadata: up to 10, 32 and 200 characters. Immutable after the launch.    |
| `shareBps`              | yes                             | Share of gross revenue sold. The program registers 1–5,000 bps. Immutable once registered. |
| `termEpochs`            | yes                             | Epochs of revenue bought back. The program registers 10–1,000. Immutable once registered. |
| `avgRevenueSol`         | no                              | 10-epoch average revenue per epoch, SOL.                                        |
| `supply`, `decimals`    | yes                             | Fixed supply in whole tokens; decimals 6–9.                                     |
| `raiseTargetSol`        | no                              | The raise that graduates the token (2–5 SOL for the demo).                      |
| `tradingFeeBps`         | no                              | Curve fee, 25–9,900 bps (default 100).                                          |
| `dammFeeBps`            | no                              | DAMM v2 pool fee after graduation: 25, 30, 100, 200, 400 or 600 (default 100).  |
| `curvePoints`           | no                              | Sqrt-price points of the curve, 2–17 (default 2: one constant-product segment). |
| `startEpoch`            | no                              | First epoch of the term (default: the epoch after registration, as the program sets it). |
| `creator`               | no                              | The validator's wallet: the pool creator role (and the 70%) goes to it.         |
| `initialBuySol`         | no                              | SOL the pool creator buys in the pool's creation transaction.                   |
| `leftoverReceiver`      | no                              | Who may withdraw the unsold supply (default: the treasury PDA, which burns it). |

**Raise target and leftover.** A curve over the band raises about 61% of the share's value whatever the supply
(rKEST: 63.4 SOL of a 104 SOL share). With a smaller `raiseTargetSol` the unused supply becomes DBC leftover, which the
leftover receiver can withdraw after graduation (rKEST at 5 SOL: 92,113 of 100,000 tokens; the rehearsal at 0.75 SOL:
639,263 of 1,000,000). Pick a smaller share or term instead to sell the whole supply on the curve. The leftover goes to
the treasury PDA, and the program burns it (`burn_leftover`).

## Register a launched token: `register`

`pnpm --filter @epoch/meteora register -- --symbol <SYM> [--registry] [--cluster] [--rpc] [--program-id] [--execute]
[--yes] [--priority-fee] [--allow-unknown-genesis]`, with `LAUNCH_OPERATOR_KEYPAIR_PATH`, `EPOCH_PROGRAM_ID` and
`LAUNCHES_PATH`. This is the validator's operator registering the token with its own key, when the launch did not hold
it.

- **Checks:** the cluster, the program and its Pool, the terms, and the position (onboarded, Active, the authority
  held, no token yet, this operator). Then the mint (SPL Token, fixed supply, no authorities), the DBC config
  (SOL-quoted, graduates to DAMM v2, SPL Token, fee claimer = the treasury PDA), the operator's balance, and a
  simulation.
- **The dry run** prints what the operator signs: the program, all 14 accounts in order with their flags, and the data
  in base64. Without a key it is the operator's checklist; a multisig can build the same transaction.
- **`--execute`** asks for the symbol, sends, prints the term and the commission floor, and updates the launch record.
- **A token that is already registered** brings the record up to date and sends nothing.

## After the launch: `rehearse`

`pnpm --filter @epoch/meteora rehearse -- <command> --registry <launches.json> --symbol <SYM> --rpc <url>`:

| Command                                                         | What it does                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `status`                                                        | The curve, the DAMM v2 pool, every claim and the LP positions.                                    |
| `trade --wallet <keypair> --side buy\|sell --amount <n> [--api <url>] [--slippage-bps 100]` | A trade from a test wallet: through the API's `/quote` + `/build` (as the Launch page does), or built locally. |
| `migrate --payer <keypair> [--wait <s>]`                       | Waits for Meteora's migrator, then sends the permissionless `migrateToDammV2` itself.             |
| `record --out <dir> --signatures a,b,c`                         | Saves raw `getTransaction` answers and the decoded launch accounts (test fixtures).               |

- The token trades on the curve at once; the Launch page reads it from the API (`docs/pages/launch.md`).
- When the raise is complete, the pool graduates through DBC `migrateToDammV2` (Meteora's migrator, or anyone). The API
  finds the DAMM v2 pool from the curve; add `dammPool` to the registry entry to pin it.
- **Buybacks:** once registered, every sweep from `startEpoch` moves the share into the escrow. `execute_buyback` then
  spends it in 12 slices in the first hour of each epoch and burns what it buys (cranks_app `BuybackJob`).
- **Fees:** the partner's fees accrue under the treasury PDA. The program's treasury claims move the SOL into the
  lending pool and burn the token side and the leftover. cranks_app's `LaunchFeeClaimJob` sends them, and also claims
  the validator's 70% when its key is configured.
