# Devnet go-live

How to put Epoch on devnet with the kit in `scripts/devnet/` (`pnpm devnet <command>`), what it costs, what to check
after each step, and how to hand the upgrade authority to the owner's wallet. Times are IST. Every command was
rehearsed on a fresh local validator shaped like devnet (`scripts/devnet/localnet.sh`, with Meteora's devnet builds
loaded) on 7 Oct 2026, 13:53–15:10 IST; the numbers below come from those runs and from `pnpm devnet budget --url
devnet` (7 Oct, 15:13 IST).

## 1. SOL to send

Rent on devnet is **5,080 lamports per byte** (SIMD-0437); `budget` reads it from the cluster, so the figures follow
devnet if it changes. Program build: 1,261,400 bytes (main on 7 Oct: validator history, operator consensus, `get_sfi`),
deployed with `--max-len 1,600,000`, which leaves about 338 KB for upgrades without `solana program extend`. Each
100,000 bytes of max-len costs 0.508 SOL of rent.

| Stage             | SOL                                          | Notes                                                                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy            | 8.136695124 spent                            | program data 8.128878840 (45 + 1,600,000 bytes), program account 0.000833120, ≈ 1,262 buffer writes 0.006332924, the deployer's own rent-exempt minimum 0.000650240                                                                                                                            |
| deploy, peak only | + 6.408750200                                | the buffer's rent (37 + 1,261,400 bytes), refunded by the deploy itself                                                                                                                                                                                                                        |
| init              | 0.269703280                                  | pool, vault and Fee Index rent 0.006319520; fee floats for admin, scorer, publisher (0.02 each) and cranker (0.05); the treasury's rent-exempt minimum; the operator registry 0.002712720 and the fee floats of its 3 operators (0.05 each)                                                    |
| seed              | 0.690374920 spent + 10.350000000 recoverable | deposits 6.0, bonds 0.75, revenue float 2.3, collateral of 6 quotes 1.2 and of the swap 0.1 (recoverable); rent of 3 vote accounts with their 0.1 SOL reserve, positions, escrows, 6 quotes, the swap, the advance; fee floats for 7 wallets; the revenue token 0.072569960 and its share 0.09 |
| cp1               | 0.143820120 spent + 0.010000000 recoverable  | throwaway vote account (rent + 0.1 reserve), position, escrow, the identity's rent-exempt minimum, fee float; its 0.01 revenue comes back                                                                                                                                                      |
| keepers           | < 0.01 per epoch                             | ≈ 10 transactions per epoch with priority fees; the operators' first vote of an epoch pays the ballot's rent (≈ 0.0054 SOL, refunded when it is closed)                                                                                                                                        |

**Send about 19.8 SOL to the deployer**: `budget` puts deploy + init + seed + cp1 at a peak of **19.600593444 SOL**
(9.240593444 spent, 10.36 recoverable; `pnpm devnet budget --url devnet`, 7 Oct 21:50 IST), and ≈ 0.2 covers the
keepers' first epochs. **Deploy and init alone need 14.815148604 SOL** at the deploy's peak (8.406398404 of it stays
spent once the buffer is refunded).

On the rehearsal validator (6,960 lamports per byte) the deployer's spend matched `budget` line by line: deploy
11.143100520 SOL at max-len 1,600,000 (budget 11.143155520; 11 fewer buffer writes than planned), init 0.119554120 (the
admin's two fees come out of its float); the seed and cp1 figures are in section 9.

## 2. Before you start

- Agave CLI 4.3 on the `PATH` (`solana`, `cargo-build-sbf`), Node 22, `pnpm install --frozen-lockfile`.
- A key folder **outside the repo** (`--keys`), mode 0700. It holds the deployer (`devnet-deployer.json`), the program
  keypair (`devnet-program.json`), and the role, seed and test-validator keys the commands create (0600). The kit
  refuses any key path inside the repo and refuses mainnet by name and by genesis hash.
- Resumable state lives in `<keys>/state/`, one file per command keyed to devnet's genesis hash
  (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`) and the program id. Re-running any command is safe: each step checks
  its effect on chain before sending.

```bash
KEYS=/abs/path/to/keys           # outside the repo
DEPLOYER=$KEYS/devnet-deployer.json
pnpm devnet budget --url devnet  # exact SOL per stage, sends nothing
solana balance "$(solana-keygen pubkey "$DEPLOYER")" -ud
```

## 3. Deploy

```bash
pnpm devnet deploy --url devnet --keys "$KEYS" --deployer "$DEPLOYER" \
  --program-keypair "$KEYS/devnet-program.json" [--build-lock /path/to/sbf.lock]
```

It points every copy of the program id at the keypair's address (`scripts/set-program-id.sh`: `declare_id!`,
`Anchor.toml`, the IDL, `.env.example`, the SDK's Rust vectors), builds the SBF program, checks the build embeds that
id, prints the exact cost and the deployer's balance (and stops if short), writes a buffer whose keypair stays in the
key folder (a failed write resumes) and deploys from it with `--max-len 1600000`. It then reads the program data back
and checks the bytes and the upgrade authority. The same bytes on chain → nothing to do; different bytes → an upgrade.

Check: `solana program show <program id> -ud` shows `Authority` = the deployer and
`Data Length: 1600000`. The id edits from `set-program-id.sh` are the devnet id: commit them only when the team decides
devnet's id becomes the repo's id.

## 4. Init

```bash
pnpm devnet init --url devnet --keys "$KEYS" --deployer "$DEPLOYER"
```

`initialize_pool` with `scripts/devnet/config/params.devnet.json` (senior 3 bps per epoch, request #17; junior lock 10;
vote reserve 0.1 SOL because the test vote accounts never vote), `initialize_index` (publisher, dispute window 1,500
slots ≈ 6 min, max move 2,000 bps), and the role wallets' fee floats. Then operator consensus: the registry with three
operator keys (`<keys>/index-operator-{1,2,3}.json`, weight 1 each, threshold 6,667 bps, tolerance 100 bps;
`initialize_index_operators` + three `add_index_operator` in one transaction), after which the Fee Index's publisher
is the registry PDA and values come from ballots. `--index-operators 0` keeps the single publisher. An existing pool or
index is compared field by field; differences are fixed only with `--apply-changes`; an existing registry is checked
against the key folder and never changed. A second run sends nothing.

Before onboarding a real staked validator, raise the vote reserve to 1.6 SOL with `update_params`.

## 5. Seed (only after the go-ahead)

```bash
pnpm devnet seed --url devnet --keys "$KEYS" --deployer "$DEPLOYER"
```

In the onboarding epoch (E0): four deposits (junior 1.5 SOL, senior 4.5 SOL), lender3's senior withdrawal request,
three test vote accounts (`solana create-vote-account … --commission`, the legacy `InitializeAccount`: devnet has no
VoteInitV2 yet), onboarding (`onboard_validator` → `set_collectors` → `post_bond` in one transaction), and the revenue
token `rDEV3`: v3's operator launches it on Meteora's devnet DBC through `@epoch/meteora`'s launch CLI (10% of v3's
revenue for 10 epochs, 1,000,000 tokens, a 0.1 SOL raise, a 0.02 SOL first buy, the Epoch treasury PDA as fee claimer
and leftover receiver) and registers it (`register_revenue_token`). DBC, DAMM v2, Metaplex, the seven DAMM v2 migration
configs and a funded DBC pool authority are all on devnet (checked 7 Oct). The launch record and config sit next to
the seed state (`<keys>/state/launches-EtWTRABZ.json`); a launch that landed without its registration is registered
from it on the next run.

Then, every epoch: sweeps (with the revenue token's share to its buyback escrow), accrual, scores, the next epoch's
simulated revenue, the market (the maker takes back quotes whose epoch has begun with no open swap and posts the
missing quotes of the next five epochs, 1 SOL notional at a fixed rate of 10,000 with a 20% max move; lender1's 0.5 SOL
pay-fixed swap on the next epoch, once), and v1's 1 SOL advance once it has three swept epochs. Without `--wait` it
stops after the current epoch's steps and prints when to run it again; run it once per epoch to keep five quotes
ahead. Devnet epochs last ≈ 28.6 h (boundaries ≈ 7 Oct 18:35, 8 Oct 23:13, 10 Oct 03:51, 11 Oct 08:29 IST), so the
advance lands three boundaries after onboarding. cranks_app sweeps too; whoever comes first, the other finds nothing
to do.

Check: each vote account's `Withdraw Authority` is its vote_auth PDA and both collectors are its escrow
(`solana vote-account <vote> -ud`); the launch CLI's read-back says PASS for the partner, leftover receiver, fixed
supply and immutable metadata; the state file lists every signature, wallet and PDA (`revenue-token`, `quote:<epoch>`,
`swap`).

## 6. CP1 proof

```bash
pnpm devnet cp1 --url devnet --keys "$KEYS" --deployer "$DEPLOYER"   # steps 0–3 now; again after the next boundary
```

Writes `docs/cp1-results.md` with every signature and explorer link: the control `UpdateCommission`, the program's CPI
`Authorize` to its PDA, the CPI `UpdateCommissionCollector`, a direct `UpdateCommission` that lands and **fails**
(`MissingRequiredSignature` in the rehearsal), then a PDA-signed `Withdraw` through `sweep`, `release_validator`, and a
closing `UpdateCommission` that succeeds again.

## 7. Keepers

```bash
cp scripts/devnet/devnet.env.example /abs/path/devnet.env   # outside the repo; fill in the key paths
pnpm build && EPOCH_ENV_FILE=/abs/path/devnet.env pm2 start scripts/devnet/pm2.devnet.config.js
```

The indexer reads mainnet data (`DATA_RPC_URL`) and the devnet program; cranks, publisher and the Panta bot point at
devnet. The template sets no Panta API key, so Panta stays off. The publisher votes with the three operator keys
(`INDEX_OPERATOR_KEYPAIR_PATHS`): the second vote reaches two thirds, the third is recorded late; cranks_app
finalizes after the window and closes settled ballots (rent back to the voter that paid it).

The Fee Index comes from mainnet epochs, the program reads devnet's clock. The template sets
`FEE_INDEX_EPOCH_OFFSET=auto`: the publisher posts each finished mainnet epoch under devnet's current epoch − 1. A fixed
offset (the method in `packages/publisher_app/README.md`) drifts now that devnet's slots are 0.239 s against mainnet's ≈
0.4 s. Devnet epochs (≈ 28.6 h) also outpace mainnet's (≈ 48 h), so about two devnet epochs in five get no index value,
and quotes or swaps on those epochs cannot settle; the maker should quote only epochs that will get a value, or treat
the others as open.

## 8. Hand the upgrade authority to the owner

```bash
pnpm devnet deploy --url devnet --keys "$KEYS" --deployer "$DEPLOYER" \
  --program-keypair "$KEYS/devnet-program.json" --skip-build --upgrade-authority-to <owner wallet pubkey>
```

With the same bytes on chain it deploys nothing and only runs `solana program set-upgrade-authority`; the deployer
cannot undo it. Check: `solana program show <program id> -ud` shows the owner's wallet as `Authority`.

## 9. Rehearsal findings

- Legacy vote init leaves the block-revenue commission at 10,000 bps; collectors and the withdraw authority still
  move as designed.
- `release_validator` hands the block-revenue collector back to the identity, which must be a rent-exempt account.
  Real identities always are; `cp1` funds its throwaway identity with the minimum.
- `sweep` answers `RewardsInProgress` in the first slots of an epoch; the kit retries it (60 × 5 s at most).
- The local test validator charges 6,960 lamports per byte although it reports SIMD-0437 active; devnet charges 5,080.
- Devnet's DBC build refuses a fixed-supply config with the whole supply on the curve (`createConfig` →
  `InvalidTokenSupply`, 6020); the launch pre-flight caught it in simulation and sent nothing. `rDEV3` launches with a
  0.1 SOL raise, which leaves a leftover. A failed launch stops only that step; the seed exits non-zero at the end.
- Rehearse the launch with `localnet.sh dump-meteora --out <dir>` (read-only) and `localnet.sh start --meteora <dir>`.
- A sweep of a vote account that holds no revenue still counts as an epoch of history: when the launch let an epoch
  boundary pass before the first revenue was sent, v1's limit fell to 0.75 SOL and the seed refused the 1 SOL advance
  (its pre-check). The seed now sends any revenue a vote account still owes before its sweep.
- On 64-slot local epochs the boundary can pass mid-step: quotes, the swap and quote withdrawals read the live epoch
  and retry on `QuoteEpochMismatch` / `QuoteExpired`. On devnet's 28.6 h epochs this is rare but handled the same way.
- Rehearsal on 7 Oct 2026, 21:33–21:45 IST, main with stages 1–3 (operator consensus, LiteSVM, `get_sfi`), Agave CLI
  4.1.1 on macOS: deploy 11.144600520 SOL at max-len 1,600,000 (1,261,400-byte build) → init with the operator
  registry → seed --wait (`rDEV3` launched and registered, quotes 5–9 then rolling, the swap, v1's 1 SOL advance at the
  planned 1.125 SOL limit) → seed again (the deployer spent 0) → cp1 --wait (all 8 steps), then cranks_app and
  publisher_app for 90 s on the kit's keys (the operators voted the Fee Index through the registry).
- The local test validator activates SIMD-0500 (no new SBPF v0–v2 deployments) from genesis; devnet has not activated
  it (7 Oct), and the build is SBPF v0. `localnet.sh` deactivates it, so the rehearsal deploys what devnet accepts.
- On macOS, `localnet.sh` resolved paths with GNU `realpath -m` and `scripts/set-program-id.sh` edited the IDL with GNU
  sed's `0,/re/` address; both now work with the BSD tools.
- `programs/epoch/tests/build-sbf.sh` compiles a copy of the crate in the same target dir, and cargo then took the
  real crate's build as fresh and kept the copy's binary (with the LiteSVM program id). The script now drops the
  `epoch` fingerprint before and after its build, and `deploy` drops it before building; `deploy`'s check that the
  build embeds the program id caught it first.
