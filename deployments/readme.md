# Deployments

Every deployable lives in `packages/*_app` and builds the same way.

| App | What it runs | Port |
| --- | --- | --- |
| `api_app` | REST API for the Terminal and app | `API_PORT` (4000) |
| `indexer_app` | Yellowstone gRPC stream to Postgres, per-slot fee medians | none |
| `cranks_app` | Epoch-boundary jobs: claim MEV, score, sweep, settle, accrue | none |
| `publisher_app` | Pushes the settled Solana Fee Index on-chain | none |
| `panta_bot_app` | Opens and resolves fee-index markets on Panta | none |

## Single box (pm2)

```bash
pnpm install && pnpm build
pm2 start pm2.config.js --env devnet
pm2 logs epoch-indexer
```

## Containers

```bash
docker build -f deployments/Dockerfile --build-arg APP=api_app -t epoch/api .
docker run --env-file .env -p 4000:4000 epoch/api
```

Keypairs are mounted at runtime (`CRANK_KEYPAIR_PATH`, `PUBLISHER_KEYPAIR_PATH`). They are never baked into images and never committed.
