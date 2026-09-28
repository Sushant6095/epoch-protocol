# Security policy

Epoch is **pre-alpha software and has not been audited.** Mainnet deployments during the hackathon run with strict per-validator and total-pool caps and a pause switch held by a multisig.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through [GitHub Security Advisories](https://github.com/Sushant6095/epoch-protocol/security/advisories/new) with:

- a description of the issue and its impact
- steps to reproduce, or a proof of concept
- affected program address, commit or version

We aim to acknowledge reports within 72 hours.

## Scope

- `programs/epoch` (on-chain program)
- `packages/*_app` (indexer, cranks, publisher, API) and the shared libraries in `packages/`
- `app/` (web app)

## Known trust assumptions

- In v1 the fee index is posted by a single publisher key; each value is bounded per epoch, held for a dispute window and can be vetoed by the admin multisig before it is final.
- The program upgrade authority is held by a Squads multisig.

See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
