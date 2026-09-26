# Epoch

**The revenue desk for Solana validators.** Validators borrow against the commission Solana pays them every epoch, and lock in the value of their fee income. Repayment is taken at source: the Epoch program holds the vote account's withdraw authority and sweeps an agreed share of revenue to lenders each epoch.

Built for Colosseum Crypto World's Fair (submissions close 12 Oct 2026).

## Modules

| Module | What it does |
| --- | --- |
| Epoch Credit | Revenue-based advances to validators, repaid at source; senior and junior tranches for lenders |
| Epoch Fee Market | Per-epoch fixed-for-floating swaps on the Solana Fee Index |
| Epoch Score | On-chain credit score per validator from uptime, commission history and revenue |
| Epoch Terminal | Public live dashboard of the fee index, validator health and the loan book |

## Repo layout

```text
programs/epoch/     Anchor program (Rust): pool, credit, fee market
packages/sdk/       TypeScript client generated from the program IDL
services/indexer/   Yellowstone gRPC (Solami) → fee index + revenue → Postgres
services/cranks/    Epoch-boundary jobs: claim, score, sweep, settle, accrue
services/publisher/ Posts the fee index on-chain + Switchboard feed
services/panta-bot/ Creates and resolves Panta markets on the fee index
services/api/       REST + websocket for the Terminal
app/                Next.js app: Terminal, Validator Console, Vault, Fee Market
tests/              Program tests (Anchor + LiteSVM epoch-boundary tests)
docs/               Architecture, threat model, plan, side tracks
```

## Prerequisites

- Rust (see `rust-toolchain.toml`), Solana CLI, Anchor 1.2 via AVM
- Node 22+ and pnpm

## Getting started

```bash
pnpm install
anchor keys sync     # generates the program ID and writes it into lib.rs + Anchor.toml
anchor build
anchor test
pnpm --filter app dev
```

Copy `.env.example` to `.env` and fill in RPC and gRPC endpoints. Never commit keypairs.

## Side-track integrations

| Track | Integration |
| --- | --- |
| Solami | Indexer and Terminal stream live mainnet data from Solami gRPC |
| RPC Fast | Cranks land transactions through RPC Fast; second data stream for failover |
| Panta | Bot creates a parimutuel market each epoch on the fee index |

See `docs/SIDE_TRACKS.md`.

## Status

Day 0 scaffold. See `docs/PLAN.md` for checkpoints and gates.

## License

MIT
