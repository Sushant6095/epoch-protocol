# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Monorepo scaffold: Anchor 1.2 program skeleton, pnpm workspace, services, Next.js app
- Account types: `Pool`, `ValidatorPosition`, `Advance`, `FeeIndex`, `SwapPosition`
- Architecture, threat model, plan and side-track docs
- CI for the program and TypeScript packages
- Shared backend libraries: `common`, `logger`, `exceptions`, `config-sdk`, `common_http_server`, `pg_models`, `solana`
- `api_app` serving `/health` and `/v1/index` from Postgres; initial drizzle migration for six tables
- Fee index math (per-slot median excluding leader-paid transactions, stake-weighted epoch median) with tests
- ESLint, Prettier, husky pre-commit, jest, circular-dependency check; Dockerfile and pm2 config
- Implementation plan, repository structure guide, ADRs 0001–0005

### Changed

- All TypeScript packages moved to a flat `packages/` layout: deployables end in `_app`, the program client is `@epoch/epoch-sdk` (ADR 0005)
