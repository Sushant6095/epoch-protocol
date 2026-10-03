# Epoch operator script

For a validator onboarded with Epoch: the program holds the vote account's withdraw authority, so commission and
identity changes, bond withdrawals and leaving go through the Epoch program, signed by the position's **operator**
key. The app has no screen for these (decision 19); this script is it.

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

`OPERATOR_KEYPAIR_PATH` is the path to the operator's keypair file; the script reads it at run time and never prints
it. Keep keypair files outside the repository. `OPERATOR_CU_PRICE_MICROLAMPORTS` (default 10000) sets the priority
fee.

| Command | Instruction(s) | What it checks first |
| --- | --- | --- |
| `status --vote <v>` | — (read only) | prints the position (status, operator, payout, identity, bond, score and freshness, hedged, revenue history, late epochs), the vote account as the program cluster sees it (withdraw authority, commission, collectors) and the open advance (principal, fee, repaid, outstanding, remit) |
| `update-commission --vote <v> --kind inflation\|block --bps <n>` | `update_commission(kind, bps)` | 0–10,000 bps; inflation ≥ the pool's `min_commission_bps`; with an advance open, not below the current rate. The vote program applies changes after a one-epoch delay. |
| `update-identity --vote <v> --new-identity-keypair <path>` | `update_identity` + `set_collectors` | position Active, no advance open; the new identity key co-signs. The identity change resets the block revenue collector to the new identity, so `set_collectors` points it back at the escrow in the same transaction; `--no-set-collectors` leaves it out (clusters without SIMD-0232) and you must re-run it before the next sweep. |
| `withdraw-bond --vote <v> --sol <x>` | `withdraw_bond(lamports)` | no advance open, position Active, at most the bond |
| `release --vote <v> [--new-withdrawer <key>]` | `release_validator` | no advance open, position Active. The withdraw authority goes to the original withdrawer unless `--new-withdrawer` says otherwise; the bond, the escrow balance and the position's rent come back to the operator; on v4 vote accounts the collectors are reset to the vote account and the identity. |

Every command also checks that the signer is the position's operator and that the program is still the vote
account's withdraw authority. Then it prints the summary and every instruction (accounts with signer/writable flags
and names, data in hex), **simulates** the transaction, and:

- with `--dry-run`, stops there (exit 0 when the simulation passes);
- otherwise asks `Send this transaction as <operator>? (y/N)` and sends only on `y`/`yes`, printing the signature and
  an explorer link.

A failed check or simulation exits 1 with the program's error by name (e.g. `BondLocked`, `CommissionChangeBlocked`).

## Why `release` passes the identity account as writable

The epoch-sdk builder mirrors the program's `ReleaseValidator` accounts struct, where `identity` is a read-only
`UncheckedAccount`. But on a v4 vote account whose block revenue collector is the escrow, `release_validator` CPIs the
vote program's `UpdateCommissionCollector(BlockRevenue → identity)`, and that instruction takes the new collector as a
writable account. The runtime refuses to let a CPI write to an account the outer transaction passed read-only
("writable privilege escalated"), so the release would fail. The script marks the identity's account meta writable
(a read-only flag is a ceiling, not a check: Anchor accepts the account either way).

This is a program bug to report: `identity` in `programs/epoch/src/instructions/credit/release.rs` should be
`#[account(mut, address = position.identity @ EpochError::IdentityMismatch)]`; once it is, the SDK builder (regenerated
from the program) and this script agree and the patch can go.
