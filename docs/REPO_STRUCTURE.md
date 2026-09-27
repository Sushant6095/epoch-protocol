# Repository structure

The rule: **one public monorepo; each folder has one job; every TypeScript package sits flat in `packages/`; nothing runs from `docs/`.** Package conventions are fixed in [ADR 0005](adr/0005-backend-package-conventions.md). When you add code, find its folder below. If none fits, open an ADR before creating a new top-level folder.

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
├─ packages/                       Every TypeScript package, flat. Libraries have plain names, deployables end in _app
│  ├─ common/                      @epoch/common: FirstModule env loader, constants, GracefulShutdown, helpers, pkg/ re-exports
│  ├─ logger/                      @epoch/logger: Logger.create(tag), trace IDs via AsyncLocalStorage
│  ├─ exceptions/                  @epoch/exceptions: EpochException + http/ chain/ config/ database/ subclasses
│  ├─ config-sdk/                  @epoch/config-sdk: loadConfig(schema) + zod schemas per concern
│  ├─ common_http_server/          @epoch/common_http_server: ExpressAppServer, handle(), validate(), ok()
│  ├─ pg_models/                   @epoch/pg_models: drizzle schema, PostgresConnectionManager, migrations/
│  ├─ solana/                      @epoch/solana: RPC failover, EpochClock, TransactionSender, GrpcStream, keypairs
│  ├─ epoch-sdk/                   @epoch/epoch-sdk: IDL, PDAs, account decoders, instruction builders, math mirror
│  ├─ indexer_app/                 Yellowstone gRPC → slot fees, epoch index, validator revenue, program events
│  ├─ cranks_app/                  Epoch-boundary jobs (claim, score, sweep, settle, accrue)
│  ├─ publisher_app/               post_index / post_quote + Switchboard feed
│  ├─ panta_bot_app/               Panta market lifecycle
│  └─ api_app/                     REST API for the Terminal and app
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
├─ deployments/                    Dockerfile (any *_app via --build-arg APP), node base image, readme
├─ pm2.config.js                   Runs every *_app on one box
└─ docs/                           Architecture, threat model, plans, ADRs, runbooks, assets
   ├─ adr/                         Numbered architecture decision records
   └─ runbooks/                    epoch-boundary.md, incident.md, mainnet-deploy.md
```

## Package anatomy

Every package in `packages/` has the same shape, so moving between them costs nothing:

```text
packages/<name>/
├─ package.json      "@epoch/<name>", main dist/index.js, scripts: build build:watch dev lint lint:fix test (+ start watch for *_app)
├─ tsconfig.json     extends ../../tsconfig.base.json, rootDir src, outDir dist
└─ src/
   ├─ index.ts       the only public entry (apps: the process entry, first line imports @epoch/common/first-module)
   └─ *.test.ts      jest tests next to the code they cover
```

Inside an app, folders are PascalCase by role: `Routes/ Controllers/ dto/ types/` (api), `Streams/ Processors/ Repositories/` (indexer), `Jobs/` (cranks), `Publishers/` (publisher).

## Conventions

| Topic | Rule |
| --- | --- |
| Naming | Deployables end in `_app`; client SDKs end in `-sdk`; everything else is a library with a plain name |
| Dependencies | Apps depend on libraries, never on other apps. `pnpm ccd` fails CI on any circular import |
| Third-party libs | Wrapped once (`@epoch/common/pkg/*`, Express via `@epoch/common_http_server`) so versions live in one place |
| Env | Loaded once by `@epoch/common/first-module` (`--env <file>`, default `./.env`), then validated with a `@epoch/config-sdk` schema |
| Logging | `Logger.create('Tag')` only; `console.*` is a lint error. Every HTTP request carries a trace ID |
| Errors | Throw an `EpochException` subclass; the HTTP server maps it to `{ ok: false, error, traceId }` |
| Program | One instruction per file; account validation in the `Accounts` struct; all arithmetic via `math/` with checked ops; every state change emits an event |
| SDK | Generated IDL is committed under `packages/epoch-sdk/src/idl/`; apps never hand-roll instructions |
| Jobs | Every crank job is idempotent and safe to re-run for the same epoch |
| DB | Schema in `pg_models/src/db_models/schema.ts`; `pnpm db:generate` writes numbered SQL to `pg_models/migrations/`; migrations are append-only |
| App (web) | Server components for data pages; client components only where wallet or live data is needed |
| Secrets | `.env` locally, platform secrets in deploys; keypairs never inside the repo or an image |
| Style | ESLint 9 flat config + Prettier; husky pre-commit runs lint-staged. snake_case Rust, camelCase TS, PascalCase classes and components |

## Everyday commands

| Command | What it does |
| --- | --- |
| `pnpm build` | Builds every package in dependency order |
| `pnpm lint` / `pnpm lint:fix` | ESLint across packages |
| `pnpm test` | Jest across all `*.test.ts` |
| `pnpm ccd` | Circular-dependency check (madge) |
| `pnpm db:up` / `pnpm db:migrate` | Local Postgres in Docker / apply migrations |
| `pnpm dev:api` | API with reload |
| `pnpm --filter @epoch/<name> <script>` | Run one package's script |

## How it grows after the hackathon

| Next step | Where it goes |
| --- | --- |
| USDC lending pool | `instructions/pool/` + a `quote_mint` on `Pool`; no new program |
| Order-book Fee Market | `instructions/market/book/`; replaces quotes (ADR 0004) |
| DePIN / protocol-revenue borrowers | New `programs/epoch-adapters/` implementing a revenue-source interface |
| Audit-frozen program | Move `programs/` to its own repo and make it immutable; app keeps shipping here |
| New service | `packages/<name>_app` from the same template; add it to `pm2.config.js` and `deployments/readme.md` |
| Public SDK | Publish `@epoch/epoch-sdk` to npm |
