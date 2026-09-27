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

Scopes: `program`, `credit`, `market`, `pool`, `epoch-sdk`, `indexer`, `cranks`, `publisher`, `panta-bot`, `api`, `common`, `pg_models`, `solana`, `app`, `ci`, `docs`.

## Local checks

```bash
anchor build && anchor test
cargo fmt --all && cargo clippy --workspace -- -D warnings
pnpm build && pnpm lint && pnpm test && pnpm ccd
```

`pnpm install` sets up a husky pre-commit hook that runs ESLint and Prettier on staged TypeScript. New packages follow the template in [`docs/REPO_STRUCTURE.md`](docs/REPO_STRUCTURE.md#package-anatomy).

## Rules

- **Never commit keypairs, seed phrases or `.env` files.** Keypairs live outside the repo.
- Every instruction that moves funds needs a test, including the failure path.
- Use `Logger.create()` instead of `console.*`, and throw `EpochException` subclasses instead of bare `Error`s in app code.
- Program changes that touch accounting must keep the invariants in `docs/THREAT_MODEL.md`.
- Any code reused from before the hackathon window must be disclosed in the PR description.
