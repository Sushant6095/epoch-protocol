# Epoch program: mainnet go-live

The order of operations for putting the Epoch program on mainnet with real money, from an empty cluster to running
cranks. Documentation only: every key below lives outside the repository, nothing here holds or prints a secret, and
each command is shown with placeholders. Run each on-chain step as a dry run first (the operator CLI is a dry run
unless `--send`).

Roles you need before you start:

| Role | What it is | Where its key lives |
| --- | --- | --- |
| Program keypair | Fixes the program id. Signs the first deploy only. | Offline; back it up, then it is never needed again |
| Deployer | Pays rent and the buffer writes; first upgrade authority for minutes | Hot wallet with ~10 SOL, emptied afterwards |
| Squads multisig vault | Upgrade authority and pool admin from then on | Squads v4 (the **vault** address, not the multisig account) |
| Pool admin (set-up) | Signs `init-pool`, then hands the admin to the vault | Hot key, used once |
| Treasury | Receives the protocol fee at `accrue` | Any key or the vault |
| Scorer | Signs `update_score` for the score crank | The scorer crank's own key |
| Crank | Sends sweeps, buybacks, claims, accrue | `CRANK_KEYPAIR_PATH`, ~1 SOL for fees |

## 1. Program id

```bash
solana-keygen new --no-bip39-passphrase -o <offline dir>/epoch-program.json   # never inside the repo
solana-keygen pubkey <offline dir>/epoch-program.json                         # → <PROGRAM_ID>
scripts/set-program-id.sh <PROGRAM_ID>
```

`set-program-id.sh` rewrites every copy of the id (`declare_id!`, `Anchor.toml` localnet/devnet/mainnet,
`.env.example`, the IDL's address) and regenerates the SDK's Rust vectors, then runs `scripts/check-program-id.sh`,
which fails if any copy disagrees (the epoch-sdk test `programId.test.ts` checks the same in `pnpm test`). Commit the
change, then run the gates: `cargo test`, `cargo clippy -- -D warnings`, `pnpm build`, `pnpm test`.

## 2. Verifiable build

Build in Docker so anyone can reproduce the bytes, and record the hash:

```bash
solana-verify build --library-name epoch                      # deterministic, in the solana-verify image
solana-verify get-executable-hash target/deploy/epoch.so      # record it with the commit hash
```

(`anchor build --verifiable` produces the same kind of build.) The current program is about 957 KB (957,464 bytes in
the last build; the size depends on the exact source and toolchain).

## 3. Deploy through a buffer

Writing a buffer first means the deploy itself is one transaction, the bytes can be checked before they go live, and
later upgrades can be approved by the multisig.

```bash
# 1. Write the program into a buffer (≈ 950 write transactions; resumable with --buffer <BUFFER_KEYPAIR>)
solana program write-buffer target/deploy/epoch.so -u mainnet-beta \
  --fee-payer <deployer.json> --buffer-authority <deployer.json> \
  --with-compute-unit-price <micro-lamports> --max-sign-attempts 100 --use-rpc
# → Buffer: <BUFFER>

# 2. Check the buffer holds exactly the build
solana-verify get-buffer-hash -u mainnet-beta <BUFFER>          # must equal the executable hash

# 3. First deploy from the buffer (the program keypair signs once; leave headroom for upgrades)
solana program deploy -u mainnet-beta --buffer <BUFFER> \
  --program-id <offline dir>/epoch-program.json --upgrade-authority <deployer.json> \
  --max-len <bytes, e.g. 1200000> --with-compute-unit-price <micro-lamports>
```

The buffer's rent returns to the payer when the deploy consumes it; the program-data account keeps
`(45 + max_len + 128) × 6,960` lamports.

| What | Bytes | Lamports | SOL |
| --- | --- | --- | --- |
| Program data at the build's size (45-byte header + 957,464) | 957,509 | 6,665,153,520 | 6.665 |
| Program data with `--max-len 1200000` (room to grow) | 1,200,045 | 8,353,204,080 | 8.353 |
| Program account | 36 | 1,141,440 | 0.001 |
| Buffer (37-byte header + program), refunded at deploy | 957,501 | 6,665,097,840 | 6.665 |
| Buffer writes, ~950 transactions at 5,000 lamports, before priority fees | – | ~4,750,000 | ~0.005 |

**Extending program data.** An upgrade whose `.so` is larger than the program-data account fails until the account
grows. `solana program deploy` extends automatically for an upgrade (unless `--no-auto-extend`); by hand:

```bash
solana program extend -u mainnet-beta <PROGRAM_ID> <additional bytes> --payer <deployer.json> -k <authority>
```

Once the vault holds the upgrade authority, extend through a Squads transaction (or before handing it over). Space
costs 6,960 lamports per byte.

## 4. Upgrade authority → Squads

Do this right after the deploy, before any money arrives:

```bash
solana program set-upgrade-authority -u mainnet-beta <PROGRAM_ID> \
  --upgrade-authority <deployer.json> \
  --new-upgrade-authority <SQUADS_VAULT> --skip-new-upgrade-authority-signer-check
solana program show -u mainnet-beta <PROGRAM_ID>               # Authority: <SQUADS_VAULT>
```

`--skip-new-upgrade-authority-signer-check` is needed because a vault PDA cannot sign; double-check the address
first (a wrong one locks the program forever). Later upgrades: write a buffer, `solana program set-buffer-authority
<BUFFER> --new-buffer-authority <SQUADS_VAULT>`, check `solana-verify get-buffer-hash`, then propose the upgrade in
Squads (Programs → upgrade from buffer) and approve it to threshold.

Check the deployed bytes against a fresh build of the commit:

```bash
solana-verify verify-from-repo -u mainnet-beta --program-id <PROGRAM_ID> \
  https://github.com/<org>/<repo> --commit-hash <sha> --library-name epoch --mount-path .
```

For the explorers' "verified" badge, the verification record is uploaded to an on-chain PDA signed by the upgrade
authority: with the vault as authority, `solana-verify export-pda-tx` builds that transaction for Squads; once it
executes, submit the remote verification job (`solana-verify remote submit-job`).

## 5. The pool: `init-pool`, then roles

Configure the operator CLI (`packages/operator_cli/README.md`) with `EPOCH_CLUSTER=mainnet`, a paid
`EPOCH_RPC_URL` and `EPOCH_PROGRAM_ID=<PROGRAM_ID>`. Write the pool parameters to a file outside the repo, every
`PoolParams` field (lamport amounts as strings). The values are a credit decision; this is the shape (the localnet
test's values, not a recommendation):

```json
{
  "seniorRateBpsPerEpoch": 3, "protocolFeeBps": 1000, "advanceBpsUnhedged": 2500, "advanceBpsHedged": 4000,
  "bondMultiplier": 4, "feeBps": 200, "remitBps": 5000, "minScore": 6000, "scoreTtlEpochs": 3,
  "minAdvanceLamports": "1000000000", "maxAdvanceLamports": "500000000000", "maxPoolAssets": "5000000000000",
  "maxUtilizationBps": 6000, "minJuniorBps": 2000, "juniorLockEpochs": 2, "maxAdvanceEpochs": 20,
  "voteReserveLamports": "1600000000", "minCommissionBps": 0
}
```

```bash
pnpm operator init-pool --params <params.json> --treasury <TREASURY> --scorer <SCORER> --keypair <setup-admin.json>
pnpm operator init-pool … --send                         # after the dry run reads right; rent ≈ 0.0044 SOL
pnpm operator set-paused --paused true --keypair <setup-admin.json> --send     # optional: closed until ready
pnpm operator set-roles --new-admin <SQUADS_VAULT> --keypair <setup-admin.json>         # dry run, then --send
```

After `set-roles` the CLI can no longer sign admin actions: pausing, parameters, roles and revenue-token settings
(`configure_revenue_token`) become Squads proposals. Build them from the CLI's dry-run output (program, accounts with
flags, data in hex) in Squads' transaction builder. Unpause the same way when ready.

## 6. Onboarding validators

The validator's operator runs it; the vote account's current withdraw authority co-signs once:

```bash
# Withdrawer key at hand:
pnpm operator onboard-validator --vote <VOTE> --payout <PAYOUT> --withdrawer <WITHDRAWER> \
  --withdrawer-keypair <withdrawer.json> [--bond-sol <x>] --send
# Withdrawer offline: the operator signs and writes the transaction; a durable nonce keeps it valid
solana create-nonce-account <nonce.json> 0.0015 --nonce-authority <OPERATOR> -u mainnet-beta
pnpm operator onboard-validator --vote <VOTE> --payout <PAYOUT> --withdrawer <WITHDRAWER> \
  --nonce <NONCE_ACCOUNT> --out onboard.tx --send
#   withdrawer, offline:  solana decode-transaction "$(cat onboard.tx)" base64   (inspect)
#                         pnpm operator sign-tx --tx onboard.tx --keypair <withdrawer.json> --out onboard.tx.signed
pnpm operator submit-tx --tx onboard.tx.signed --send
```

Onboarding also points both commission collectors at the escrow (`set_collectors`, v4 vote accounts). Rent:
0.00378 SOL (position) + 0.00089 SOL (escrow). The Solana CLI cannot sign an arbitrary transaction, which is why the
offline step is `sign-tx` (no RPC, no config).

## 7. Revenue-token launch and registration

1. Launch on the DBC with Epoch's preset: `docs/runbooks/meteora-mainnet-launch.md`. The program refuses to
   register a token unless its DBC config quotes SOL, graduates to DAMM v2, names the treasury PDA
   `["treasury", pool]` as fee claimer and (fixed supply) leftover receiver, locks 100% of the graduated liquidity
   forever, and charges a fee at least half the impact cap (`fee_floor_bps`; Epoch's 1% preset gives a 200 bps bound).
2. The validator's operator registers it:

   ```bash
   pnpm operator register-revenue-token --vote <VOTE> --mint <MINT> --dbc-config <CONFIG> \
     --share-bps <1–5000> --term-epochs <10–1000>          # runs the program's checks first; then --send
   ```

   Rent 0.00732 SOL, returned by `close_revenue_token`. The share starts with the next epoch's sweep.

## 8. Cranks

`cranks_app` with `CRANK_KEYPAIR_PATH`, `EPOCH_PROGRAM_ID`, `EPOCH_CLUSTER=mainnet`, a paid RPC and the usual
priority fee: sweeps every epoch, `accrue`, withdrawals, score updates (the scorer key), buybacks
(`BUYBACK_ENABLED=true`, `BUYBACK_SLIPPAGE_BPS=100`, `BUYBACK_COMPUTE_UNITS=300000`) and treasury claims
(`LAUNCH_CLAIMS_ENABLED=true`, `LAUNCHES_PATH`, `LAUNCH_CLUSTER=mainnet`). The crank fronts small rents (≤ 0.0041 SOL)
that come back in the same instruction, so it pays only fees. Details: `docs/REVENUE_TOKENS_MAINNET.md`.

## 9. Before money moves

- `solana program show <PROGRAM_ID>`: authority is the vault; data length and balance as expected.
- `solana-verify get-program-hash -u mainnet-beta <PROGRAM_ID>` equals the recorded hash.
- `scripts/check-program-id.sh` passes on the deployed commit.
- `pnpm operator status --vote <VOTE>` for each onboarded validator: withdraw authority "(the Epoch program)",
  collectors on the escrow.
- The pool is unpaused (a Squads proposal) only after the above.
