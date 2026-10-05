# Mainnet launch of a revenue token (Meteora DBC)

**Real money.** This launches a token on mainnet that anyone can buy with SOL, priced from a real validator's revenue.
Revenue tokens can count as securities in many countries. Launch only after legal review, at small size, behind a
region-restricted front end, with no public marketing (ADR 0006). Nothing in the app or the API is an offer.

What happens:

1. **Launch.** Epoch's launch CLI creates one Meteora DBC config (Epoch's partner preset) and the token's pool. Its
   fee claimer and leftover receiver are the Epoch program's treasury PDA `["treasury", pool]`, derived from
   `EPOCH_PROGRAM_ID`: no treasury key exists.
2. **Registration.** The validator's operator signs `register_revenue_token(share_bps, term_epochs)`. From then on the
   share and the term are immutable, and the program enforces them. The CLI sends it as its last step when it holds the
   operator's key; otherwise it prints exactly what the operator signs.
3. **The curve.** The token trades on the curve until the raise target is in.
4. **Graduation.** The token moves to a DAMM v2 pool (Meteora's migrator does it). The validator receives 70% of the
   raise; 30% seeds the DAMM v2 pool, whose LP is permanently locked with the treasury PDA.
5. **Buybacks.** Every epoch of the term, the program takes the share off the top of the validator's sweep and buys the
   token back and burns it.
6. **Epoch's fees.** The program's permissionless treasury claims move Epoch's partner fees into the lending pool and
   burn the unsold supply.

The rehearsal of the whole path is in [meteora-devnet-rehearsal.md](meteora-devnet-rehearsal.md); part 2 there ran this
exact flow against the merged program.

## Who signs what

| Party | Key | Signs | Needs SOL |
| --- | --- | --- | --- |
| Epoch launch payer (ops) | `LAUNCH_KEYPAIR_PATH`, a file outside the repo | `createConfig`, `createPool` (and the first buy, if any), `transferPoolCreator` | ≈ 0.035 SOL + the first buy + 0.02 margin: **keep 0.1 SOL** |
| The validator's operator (`ValidatorPosition.operator`) | its own key; `LAUNCH_OPERATOR_KEYPAIR_PATH` only if it lets the CLI sign | `register_revenue_token` (in the launch, or later with `pnpm register`) | 0.00732192 SOL of rent + fees (returned by `close_revenue_token` after the term) |
| Epoch treasury PDA (DBC partner) | none: a program address | nothing; the program signs its claims (`claim_partner_trading_fee`, `claim_partner_surplus`, `claim_partner_migration_fee`, `burn_leftover`, `claim_treasury_lp_fee`), sent by the cranks | — |
| Partner validator (pool creator) | its wallet address goes in the config (`creator`) | nothing at launch (default). It can co-sign as pool creator (`LAUNCH_CREATOR_KEYPAIR_PATH`) | only if it co-signs and makes the first buy |
| Anyone (Meteora's migrator) | — | `migrateToDammV2` at graduation (permissionless) | ≈ 0.023 SOL if we have to do it ourselves |

- **The validator's 70%.** After graduation the validator withdraws it with its own key
  (`creatorWithdrawMigrationFee`). Our claim job can do it only with a key the validator chose to give us
  (`LAUNCH_CREATOR_KEYPAIR_PATHS`).
- **No treasury setting.** The fee claimer and the leftover receiver are fixed in the DBC config forever, and the CLI
  derives both from `EPOCH_PROGRAM_ID`.
  - `EPOCH_TREASURY` is optional. If set, it must equal the PDA, or the CLI refuses to run:
    `register_revenue_token` refuses any other fee claimer.
  - `LAUNCH_LEFTOVER_RECEIVER` (or the config's `leftoverReceiver`) can name another address, with a warning. Then the
    program cannot burn the unsold supply.

## Decisions to make first

1. **Share and term.** The program allows 1–5,000 bps of the validator's gross revenue, for 10–1,000 epochs. Both are
   immutable once registered.
   - During the term, the validator cannot leave Epoch or cut its commission below the commission at registration.
   - Those floors are recorded at registration, so set the commission first.
2. **The revenue basis.** The curve is priced from the validator's 10-epoch average revenue × share × term.
   - The CLI counts inflation commission (exact), block revenue (sampled) and Jito MEV commission.
   - Count block revenue only if it reaches the buyback, i.e. the validator's block revenue collector is set to Epoch's
     escrow (SIMD-0232). Otherwise run with `--block-samples 0`.
   - The rehearsal validator: 6.82 SOL an epoch with blocks, 1.90 without.
3. **The raise target** (2–5 SOL). 30% of it becomes the DAMM v2 pool's liquidity. A 0.75 SOL raise made a 0.22 SOL pool
   where a 0.1 SOL buy moved the price 44%: aim for the top of the range.
   - What the curve cannot sell (the leftover) goes to the treasury PDA at graduation, and the program burns it.
4. **Metadata.** The name (≤ 32), symbol (≤ 10) and URI are **immutable** after launch. Host the JSON (name, symbol,
   description, image) somewhere permanent. On mainnet, the CLI fetches it and fails if it is unreachable or disagrees.

## Checklist

- [ ] Legal review done; front end region-restricted; the risk lines on the page; no marketing.
- [ ] Validator agreement: share (bps), term (epochs), its wallet for `creator`, the revenue basis, and who signs the
      registration (its operator).
- [ ] The Epoch program with revenue tokens is deployed on mainnet, and its Pool is initialized (`initialize_pool`):
      `EPOCH_PROGRAM_ID` copied from the deploy, not typed. The dry run checks both.
- [ ] The validator is onboarded with Epoch:
  - its `ValidatorPosition` is **Active**;
  - the program holds its vote account's withdraw authority;
  - it has no revenue token yet.

  The dry run reads all three.
- [ ] The operator's key is available to sign the registration (or the operator is ready to run `pnpm register`), and
      it holds 0.01 SOL.
- [ ] Metadata JSON hosted; image loads.
- [ ] A paid mainnet RPC for `LAUNCH_RPC_URL` (the public one rate-limits) and one for `DATA_RPC_URL` (revenue reads).
- [ ] Payer funded (0.1 SOL is plenty without a first buy).
- [ ] The registry file backed up; the API and cranks hosts can read the path.
- [ ] Dry run on mainnet reviewed by a second person (below).

## Launch

```bash
cd packages/meteora
export LAUNCH_KEYPAIR_PATH=~/.config/solana/epoch-launch.json      # outside the repo; never printed
export EPOCH_PROGRAM_ID=<the Epoch program on mainnet>             # the treasury PDA is derived from it
export LAUNCHES_PATH=/srv/epoch/launches.json
export LAUNCH_RPC_URL=<paid mainnet RPC>   DATA_RPC_URL=<paid mainnet RPC>
# optional: let the CLI send the registration as its last step
export LAUNCH_OPERATOR_KEYPAIR_PATH=<the operator's keypair file>

# 1. Dry run: nothing is signed or sent
pnpm launch -- --config ./rXXX.json --cluster mainnet
```

Read the whole output:

- **The pricing:** the revenue table (10 epochs: inflation, block revenue, MEV), share revenue, share value, value per
  token, the band (60% → 95%), the sqrt prices, and the raise.
- **The token:** the supply split (curve / DAMM v2 seed / leftover), the 70/30 graduation, fees, market cap and the
  implied yield per epoch.
- **The program:** the `Epoch program` line (program id, Pool, treasury PDA), and the registration the operator signs,
  account by account, with the data.
- **What is sent:** every account (labelled), each transaction's instructions, and the itemized cost, including the
  registration rent the operator pays.
- **The pre-flight:**
  - the cluster (mainnet genesis hash), the Meteora programs, the DAMM v2 migration config, DBC's pool authority;
  - **the Epoch program and Pool**, the treasury PDA as partner and leftover receiver, **the terms against the
    program's limits**, **the validator's position**, the start epoch;
  - registry conflicts, fresh config and mint addresses, the first buy, the metadata URI, the vote account;
  - the payer's balance, and a simulation.

**Every check must PASS.** On mainnet the validator's position is a hard check: Active, with the authority held. A
missing operator key is not a failure: the launch then prints what the operator signs.

```bash
# 2. Launch: asks you to type the symbol
pnpm launch -- --config ./rXXX.json --cluster mainnet --execute
```

What `--execute` does, in order:

1. Sends `createConfig`, then `createPool` (with the first buy if `initialBuySol` is set), then `transferPoolCreator`
   to the validator's wallet. It prints each signature as soon as it is sent, with its explorer link, and waits for
   confirmation.
2. Appends the launch record to `LAUNCHES_PATH`: public keys and signatures only, including the program id and the
   `RevenueToken` and escrow PDAs.
3. Reads everything back. Each of these must PASS:
   - partner = Epoch treasury PDA, leftover receiver, creator, threshold;
   - 70% / 100%, locked LP;
   - fixed supply, no mint or freeze authority, immutable metadata, name and symbol.
4. **Registers.**
   - With `LAUNCH_OPERATOR_KEYPAIR_PATH`, it sends `register_revenue_token` signed by the operator, then updates the
     record with `registeredEpoch` and the signature.
   - Without it, it prints the `pnpm register …` command for the operator.
5. Waits for finalization.

The priority fee is 100,000 µlamports per compute unit by default (`--priority-fee`).

### Registration by the operator

When the launch did not hold the operator's key, the operator runs this with its own key, at any time before it wants
the term to start:

```bash
LAUNCH_OPERATOR_KEYPAIR_PATH=<operator keypair> EPOCH_PROGRAM_ID=<program id> LAUNCHES_PATH=/srv/epoch/launches.json \
pnpm register -- --symbol rXXX --cluster mainnet                   # dry run: what it signs, every check
pnpm register -- --symbol rXXX --cluster mainnet --execute         # asks for the symbol, sends, updates the record
```

- **What it checks:** the cluster, the Epoch program and Pool, the terms, and the position (Active, authority held, no
  token yet, and this operator). Also the mint (SPL Token, supply > 0, no mint or freeze authority), the DBC config
  (SOL-quoted, graduates to DAMM v2, SPL Token, fee claimer = the treasury PDA), the operator's balance, and a
  simulation.
- **Without the operator's key**, the dry run still prints the instruction: the program, all 14 accounts in order with
  their flags, and the data in base64. A multisig or another wallet can build the same transaction from it.
- **Already registered:** running it again brings the record up to date and sends nothing.
- **The term** starts with the epoch after registration (`startEpoch = registration epoch + 1`) and runs for
  `termEpochs` epochs.

## After the launch

1. **API** (`packages/api_app`):
   - Set `LAUNCH_CLUSTER=mainnet`, `LAUNCHES_PATH`, `LAUNCH_RPC_URL`, `DATABASE_URL`, and, for the program reads,
     `EPOCH_PROGRAM_ID`, `EPOCH_CLUSTER=mainnet`, `EPOCH_RPC_URL`. Restart.
   - Check `GET /v1/launches/<symbol>/page`: `market.venue` `dbc`, `unavailable` empty, `ingest.running` true, and
     `revenueToken.source` `program` once registered.
   - Check `GET /v1/launches/<mint>/buybacks`: the term and the escrow.
2. **Buybacks** (`packages/cranks_app`, BuybackJob): they run every epoch of the term from `startEpoch`. See
   [REVENUE_TOKENS_MAINNET.md](../REVENUE_TOKENS_MAINNET.md).
3. **Epoch's fees** (cranks_app `LaunchFeeClaimJob`): the treasury PDA's claims are program instructions any key can
   send (see the cranks_app README).
   - Until the program on mainnet has the treasury claims, the partner fees simply accrue on Meteora under the PDA.
     Nothing is lost.
   - Set `LAUNCH_CLAIM_KINDS` as the cranks_app README says.
4. **Graduation.** When the raise is in, the page shows "graduating"; Meteora's migrator usually migrates within
   minutes. If nothing happens for 30 minutes, migrate it yourself (permissionless, ≈ 0.023 SOL):
   `pnpm rehearse -- migrate --registry $LAUNCHES_PATH --symbol rXXX --rpc $LAUNCH_RPC_URL --payer <keypair> --wait 0`.
5. **The validator's 70%.** Tell the validator to withdraw it (or run the claim job with its key, if it gave one).

## If something goes wrong

Nothing can be deleted on chain. What to do depends on how far it got:

| Situation | Do |
| --- | --- |
| A check fails in the dry run | Fix the input. Nothing was sent. |
| `EPOCH_TREASURY is …, but the fee claimer must be the Epoch program's treasury PDA …` | Unset `EPOCH_TREASURY` (or set it to the PDA printed). |
| `Epoch program` or `Epoch Pool` fails | Wrong `EPOCH_PROGRAM_ID` or cluster, or the Pool is not initialized or is paused. Do not launch: a token whose fee claimer is not the deployed program's treasury can never be registered. |
| `Validator position` fails | Onboard the validator first (Active, the program holding the withdraw authority). A position that already has a token cannot take another. |
| A send "was not confirmed" | Look the printed signature up on the explorer **before running again**: it may have landed. |
| `createConfig` landed, `createPool` did not | Re-run with `--config-account <config>`. The CLI checks it matches the plan and has no pool yet. The config's rent (≈ 0.0082 SOL) stays in it either way. |
| `createPool` landed but the record was not written | The CLI prints the record: add it to `LAUNCHES_PATH` by hand. Do not launch again: a second run would create a second token (the pre-flight refuses a config that already has a pool). |
| `transferPoolCreator` failed | Send it again from the payer (`dbcClient(connection).creator.transferPoolCreator`), before graduation: the creator role decides who can withdraw the 70%. |
| The registration failed or was not sent | The token trades, but no buyback runs until it is registered. Fix what the error says (the position, the operator's balance) and run `pnpm register -- --symbol rXXX --cluster mainnet`. |
| Wrong name, symbol, URI, supply, terms or price | Cannot be changed, nor can a registered share or term. Stop: remove the entry from `LAUNCHES_PATH` (the page disappears; the pool still trades on Meteora), say so publicly, and launch a corrected token if needed. An unregistered token can simply stay unregistered. |
| Graduation does not happen | Migrate permissionlessly (above). DBC's pool authority fronts the new pool's rent; it holds plenty on mainnet. |
| The API shows `stale` | RPC trouble: the page says "as of …". Check `LAUNCH_RPC_URL` and the ingester logs (`launch RPC rate-limited; backing off`). |

## Costs (from the rehearsals)

| Item | SOL | Paid by |
| --- | --- | --- |
| `createConfig` (config rent + fee) | 0.00819496 | payer |
| `createPool` (mint, pool, vaults, metadata incl. Metaplex's 0.01 fee) | ≈ 0.0245 | payer |
| `transferPoolCreator` | 0.000005 | payer |
| First buy | the amount + 0.00203928 (the buyer's token account) | payer |
| Priority fees on mainnet | ≈ 0.0001 at 100,000 µlamports × ≈ 400,000 CU | payer |
| `register_revenue_token`: rent for the `RevenueToken` (503 bytes), the escrow and its token account, plus the fee | 0.00732192 + 0.000005; the rent is returned by `close_revenue_token` after the term | operator |
| Migration, if we do it | 0.02262108 | anyone |
