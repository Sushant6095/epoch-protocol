# My Stake · `/me`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § My Stake (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`4-my-stake.jpg`](../design/boards/4-my-stake.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § My Stake, rows MS9–MS41 (the dashboard). Each row is a test case.

The older wireframes ([`05-my-stake-signed-in.png`](../design/wireframes/05-my-stake-signed-in.png), [`05b-my-stake-sign-in.png`](../design/wireframes/05b-my-stake-sign-in.png)) are superseded.

**Job:** the delegator's home and the page most of the 500k target users will see: is my SOL safe, what
did I earn, what should I change. Predict sits lower on the same page (`pages/predict.md`). Signed out,
this route shows the sign-in split screen (`pages/sign-in.md`). The demo wallet holds 100 SOL across
three real validators.

**Users:** signed-in delegators; anyone in read-only mode (`/me?address=…`).

## Refero lock for this page

Style: **Fey** (`08ae8676-eeed-4eba-9835-856c0f25a1d4`, feyapp.com) — pull with `refero_get_style`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Mercury — Home (dark)](https://refero.design/pages/859b1114-d9af-4c87-ab18-4b26fa4f8896) · `859b1114-d9af-4c87-ab18-4b26fa4f8896` | Welcome line + a row of action pills (Stake more · Move stake · Export); a balance card with a chart and a period dropdown; an accounts list card (validator · SOL); small cards below (alerts, rewards). | Six equal cards; banking actions. |
| secondary | [Kraken — Staking](https://refero.design/pages/aa8460b1-db4b-40aa-a920-a1921d852c4d) · `aa8460b1-db4b-40aa-a920-a1921d852c4d` | The balance + total-rewards pair, the staked-assets table with Stake / Unstake buttons and its empty state. | The light purple theme and the promo box. |
| secondary | [Mercury — Transactions (dark)](https://refero.design/pages/2443b687-2f0d-464a-9a30-39567fba1d25) · `2443b687-2f0d-464a-9a30-39567fba1d25` | Filter row + summary line + grouped rows: rewards per epoch and stake history. | Banking columns. |

Run `/refs my-stake` first: it pulls these images through the Refero MCP and writes `design/screens/my-stake.md`.

## Layout, top to bottom (map to the references)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Title row | Wallet chip ("signed in with Phantom") · SOL / USD / INR switch · Export for taxes · **Stake more** | `useMyStake(wallet)` → `wallet`; `network.price` | Mercury "Welcome" + action pills |
| 2 | Tiles | Staked 100.00 SOL (3 accounts, 4.21 idle) · earned last 30 days +0.422 SOL · your APY 5.13% vs 4.95% network · next rewards countdown · health: 2 healthy, 1 to watch | `stakeAccounts`, `idleSol`, `monthSol`, `blendedApyPct`, `network.stake.medianApyPct` | Kraken Staking balance + total rewards pair |
| 3 | Alert banner (only when something is wrong) | "Project 0 Horizon earns less than its vote fees and one delegator holds 86% of its stake" · "See healthier options" | derived from `healthReasons` | — |
| 4 | **Hero: your stake accounts** | Helius 60 SOL, NTT DOCOMO GLOBAL 25, Project 0 Horizon 15: APY with split, fee, earned per epoch, HealthBadge with reason, since epoch, Orb link; row → validator profile; Move / Unstake actions per row | `stakeAccounts[]` | Mercury accounts list card + Kraken staked-assets table |
| 5 | Rewards per epoch | 12 bars (epochs 1033–1044, the current one pending) + per epoch, per month, per year in the chosen unit | `perEpochSol`, `monthSol`, `yearSol` (API: per-epoch rewards) | Mercury balance card chart |
| 6 | Where your stake sits | 60 / 25 / 15 split bar with a TOP-18 badge and one paragraph on why concentration matters | derived | — |
| 7 | Healthier homes for your 15 SOL | Three real suggestions (Solana Mobile Validator, polkachu.com, ParaFi Technologies): 0% fee, above break-even, not top-18, no downtime; picking one shows the two-signature move plan and its cost (≈ 0.003 SOL, one epoch of rewards) → TxPreview | `suggestions[]` | — |
| 8 | Predict | its own page since 30 Sep: `/predict` (`pages/predict.md`); My Stake links there, `/me#predict` redirects | `usePredict` | Stocktwits poll card |
| 9 | Alerts | Four switches (goes offline, fee goes up, starts losing money, rewards landed) + channel: Email, Telegram, Browser | `alerts[]` | Mercury transactions filter row style for the channel picker |
| 10 | Lend to validators (with your vault shares) | One row per tranche the wallet holds: SOL value, shares × share price, since epoch, Junior lock; empty: "No vault shares yet"; the target and not-staked note; Manage in the Vault → | `useLenderPosition(address)` (request #8d), `useVault().tranches` | Mercury Home small cards |

## Rules

Health rules live in one module (`src/lib/health.ts`), shared with Validators and alerts (see
`01-PRODUCT-AND-USERS.md`). Every badge shows its reason in words. Units switch (SOL/USD/INR) applies
everywhere on the page and persists (zustand + localStorage).

## Read-only mode

`/me?address=<wallet>` renders the same page from any address; every action button says "Sign in to …"
and opens the sign-in flow; a quiet banner says "Viewing <short address> read-only".

## States

Skeleton tiles and rows; a wallet with no stake accounts gets an empty state with **Browse validators**
and a one-line "how staking works"; RPC error → last known data with "updated N min ago".

## Done when

- [ ] One hero (the stake-account list with health badges); the alert banner appears only when needed.
- [ ] Every action goes through TxPreview → wallet → pending → confirmed with an explorer link.
- [ ] design-cop all PASS, axe and impeccable clean.

## Live sites to look at (not on Refero)

- [Hyperliquid portfolio](https://app.hyperliquid.xyz/portfolio) — the holdings summary
- [Stakewiz](https://stakewiz.com) — the "my stakes" health view and alerts
