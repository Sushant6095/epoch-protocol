# Contributing to Epoch

Thanks for helping build Epoch. This guide keeps the codebase consistent and the history readable.

## Workflow

1. Branch off `main`: `feat/credit-sweep`, `fix/indexer-lag`, `docs/readme`.
2. Keep branches short-lived (hours to a day) and commit small, focused changes.
3. Open a pull request against `main` and fill in the template.
4. CI must pass before merging. Squash-merge with a Conventional Commit title.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(credit): add sweep waterfall
fix(indexer): handle gRPC reconnect
docs: explain credit limit formula
test(credit): fuzz rounding in waterfall
chore(ci): cache cargo registry
```

Scopes: `program`, `credit`, `market`, `pool`, `sdk`, `indexer`, `cranks`, `publisher`, `panta-bot`, `api`, `app`, `ci`, `docs`.

## Local checks

```bash
anchor build && anchor test
cargo fmt --all && cargo clippy --workspace -- -D warnings
pnpm typecheck
```

## Rules

- **Never commit keypairs, seed phrases or `.env` files.** Keypairs live outside the repo.
- Every instruction that moves funds needs a test, including the failure path.
- Program changes that touch accounting must keep the invariants in `docs/THREAT_MODEL.md`.
- Any code reused from before the hackathon window must be disclosed in the PR description.
