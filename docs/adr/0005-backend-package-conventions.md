# ADR 0005: One flat package layout for all TypeScript

**Status:** accepted · 27 Sep 2026

**Context.** Five long-running services (indexer, cranks, publisher, Panta bot, API) need the same plumbing: env loading, config validation, logging with trace IDs, typed errors, an HTTP server, Postgres access, RPC failover and graceful shutdown. Written per service, that plumbing drifts within days, and two people working in parallel end up solving the same problem twice. The layout also has to stay obvious to a judge reading the repo cold.

**Decision.**

- Every TypeScript package lives flat in `packages/`. No `services/` folder.
- Deployables end in `_app` (`indexer_app`, `api_app`). Client SDKs end in `-sdk` (`epoch-sdk`, `config-sdk`). Everything else is a library with a plain name (`common`, `logger`, `pg_models`).
- Every package has the same shape: `@epoch/<name>`, `main: dist/index.js`, one `src/index.ts` entry, scripts `build`, `build:watch`, `dev`, `lint`, `lint:fix`, `test` (apps add `start` and `watch`), CommonJS output from a shared `tsconfig.base.json`.
- Plumbing lives in libraries: `common` (env loader, constants, shutdown, helpers, `pkg/` re-exports of third-party modules), `logger`, `exceptions`, `config-sdk`, `common_http_server`, `pg_models` (drizzle schema and migrations), `solana` (RPC failover, epoch clock, transaction sender, Yellowstone stream).
- An app's first import is `@epoch/common/first-module`, which loads `--env <file>` before anything reads `process.env`. Config is then validated with a `config-sdk` schema, so a missing variable fails at boot, not at the first epoch boundary.
- Apps depend on libraries, never on each other. `pnpm ccd` (madge) fails CI on a circular import.
- ESLint 9 flat config, Prettier, husky + lint-staged on commit, jest for `*.test.ts` beside the code.
- One `deployments/Dockerfile` builds any app via `--build-arg APP=<name>`; `pm2.config.js` runs all of them on a single box.

**Consequences.** Adding a service is copying a package folder and adding one line to `pm2.config.js`. Libraries compile to `dist/`, so every app needs `pnpm build` before it runs (the `watch` script uses `tsx` for development). The Next.js app stays in `app/` with its own toolchain; it consumes `@epoch/epoch-sdk` only.
