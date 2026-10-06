# 08 · Git workflow — where you push, what you never touch

Repo: `github.com/Sushant6095/epoch-protocol` (public). You (`chahat-code`) are a collaborator.
Package manager: pnpm 10.28 (the root `package.json` pins it), Node 22+ (`.nvmrc`).

## Your folder

| Path | Owner | You may |
| --- | --- | --- |
| `app/**` (the Next.js app, this kit, `design/`, `scripts/`, `.claude/`, `.mcp.json`, `.impeccable/`) | **Chahat** | create, edit, delete, reorganise freely — anything UI or frontend |
| `pnpm-lock.yaml` (root) | shared | change it ONLY through `pnpm --filter app add/remove`; commit it with `app/package.json` |
| `programs/**` (Anchor program) | Sushant | read only |
| `packages/**` (api_app, indexer, cranks, publisher, panta-bot, epoch-sdk, pg_models …) | Sushant | read only; ask for changes in `handover/BACKEND-REQUESTS.md` |
| `tests/**`, `deployments/**`, `Anchor.toml`, `Cargo.*`, `rust-toolchain.toml` | Sushant | read only |
| root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `jest.config*`, `pm2.config.js`, `.husky/`, `.editorconfig`, `.prettier*` | Sushant | read only |
| `.github/**` (CI, CODEOWNERS, templates) | Sushant | read only |
| `docs/**` | Sushant | read only (frontend notes go in `app/handover/` or `app/docs/`) |
| `.env`, `.env.*`, any keypair | nobody commits these | never create or commit |

The Claude Code hooks in `app/.claude/hooks/` block edits and shell writes outside `app/`, pushes to
`main`, force pushes, commits on `main` and `git add -A`.

## First time on your Mac

```bash
git clone git@github.com:Sushant6095/epoch-protocol.git   # or https://github.com/Sushant6095/epoch-protocol.git
cd epoch-protocol
corepack enable && corepack prepare pnpm@10.28.0 --activate
pnpm install
pnpm build                      # builds packages/*, so @epoch/epoch-sdk resolves from app/
git switch -c feat/app-foundation
cp -R ~/Downloads/epoch-frontend/. app/                   # this kit (see app/README.md)
```

`pnpm install` also sets up the repo's husky pre-commit hook (it lints `packages/**/*.ts`; it does not
touch `app/`).

## Every change

1. Start from fresh main:
   ```bash
   git switch main && git pull --rebase
   git switch -c feat/app-<thing>        # feat/app-validators-table, fix/app-epoch-pill, chore/app-deps
   ```
2. Work in `app/` only. One feature per branch; keep branches short (hours to a day).
3. Commit small, with Conventional Commits and the `app` scope (the repo's `CONTRIBUTING.md` lists it).
   From inside `app/` (where Claude Code runs):
   ```bash
   git add .                          # stages app/ only
   git add ../pnpm-lock.yaml          # ONLY when package.json changed — always together
   git commit -m "feat(app): validators table with URL filters and compare tray"
   ```
   From the repo root the same is `git add app pnpm-lock.yaml`. Types: `feat`, `fix`, `refactor`, `perf`,
   `style`, `test`, `docs`, `chore`. Never `git add -A` or `git add -u` (they stage the whole monorepo).
4. Push your branch and open a pull request against `main`:
   ```bash
   git push -u origin feat/app-<thing>
   gh pr create --base main --fill      # or open it on github.com
   ```
5. Fill the PR template: **What / Why / How to test**. For frontend PRs add:
   - screenshots from `design/screens/impl/` (lg and sm at least) and the design-cop verdict file name;
   - `pnpm --filter app typecheck` and `pnpm --filter app build` both green;
   - any code reused from before the hackathon window (for example components or hooks from omnipitch)
     disclosed in the description — a Colosseum rule written into `CONTRIBUTING.md`.
6. Sushant reviews; CI must pass; **squash-merge** with a Conventional Commit title. Delete the branch.

## Keeping up with main

```bash
git fetch origin && git rebase origin/main       # on your feature branch
git push --force-with-lease                      # only on YOUR feature branch, after a rebase
```

`pnpm-lock.yaml` conflict? Do not hand-merge it: take main's version, then re-run your
`pnpm --filter app add …` (or `pnpm install`) so pnpm regenerates it, and commit the result.

## What CI checks today

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile`, then build, lint, format check, tests
and the circular-dependency check — for `packages/` only. So for frontend PRs:
- the lockfile must match `app/package.json` exactly (always commit both together), and
- nothing builds or type-checks `app/` in CI yet: run `pnpm --filter app typecheck` and
  `pnpm --filter app build` yourself before every push. (Adding an `app` job to CI is in
  `BACKEND-REQUESTS.md` for Sushant.)

## Ownership in GitHub

`.github/CODEOWNERS` currently lists `@Sushant6095 @ChahatBiswas` for everything. Sushant will add
`/app/ @chahat-code @Sushant6095` so frontend PRs request your review automatically (tracked in
`BACKEND-REQUESTS.md`; you do not edit `.github/`).

## Never

- push to `main`, force-push a shared branch, or rewrite history on `main`;
- commit `.env*` (except `.env.example`), keypairs (`*-keypair.json`, `id.json`), API keys or MCP tokens;
- commit third-party screenshots (Refero references, Hyperliquid captures) — `design/.gitignore` and
  `handover/design/.gitignore` keep them local;
- copy code from AGPL, "all rights reserved" or unlicensed repos, or use Shadcnblocks in this public repo.
