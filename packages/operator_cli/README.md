# Epoch operator script

For the pool admin and for validators onboarded with Epoch. The program holds each onboarded vote account's withdraw
authority, so commission and identity changes, bond withdrawals and leaving go through the Epoch program, signed by
the position's **operator** key; the pool's set-up and emergency switches are signed by the pool **admin**. The app
has no screen for these (decision 19); this script is it.

```bash
pnpm install && pnpm build
cat > .env.operator <<'EOF'
EPOCH_CLUSTER=devnet
EPOCH_RPC_URL=https://api.devnet.solana.com
EPOCH_PROGRAM_ID=<the Epoch program id>
OPERATOR_KEYPAIR_PATH=~/.config/solana/operator.json
EOF
pnpm operator status --vote <VOTE> --env .env.operator
```

`OPERATOR_KEYPAIR_PATH` is the path to the signer's keypair file; `--keypair <path>` replaces it for one run (the pool
admin's key for the admin commands). The script reads keypair files at run time and never prints them. Keep them
outside the repository. `OPERATOR_CU_PRICE_MICROLAMPORTS` (default 10000) sets the priority fee.

**Every command that builds a transaction is a dry run unless `--send`:** it prints the summary and every instruction
(accounts with signer/writable flags and names, data in hex) and **simulates** it. With `--send` it simulates, asks
`Send this transaction as <signer>? (y/N)`, and sends only on `y`/`yes`, printing the signature and an explorer link.
A failed check or simulation exits 1 with the program's error by name (e.g. `BondLocked`, `NotAdmin`).

## Validator operator

| Command | Instruction(s) | What it checks first |
| --- | --- | --- |
| `status --vote <v>` | — (read only) | prints the position (status, operator, payout, identity, bond, score and freshness, hedged, revenue history, late epochs), the vote account as the program cluster sees it (withdraw authority, commission, collectors) and the open advance (principal, fee, repaid, outstanding, remit) |
| `update-commission --vote <v> --kind inflation\|block --bps <n>` | `update_commission(kind, bps)` | 0–10,000 bps; inflation ≥ the pool's `min_commission_bps`; with an advance open, not below the current rate. The vote program applies changes after a one-epoch delay. |
| `update-identity --vote <v> --new-identity-keypair <path>` | `update_identity` + `set_collectors` | position Active, no advance open; the new identity key co-signs. A block revenue collector that was the old identity follows the new one, so `set_collectors` (re-)points it at the escrow in the same transaction; an escrow collector stays put (probed on Agave 4.3). `--no-set-collectors` leaves it out (clusters without SIMD-0232). |
| `withdraw-bond --vote <v> --sol <x>` | `withdraw_bond(lamports)` | no advance open, position Active, at most the bond |
| `release --vote <v> [--new-withdrawer <key>]` | `release_validator` | no advance open, position Active, no revenue token in its term. The withdraw authority goes to the original withdrawer unless `--new-withdrawer` says otherwise; the bond, the escrow balance and the position's rent come back to the operator; on v4 vote accounts the collectors are reset to the vote account and the identity (the identity must hold SOL: the vote program wants a rent-exempt collector). |
| `onboard-validator --vote <v> --payout <key> --withdrawer <key> [--bond-sol <x>]` | `onboard_validator` + `set_collectors` (+ `post_bond`) | pool exists and is not paused; no position yet; `--withdrawer` is the vote account's withdraw authority today; inflation commission ≥ the pool minimum. The signer becomes the position's operator. The withdrawer co-signs: here with `--withdrawer-keypair <path>`, or offline (below). |
| `set-collectors --vote <v>` | `set_collectors` | permissionless (the signer pays the fee); v4 vote account; the program holds the withdraw authority |
| `register-revenue-token --vote <v> --mint <m> --dbc-config <c> --share-bps <n> --term-epochs <n>` | `register_revenue_token(share, term)` | the program's own checks, run first with the SDK's mirror (`checkLaunchConfig`): pool not paused; position Active, no revenue token; SPL Token mint, supply > 0, no mint or freeze authority; the DBC pool derived from config and mint trades the mint; the config quotes SOL, graduates to DAMM v2, names the treasury PDA as fee claimer and (fixed supply) leftover receiver, locks 100% of the graduated LP forever, and its fees allow sandwich-proof slices. Prints the venue fee floor and the `max_impact_bps` bound. |

## Pool admin

| Command | Instruction | What it checks first |
| --- | --- | --- |
| `init-pool --params <file.json> --treasury <key> --scorer <key>` | `initialize_pool(params)` | the Pool does not exist; every `PoolParams` field present and in range, and `PoolParams::validate` (bps ≤ 10,000, remit and utilization > 0, hedged ≥ unhedged advance, max ≥ min advance, max advance epochs > 0). The signer becomes the admin and pays the rent. Lamport fields may be decimal strings. |
| `set-roles [--new-admin <key>] [--treasury <key>] [--scorer <key>]` | `set_roles` | the signer is the admin; roles not given keep their keys. Moving the admin to the Squads vault ends the CLI's admin role: later admin actions are Squads proposals. |
| `set-paused --paused true\|false` | `set_paused(paused)` | the signer is the admin. Paused stops deposits, onboarding, advances, quotes and swaps, registrations, treasury claims and buybacks; withdrawals, sweeps and repayments, release, redeem and close continue. |

## Offline signing (onboarding a withdrawer you do not hold)

`onboard_validator` needs two signatures: the operator's and the vote account's current withdraw authority's (often a
cold key). The Solana CLI can decode a transaction (`solana decode-transaction <base64> base64`) but has no command to
sign an arbitrary one, so:

1. Operator: `onboard-validator … --withdrawer <key> --send [--nonce <nonce account>] [--out onboard.tx]` simulates,
   asks, signs as the operator and writes the transaction (base64) to `onboard.tx`. A recent blockhash expires after
   about a minute; for a withdrawer who is not at hand, create a durable nonce account with the operator as authority
   (`solana create-nonce-account`) and pass `--nonce`.
2. Withdrawer, offline (no RPC, no env file): `sign-tx --tx onboard.tx --keypair <withdrawer.json> --out onboard.tx.signed`
   prints every instruction and signer, asks, and adds the signature. It refuses a key the transaction does not ask for.
3. Operator: `submit-tx --tx onboard.tx.signed` checks that every signature is present and valid, simulates with
   signatures verified, and with `--send` (after `y`) sends it.
