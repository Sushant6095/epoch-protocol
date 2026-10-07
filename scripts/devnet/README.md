# Devnet go-live kit

`pnpm devnet <command> --url <devnet|testnet|localnet|http(s)://…> --keys <folder outside the repo> [--yes]`

| Command  | What it does                                                                                                                                                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget` | exact SOL per stage on the target cluster, from its own rent rate; sends nothing                                                                                                                                                                                                                                                       |
| `deploy` | sets the program id, builds, deploys through a resumable buffer with room for upgrades (`--max-len` 1,600,000 by default), verifies, hands over the upgrade authority                                                                                                                                                                  |
| `init`   | pool with `config/params.devnet.json`, Fee Index, the operator registry (3 voting keys), role fee floats; a re-run sends nothing                                                                                                                                                                                                       |
| `seed`   | real flows through `@epoch/epoch-sdk`: deposits, a withdrawal request, test vote accounts, onboarding, a revenue token on Meteora's DBC (launched and registered through `@epoch/meteora`'s launch CLI), then per epoch sweeps, accrual, scores, revenue, rolling maker quotes for the next five epochs, a swap, and the first advance |
| `cp1`    | the CP1 mechanism proof on a throwaway vote account; writes `docs/cp1-results.md` on devnet and testnet                                                                                                                                                                                                                                |

Every command is idempotent and resumable (state in `<keys>/state/`, keyed to the cluster's genesis hash and the
program id), refuses mainnet, refuses key paths inside the repo, and prints IST times and explorer links.

- Step-by-step, costs and checks: [`docs/runbooks/devnet.md`](../../docs/runbooks/devnet.md).
- Rehearsal validator shaped like devnet: `scripts/devnet/localnet.sh start|stop --ledger <dir outside the repo> …`;
  `localnet.sh dump-meteora --out <dir>` saves Meteora's devnet DBC, DAMM v2 and Metaplex builds and the DAMM v2
  migration configs (read-only), and `start --meteora <dir>` loads them, so the seed's revenue token launches there too.
- Keepers: `devnet.env.example` (no secrets) and `pm2.devnet.config.js`.
- Tests: `cd scripts/devnet && pnpm test` (also run by the root jest).
