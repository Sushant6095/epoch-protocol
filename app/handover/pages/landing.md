# Landing · `/`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Landing (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`1-landing.jpg`](../design/boards/1-landing.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § Landing, rows LA1–LA24. Each row is a test case.

The older wireframes ([`01-landing.png`](../design/wireframes/01-landing.png)) are superseded.

**Job:** say what Epoch is in one line, prove it with live chain numbers, and send everyone to one action:
**Check my stake**. The only long-scroll marketing page, and the only place motion may be bold.

**Users:** everyone — delegators first, then lenders, validators, judges.

## Refero lock for this page

Style: **Hyper Foundation** (`54511793-579d-4406-a389-4d83b7ade0f9`, hyperliquid.xyz) — pull with `refero_get_style`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Kraken — staking landing](https://refero.design/pages/26b6852a-a193-40ce-8a1e-0db681b00d76) · `26b6852a-a193-40ce-8a1e-0db681b00d76` | One headline with a single number, two lines of copy, one button; the three numbered steps under the hero (get → choose → earn) become Epoch's how-it-works (stake → validator borrows → lenders earn). | The purple brand, the embedded video, any promised yield. We show live network numbers, never a promised rate. |
| secondary | [Linear — dark proof band](https://refero.design/pages/409d9c75-156c-4c24-a462-1623d7b5047c) · `409d9c75-156c-4c24-a462-1623d7b5047c` | Four very large numbers in a 2 × 2 band with tiny captions and one quote above: our stat strip (683 validators · 441.0M SOL staked · 582,644 delegators · 4.95% median APY). | Customer logos and the testimonial if we have none. |
| secondary | [Robinhood — dark hero with one 3D object](https://refero.design/pages/e88e3f97-ae72-426d-9c84-5c9ac5a56b5f) · `e88e3f97-ae72-426d-9c84-5c9ac5a56b5f` | One sculpted object on black with one huge line: the only place WebGL/shadergradient is allowed. | The card-and-coins illustration, the neon green. |

Run `/refs landing` first: it pulls these images through the Refero MCP and writes `design/screens/landing.md`.

## Layout, top to bottom (map to the references)

| # | Section | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Header | the app shell header (see `02-SITEMAP-AND-ROUTES.md`) | `useNetwork` → epoch, price | — |
| 2 | Slot ruler | 96 ticks sweeping each slot, current slot number, the leader right now | WS `slot` (fixture: `network.epoch`) | Epoch's own; anime.js stagger |
| 3 | Hero | "The revenue desk for *Solana validators.*" (serif accent on the last two words), two lines of copy, **Check my stake** (primary, 52 px) + **Open the Terminal** (ghost), trust line "Your staked SOL never leaves your own stake account" | static copy | Kraken staking hero (one line + one button); Hyper Foundation style (serif display, pill buttons, one glowing card) |
| 4 | Epoch clock card (the one glowing card) | Ring at 91.6%, next-rewards countdown, blocks today, TPS, stake arriving +0.95M and leaving −0.97M SOL | `useNetwork` → `epoch.*`, `blocks.perDay`, `tps.total`, `stake.activatingThisEpochSol`, `stake.deactivatingThisEpochSol` | Hyper Foundation elevated card |
| 5 | Proof band | 683 validators · 441.0M SOL staked · 582,644 delegators · 4.95% median APY (2 × 2 on desktop, stacked on phones); second row small: 323,376 blocks/day · top-18 hold 1/3 · finality ≈ 8.5 s (32 slots × 267 ms) | `useNetwork` | Linear dark proof band (huge numbers, tiny captions) |
| 6 | Why now | Three cards: validators 2,560 → 683 (−73% since 2023, small line chart) · 136 earn less than their vote fees · 338 hang on one delegator | `network.validatorCountHistory`, `network.validators.*` | — |
| 7 | How it works | Three numbered steps + an animated flow: vote account → Epoch escrow → Vault (repays) and validator payout (keeps the rest) | static | Kraken's 1-2-3 steps; @xyflow/react or Magic UI animated-beam for the flow |
| 8 | Pick your side | Three audience cards (delegators, lenders, validators), each with its real number and link | `network.delegators.wallets`, vault TVL, `network.validators.total` | — |
| 9 | Who holds the stake | Split bar: retail ≈573,000 wallets 3.4% · mid-size ≈9,000 16.4% · allocators 560 holders 80.2%; biggest-delegators table; "where retail stakes" bars (Everstake 120,031 wallets … Solana Mobile 25,607) | `network.delegators.*`, `useBiggestDelegators`, `useRetailMagnets` | OpenSea data-console density |
| 10 | Predict teaser | One sample market card with the YES/NO bar, pool, players, "Settles by Panta" + "18+ · where allowed" | `usePredict` → `markets[0]` | Stocktwits poll card |
| 11 | Don't trust, verify | Five explorer tiles for one real vote account (NTT DOCOMO GLOBAL) | `useValidator` → `vote`, `identity`; `lib/explorers.ts` | — |
| 12 | Final CTA + footer | "Is your validator healthy?" + Check my stake; footer strip | — | Kraken closing band |

## Motion (the landing is allowed to be alive)

- Hero words rise in (GSAP SplitText, 400 ms, 45 ms stagger) once; shader gradient (@shadergradient/react)
  or one R3F object behind the hero, paused when off-screen and replaced by a static image under reduced
  motion; Lenis smooth scroll; ScrollTrigger reveals per section (transform/opacity only); the flow lines
  in How it works animate their dashes; numbers roll in once when the proof band enters.
- Never animate layout properties; nothing loops except the live dot, the slot ruler and the countdown.

## States

Numbers show a skeleton shimmer on first load and never a zero. If a live feed drops, keep the last value
and grey the live dot with "updated 2 min ago". WebGL failure falls back to the static gradient image.

## Copy

Hero: "The revenue desk for *Solana validators.*" · sub: "Validators borrow against their next paychecks,
lenders earn the fees, and every staker can see which validators are healthy." · Never promise a yield;
show live network numbers. Predict teaser uses "call", "pool", "payout" only.

## Done when

- [ ] One hero (line + clock card + one primary button); everything else quieter.
- [ ] Hero readable and the primary button visible at 390 × 844 without scrolling.
- [ ] Lighthouse performance ≥ 85 on desktop with the 3D hero; WebGL paused off-screen.
- [ ] design-cop all PASS at four breakpoints; axe clean; impeccable clean.

## Live sites to look at (not on Refero)

- [Hyperliquid](https://app.hyperliquid.xyz/) — calm dark surfaces, the thin live ticker, one strong action (screens saved in `handover/design/references/hyperliquid/` on your Mac)
- [Orb](https://orbmarkets.io) — the explorer-grade feel for the slot ruler and the verify tiles
- [validators.app](https://www.validators.app/validators?network=mainnet) — the plain, data-first tone of "meet the validators"
