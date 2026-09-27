# Repository structure

The rule: **one public monorepo; each folder has one job; shared code lives in `packages/`; nothing runs from `docs/`.** When you add code, find its folder below. If none fits, open an ADR before creating a new top-level folder.

```text
epoch-protocol/
├─ programs/epoch/                 On-chain program (Anchor 1.2, Rust)
│  └─ src/
│     ├─ lib.rs                    Thin: #[program] dispatch only
│     ├─ constants.rs              Seeds, bps, reserves, caps
│     ├─ errors.rs                 EpochError
│     ├─ events.rs                 Anchor events consumed by the indexer
│     ├─ state/                    One file per account type
│     │  ├─ pool.rs  validator_position.rs  advance.rs
│     │  └─ fee_index.rs  fee_quote.rs  swap_position.rs  withdraw_request.rs
│     ├─ instructions/
│     │  ├─ pool/                  initialize, deposit, request_withdraw, process_withdrawals, accrue, admin
│     │  ├─ credit/                onboard, update_score, request_advance, sweep, mark_default, release
│     │  └─ market/                post_quote, open_swap, post_index, settle_epoch
│     ├─ math/                     Pure functions, unit-tested: shares, waterfall, credit_limit, score
│     └─ cpi/vote.rs               Vote-program CPI: authorize, withdraw, update_commission_collector
│
├─ packages/                       Shared TypeScript libraries (no side effects)
│  ├─ sdk/                         @epoch/sdk: IDL, PDAs, account decoders, instruction builders, math mirror
│  ├─ common/                      @epoch/common: env config (zod), logger, RPC connection, retry, epoch clock
│  └─ db/                          @epoch/db: SQL migrations + typed queries (Postgres)
│
├─ services/                       Long-running processes (deployed to Fly.io)
│  ├─ indexer/                     Yellowstone gRPC → slot fees, epoch index, validator revenue, program events
│  ├─ cranks/                      Epoch-boundary jobs (claim, score, sweep, settle, accrue)
│  ├─ publisher/                   post_index / post_quote + Switchboard feed
│  ├─ panta-bot/                   Panta market lifecycle
│  └─ api/                         REST + websocket for the app
│
├─ app/                            Next.js 16 (deployed to Vercel)
│  └─ src/
│     ├─ app/                      Routes: / (Terminal), /validators, /validators/[vote], /vault, /market
│     ├─ features/                 terminal/ validator/ vault/ market/  (components + hooks per feature)
│     ├─ components/               ui/ (shadcn), charts/, layout/
│     └─ lib/                      solana.ts, wallet-provider.tsx, api-client.ts, format.ts
│
├─ tests/                          Cross-package integration tests (TS, localnet/devnet)
├─ programs/epoch/tests/           LiteSVM tests (Rust) with epoch warping
├─ scripts/                        deploy, keys, init-pool, seed-devnet, cp1-testnet, onboard-validator
├─ infra/                          fly/ (per service), vercel.json, supabase/ config
└─ docs/                           Architecture, threat model, plans, ADRs, runbooks, assets
   ├─ adr/                         Numbered architecture decision records
   └─ runbooks/                    epoch-boundary.md, incident.md, mainnet-deploy.md
```

## Conventions

| Topic | Rule |
| --- | --- |
| Program | One instruction per file; account validation in the `Accounts` struct; all arithmetic via `math/` with checked ops; every state change emits an event |
| SDK | Generated IDL is committed under `packages/sdk/src/idl/`; the app and services never hand-roll instructions |
| Services | Read config only through `@epoch/common`; every job idempotent; structured JSON logs |
| DB | Migrations are append-only and numbered (`0001_init.sql`); no ORM magic |
| App | Server components for data pages; client components only where wallet or live data is needed |
| Secrets | `.env` locally, Fly/Vercel secrets in deploys; keypairs never inside the repo |
| Naming | kebab-case folders, snake_case Rust, camelCase TS, PascalCase components |

## How it grows after the hackathon

| Next step | Where it goes |
| --- | --- |
| USDC lending pool | `instructions/pool/` + a `quote_mint` on `Pool`; no new program |
| Order-book Fee Market | `instructions/market/book/`; replaces quotes (ADR 0004) |
| DePIN / protocol-revenue borrowers | New `programs/epoch-adapters/` implementing a revenue-source interface |
| Audit-frozen program | Move `programs/` to its own repo and make it immutable; app keeps shipping here |
| Public SDK | Publish `@epoch/sdk` to npm |
