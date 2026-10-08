# Vault · `/vault`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Vault (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`5-vault.jpg`](../design/boards/5-vault.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § Vault, rows VA1–VA37. Each row is a test case.

The older wireframes ([`06-vault.png`](../design/wireframes/06-vault.png)) are superseded.

**Job:** let anyone lend SOL to validators and choose their risk. Retail picks **Senior** (paid first,
target 0.04% per epoch); funds and treasuries pick **Junior** (first loss after the validator's bond,
keeps everything above the senior target). Every number is sample today, but all of them obey the
program's rules, so they double as test fixtures.

**Users:** lenders (senior: retail; junior: funds, DAOs, treasuries); judges.

## Refero lock for this page

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Mercury — Treasury](https://refero.design/pages/26e9c3a5-c493-4ab4-a7f9-216dc95b85c6) · `26e9c3a5-c493-4ab4-a7f9-216dc95b85c6` | Balance + available line; an allocation ring with two named parts (Senior / Junior); net yield and all-time earnings; a Portfolio tab with one card per fund (yield, type, risk rating) and the fine-print estimate line. Rebuild it in our dark tokens. | The light theme, fund prospectus links. |
| flow | [Copperx flow 8894 · step 5 — amount and quote](https://refero.design/pages/06475d7f-d26e-4a49-b649-30fa76adc86a) · `06475d7f-d26e-4a49-b649-30fa76adc86a` | Amount on top, 'you get' below with a live estimate, one toggle, one button. | Bridging. |
| flow | [Copperx flow 8894 · step 11 — ready to review](https://refero.design/pages/bb22ea58-3993-48e1-aa3a-2b35c1309ad6) · `bb22ea58-3993-48e1-aa3a-2b35c1309ad6` | The review state before signing. | — |
| flow | [Copperx flow 8894 · step 14 — progress step list](https://refero.design/pages/09948e77-45b2-4e9b-8c90-a2bd83f81344) · `09948e77-45b2-4e9b-8c90-a2bd83f81344` | A vertical step list while the transaction lands (signed → confirmed → shares minted). | Cross-chain steps. |
| flow | [Copperx flow 8894 · step 16 — success](https://refero.design/pages/eb79095c-7f3d-44a2-88e8-7f58dccab175) · `eb79095c-7f3d-44a2-88e8-7f58dccab175` | Success modal with the amount and 'See details'. | — |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6) · `7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | Transaction preview rows + 'Review carefully' + Cancel / Confirm for deposit(tranche, amount). | Swap wording. |
| secondary | [Column — account with transfers (dark)](https://refero.design/pages/10d78fe2-0d3a-45e8-b086-abc28c644ac0) · `10d78fe2-0d3a-45e8-b086-abc28c644ac0` | KPI row over a filterable table with status badges and a direction column: the loan book and withdrawal queue. | Bank transfer types. |

Run `/refs vault` first: it pulls these images through the Refero MCP and writes `design/screens/vault.md`.

## Layout (desktop: 8 + 4 columns; the right column is the sticky DepositPanel)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Title row | Sample · Pre-alpha, unaudited · Live since epoch 1033 pills; "Lend SOL to validators, *repaid at the source.*"; Rules and risks link | `useVault` → `pool.liveSinceEpoch`, `kind` | Mercury Treasury title |
| 2 | Summary | In the vault 1,633 SOL (≈ $195,633, 1,297 lenders) with an allocation ring (senior 1,124 / junior 509) · senior APY 10.9%, target met 12 of 12 epochs · junior APY 23.7% since launch · lent out 190 SOL (11.6%, cap 60%) · lost by lenders 0 SOL (one default, paid by its bond) | `pool`, `tranches` | **Mercury Treasury** balance card + allocation ring + net yield / all-time earnings |
| 3 | **Hero: tranche cards** | Senior: 1,124 SOL, share price 1.0048, withdraw any epoch, 912 SOL of room before junior must grow, "target, paid only from real fees". Junior: 509 SOL, share price 1.0105, 31% of the vault (minimum 20%), cushion 509 SOL + 93 SOL of bonds, locked 10 epochs | `tranches.senior`, `tranches.junior`, `params` | Mercury Treasury per-fund cards (yield, type, risk rating) |
| 4 | Performance chart | Three views (segment): share price for both tranches against plain staking · yield by epoch (senior flat, junior bars rising) · share lent out against the 60% cap | `series` | lightweight-charts; Mercury Insights chart treatment |
| 5 | What protects you | The order a loss travels (bond → junior → senior) as a visx waterfall + StressTestSlider: "the N biggest open advances stop paying today" (validators are never named in the what-if) → what bonds absorb, what junior loses, senior loses nothing (two biggest: bonds 50, junior 88.2 SOL or 17.3%; all eight: junior 106.4 SOL or 20.9%) | `openAdvancesForStressTest`, `tranches` | — |
| 6 | Tabbed tables | Advances (12: score, borrowed, owes with 2%, repaid, progress, bond, epochs, status) · Withdrawal queue (first in, first out) · Lenders (largest, then grouped) · Parameters (12, each with its on-chain name) | `advances`, `withdrawQueue`, `lenders`, `params` | Column account table (KPI row, filters, status badges) |
| 7 | Rules and risks | Six plain sentences: unaudited; vault SOL is not staked (unlent SOL earns nothing); the senior rate is a target; junior can lose; withdrawals wait for cash; who can change parameters | static | — |
| R | **DepositPanel (right, sticky)** | Senior or Junior toggle · amount with 1 / 4 / 25 / 100 chips · shares you get · a year's earnings if the past repeats · the same SOL staked at 4.95% · how you get it back (senior any epoch; junior after 10) · warning when a senior deposit exceeds the room · risk checkbox that unlocks the button → TxPreview (`deposit(tranche, amount)`) → wallet → progress list (signed → confirmed → shares minted) → done with the unlock epoch for junior | `tranches`, `params` | Copperx deposit flow 8894 (amount + estimate → review → progress list → success); Reown Preview swap for the review |

## Rules that protect users

- Call the senior rate a **target** everywhere and say it is paid only from real fees.
- Say plainly that vault SOL is not staked, so unlent SOL earns nothing.
- Keep the deposit button disabled until the risk box is ticked.
- Read every parameter from the pool account (`params`); never hard-code 20%, 60% or 10 epochs.
- Confetti only on a user's FIRST deposit, once.

## States

Skeletons; wallet not connected → the panel shows the amount field and "Connect to deposit"; deposit over
the senior room → warn line with the exact room; utilisation near the cap → info note; error → retry in place.

## Done when

- [ ] Two tranche cards + the deposit panel read as the hero; everything else sits lower or in tabs.
- [ ] Stress slider numbers match the fixture math. Each bond covers only its own advance: bonds absorb
      Σ min(bond, outstanding) and junior loses Σ max(0, outstanding − bond) over the N biggest advances
      (two biggest → bonds 50, junior 88.2 SOL = 17.3%; all eight → junior 106.4 SOL = 20.9%; senior 0).
- [ ] Deposit flow shows exactly what will be signed before the wallet opens.
- [ ] design-cop all PASS, axe and impeccable clean.

## Live sites to look at (not on Refero)

- [Hyperliquid vaults](https://app.hyperliquid.xyz/vaults) — the HLP detail page: tiles, About and Performance tabs, bottom tables, a deposit panel on the right
- [DefiLlama yields](https://defillama.com/yields) — always show the yield next to something the reader already knows (plain staking)
- marginfi's deposit action box (mrgn-ts, MIT/Apache-2.0; see `docs/UI_SOURCES.md`) — the preview-before-sign pattern
