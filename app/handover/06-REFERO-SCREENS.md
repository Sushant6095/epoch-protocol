# 06 · Refero screens — the reference lock for every page

Chosen on 29 Sep 2026 through the Refero MCP (Chahat's Pro account): about 60 screen searches, 10 similar-screen expansions, 4 style searches with 4 full style pulls, 4 flow searches with 4 full flows, and 90+ screenshots compared side by side. This file is the **reference lock**: every page starts from these screens. Search again only to extend a page, never to replace its primary without a line in `DECISIONS.md`.

**These screens are the target (30 Sep).** Build each page as a structural replica of its screens: same shell,
grid, regions, spacing, type steps, components, states, flows and motion (`12-REPLICA-BLUEPRINTS.md`, the
`refero-replica` skill). Identity stays Epoch's: never take a logo, brand colour, illustration, font or copy.
The design canvas only maps content and behaviour.

- Open a screen: `https://refero.design/pages/<id>` (signed in). A flow: `https://refero.design/flows/<id>`.
- Through Claude Code: `refero_get_screen_image` with `image_size: "full"` to look at it, `refero_get_screen` for its metadata, `refero_get_similar_screens` to expand, `refero_get_flow` for a flow, `refero_get_style` for a style.
- Structure is the target: match the layout, hierarchy, density, spacing rhythm and interaction details 1:1 (check with `scripts/ui/ref-compare.mjs`). Never take a logo, brand colour, illustration, font or copy: those are the reference's identity, and Epoch has its own.
- Reference images you download stay local: `design/screens/<page>/ref-*.png` is git-ignored (third-party screenshots do not go into a public repo).

## The one to follow first

**Wealthsimple — NVDA stock page, dark** · [`47b50f40-2189-480a-8279-8d1796ddf5eb`](https://refero.design/pages/47b50f40-2189-480a-8279-8d1796ddf5eb) · flow [8510](https://refero.design/flows/8510)

It is the closest real screen to what Epoch is: one asset (a validator), one hero number, one chart, and one action panel docked on the right; details in a calm grid below. That single layout carries the validator profile, and its grammar (content left, action right, history below) repeats on the Vault (tranche + deposit panel) and Predict (market + ticket). It is also dark, quiet and has one accent, which is exactly the restraint law. When a page has no better reference, fall back to this one.

## Style locks (visual language)

Refero styles cover marketing pages, not app screens: use them for palette, type, radii and rhythm, then the screens below for structure.

| Style | Source | Use it for | Take | Don't take |
| --- | --- | --- | --- | --- |
| **Hyper Foundation** · `54511793-579d-4406-a389-4d83b7ade0f9` | hyperliquid.xyz | Landing and brand feel | Deep green-black canvas, one mint accent, a large serif display headline over clean sans body, pill buttons (one filled, one ghost), one glowing card, abstract soft 3D behind the hero. | Its exact hex values as our brand, its logo, the 90 px headline size inside the app. |
| **Fey** · `08ae8676-eeed-4eba-9835-856c0f25a1d4` | feyapp.com | App surfaces (Terminal, My Stake, Vault) | The observatory-panel feel: near-black layers two steps apart, one interaction colour, one highlight colour, a profit green, 16 px card radius, 18/20 px card padding, secondary text in slate grey. | Its blue as our action colour (ours is the accent token), its photography. |
| **OpenSea** · `2465f692-3a79-4576-970c-ee56c1e72375` | opensea.io | Tables (Validators, loan book, stake moves) | The midnight data-console density: compact rows, sans for labels with mono for every number, subtle internal borders, ghost buttons, 8 px card radius on dense lists. | Its electric blue, NFT thumbnails as the row anchor. |

Pull the full style with `refero_get_style` (`style_ids`: max 3–4 per call; each is 10–15k characters).

## Page by page

### Landing · `/`

**Hero:** One line, the live epoch clock and one action: Check my stake. Spec: `handover/pages/landing.md`.
Style lock: Hyper Foundation (`54511793-579d-4406-a389-4d83b7ade0f9`).

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Kraken — staking landing](https://refero.design/pages/26b6852a-a193-40ce-8a1e-0db681b00d76)<br>`26b6852a-a193-40ce-8a1e-0db681b00d76` | One headline with a single number, two lines of copy, one button; the three numbered steps under the hero (get → choose → earn) become Epoch's how-it-works (stake → validator borrows → lenders earn). | The purple brand, the embedded video, any promised yield. We show live network numbers, never a promised rate. |
| secondary | [Linear — dark proof band](https://refero.design/pages/409d9c75-156c-4c24-a462-1623d7b5047c)<br>`409d9c75-156c-4c24-a462-1623d7b5047c` | Four very large numbers in a 2 × 2 band with tiny captions and one quote above: our stat strip (683 validators · 441.0M SOL staked · 582,644 delegators · 4.95% median APY). | Customer logos and the testimonial if we have none. |
| secondary | [Robinhood — dark hero with one 3D object](https://refero.design/pages/e88e3f97-ae72-426d-9c84-5c9ac5a56b5f)<br>`e88e3f97-ae72-426d-9c84-5c9ac5a56b5f` | One sculpted object on black with one huge line: the only place WebGL/shadergradient is allowed. | The card-and-coins illustration, the neon green. |

To extend: `refero_get_similar_screens` on the primary, or search "dark crypto protocol landing page with live metrics", "landing page how it works three steps", "big metric numbers band dark".

### Sign in · `/me (signed out) and the Connect modal`

**Hero:** The wallet list and the message you are about to sign. Spec: `handover/pages/sign-in.md`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Reown — split sign-in (dark)](https://refero.design/pages/0457489c-1d8c-49cd-91e3-7e4450b8b00f)<br>`0457489c-1d8c-49cd-91e3-7e4450b8b00f` | Split screen: a value card on the left (three check lines), a short form column on the right with one primary and one secondary button. | Email sign-up. Epoch signs in with a wallet only; the right column is the wallet list. |
| flow | [Acctual flow 8823 · step 2 — wallet list](https://refero.design/pages/7228300f-42cc-4e74-bef3-76405358ae66)<br>`7228300f-42cc-4e74-bef3-76405358ae66` | A searchable list with 'Installed' tags on detected wallets. | EVM wallets; ours are Phantom, Solflare, Backpack, then Wallet Standard. |
| flow | [Acctual flow 8823 · step 4 — connect](https://refero.design/pages/b17e7859-2d52-4de2-8a27-dd3bf7baaa70)<br>`b17e7859-2d52-4de2-8a27-dd3bf7baaa70` | One centred state: wallet icon + 'Continue in your wallet'. | — |
| flow | [Acctual flow 8823 · step 5 — sign to confirm ownership](https://refero.design/pages/8a42925d-ceac-4a84-988a-d145ec6edcf4)<br>`8a42925d-ceac-4a84-988a-d145ec6edcf4` | Exactly our Sign In With Solana step: a calm modal that says you are signing to prove ownership. We add the full message text in mono before the wallet opens. | — |
| flow | [Acctual flow 8823 · step 6 — connected](https://refero.design/pages/50d92ee2-7149-4802-80fe-6e191616ddaf)<br>`50d92ee2-7149-4802-80fe-6e191616ddaf` | The connected state with the address and a disconnect link. | The payment form behind it. |
| secondary | [OpenSea — dark wallet list with chain tags](https://refero.design/pages/8c2b4da5-7d7a-4b6b-8ab5-752fbb032bae)<br>`8c2b4da5-7d7a-4b6b-8ab5-752fbb032bae` | Wallet rows with a small 'Solana' tag and a 'Popular' pill on the top one. | The Ethereum-first order. |

To extend: `refero_get_similar_screens` on the primary, or search "connect wallet modal with list of wallets", "sign message to verify wallet ownership", "wallet login split layout dark".

### Terminal · `/terminal`

**Hero:** Stake on the move: one big chart of stake arriving and leaving per epoch. Spec: `handover/pages/terminal.md`.
Style lock: Fey (`08ae8676-eeed-4eba-9835-856c0f25a1d4`).

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Mercury — Insights (dark)](https://refero.design/pages/18cf9c6a-e713-4e47-a3e2-db729d647cc3)<br>`18cf9c6a-e713-4e47-a3e2-db729d647cc3` | One hero number with its two components beside it (net stake flow · arriving · leaving), Overview / In / Out tabs, a range brush above the chart, a single large chart with a hover card that lists the values for that epoch. | Money-management copy; the left sidebar (Epoch uses a top header). |
| secondary | [Kraken Pro — trading dashboard](https://refero.design/pages/69751349-05f1-4fee-abac-c5452f01bc17)<br>`69751349-05f1-4fee-abac-c5452f01bc17` | The one-line KPI strip across the top (epoch, slot progress, TPS, Fee Index, vault) and the tabbed tables docked at the bottom (Loan book · Top validators · Biggest delegators). | Order book, drawing tools, candle toolbar, the purple. |
| secondary | [Mercury — Insights with insight cards](https://refero.design/pages/f06ee439-d696-4a31-a32c-1e1b6bdfae35)<br>`f06ee439-d696-4a31-a32c-1e1b6bdfae35` | Three plain-language insight cards under the chart ('What changed this epoch'). | The decorative illustration in the middle. |
| secondary | [Stocktwits — Sentiment Index explainer](https://refero.design/pages/9ede2f3b-2a72-41c5-8e09-19d21483cfdb)<br>`9ede2f3b-2a72-41c5-8e09-19d21483cfdb` | A short 'What is this index?' modal: one paragraph, a tiny scale and one button. Use it for the Solana Fee Index explainer. | Fear/greed colours. |

To extend: `refero_get_similar_screens` on the primary, or search "dark finance dashboard hero number with range brush chart", "trading dashboard KPI strip with tabbed tables", "index explainer modal".

### Fee Market · `/terminal?tab=market` (a Terminal tab, added 1 Oct)

**Hero:** the ticket beside the quotes by epoch and the Fee Index chart. Spec: `handover/pages/fee-market.md`. No
new searches: every screen below was already in this lock, picked again for its trading layout.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Kraken Pro — BTC-USD trade screen](https://refero.design/pages/cd4884df-7bf5-4c8e-9814-c604e1e9f6f0)<br>`cd4884df-7bf5-4c8e-9814-c604e1e9f6f0` | Three columns: order form (side tabs, amount with unit, estimate rows, one button), order book (our quotes by epoch with a "now" line), chart with a slim toolbar; the status line at the bottom. | Purple, order types, drawing tools, colour picker, candles, 'Verify your account'. |
| secondary | [Kraken Pro — trading dashboard](https://refero.design/pages/69751349-05f1-4fee-abac-c5452f01bc17)<br>`69751349-05f1-4fee-abac-c5452f01bc17` | The KPI strip and the tabbed tables docked at the bottom (Your swaps · Recent swaps · Settlements). | Resizable panels, several charts at once. |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6)<br>`7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | The review step for `open_swap` and `settle_swap`: rows, 'Review carefully', Cancel / Sign. | Token icons, price impact and slippage rows (the rate is fixed). |
| secondary | [Stocktwits — Sentiment Index explainer](https://refero.design/pages/9ede2f3b-2a72-41c5-8e09-19d21483cfdb)<br>`9ede2f3b-2a72-41c5-8e09-19d21483cfdb` | "How a fee swap works": one paragraph, a payoff scale, one button. | Fear/greed colours. |

To extend: `refero_get_similar_screens` on the primary, or search "trading order form beside order book and chart dark", "positions table docked under a chart".

### Validators · `/validators`

**Hero:** The ranked, filterable table of all 683 validators. Spec: `handover/pages/validators.md`.
Style lock: OpenSea (`2465f692-3a79-4576-970c-ee56c1e72375`).

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [OpenSea — Collection stats (dark)](https://refero.design/pages/52465519-ed54-42b3-95db-30226a52fe32)<br>`52465519-ed54-42b3-95db-30226a52fe32` | Title, Top / Trending / Watchlist tabs, a category dropdown + chip group + time-range segment on one row, sortable columns with the sort arrow on the active one, a star to watch a row, numbers right-aligned in mono. | Big square thumbnails (use a 24 px initials avatar), red for negatives (we use a sign + orange). |
| secondary | [Stocktwits — trending table (dark)](https://refero.design/pages/7e48ec24-1285-410c-8b9d-865dafa2862b)<br>`7e48ec24-1285-410c-8b9d-865dafa2862b` | A sparkline column inside the table (stake over 8 epochs) and the sub-tabs pattern (Healthy · Below break-even · One delegator over 50%). | The social sidebar. |
| secondary | [Kraken — market filters](https://refero.design/pages/0bfeff29-e274-4df6-9006-775da4955138)<br>`0bfeff29-e274-4df6-9006-775da4955138` | Column filter popovers for the advanced filters (client, country, commission range). | The light theme. |
| secondary | [Kraken Pro — market finder with chips](https://refero.design/pages/c7c156f4-429d-41d2-ba4f-8ad2478cf703)<br>`c7c156f4-429d-41d2-ba4f-8ad2478cf703` | Chip row with a toggle for 'show as cards' — our phone layout switches rows to cards. | Pair tickers. |

To extend: `refero_get_similar_screens` on the primary, or search "ranked stats table with category filter chips and time range tabs dark", "table with sparkline column", "column filter popover data table".

### Validator profile (+ Manage tab) · `/validators/[vote]`

**Hero:** The validator's health (Epoch Score and stake) with the stake chart, and one action panel on the right. Spec: `handover/pages/validator.md`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Wealthsimple — NVDA stock page (dark)  ← NORTH STAR](https://refero.design/pages/47b50f40-2189-480a-8279-8d1796ddf5eb)<br>`47b50f40-2189-480a-8279-8d1796ddf5eb` | Identity row with a watch star; one hero number with its change; one chart with a hover crosshair and date label; a time-range segment under the chart; a sticky action card on the right (form rows, an estimate line, one full-width button); a four-column key-value grid ('Market details' → 'Validator details'); news cards → stake moves; an About block. | The options promo card, the warm brown background (we use our tokens). |
| flow | [Wealthsimple flow 8510 · step 3 — order preparation](https://refero.design/pages/363e96ab-a3d1-4eb0-bbfb-1d9e4b0052d8)<br>`363e96ab-a3d1-4eb0-bbfb-1d9e4b0052d8` | How the page tightens when the action panel is in use: compact chart, the panel stays in view. | — |
| secondary | [Stocktwits — sentiment gauge explainer (dark)](https://refero.design/pages/857d5d0b-390b-4e95-a4a7-dd298180b8e7)<br>`857d5d0b-390b-4e95-a4a7-dd298180b8e7` | A gauge-in-a-modal that explains a 0–100 score with its bands: our Epoch Score and health explainer. | Red-to-green gauge colours. |
| secondary | [Mercury — Financing (working capital)](https://refero.design/pages/7afb3554-b9d2-4634-bb44-01c9afd4146f)<br>`7afb3554-b9d2-4634-bb44-01c9afd4146f` | The Manage tab for operators: outstanding balance, a repayment progress bar (repaid vs outstanding), 'N payments left', an upcoming-payments table (epoch · remit · ending balance) and an activity table. | The light theme and banking copy. |

To extend: `refero_get_similar_screens` on the primary, or search "asset detail page with chart and buy panel dark", "score gauge explainer modal", "working capital loan repayment progress and schedule".

### My Stake · `/me`

**Hero:** Your stake accounts with a health badge each. Spec: `handover/pages/my-stake.md`.
Style lock: Fey (`08ae8676-eeed-4eba-9835-856c0f25a1d4`).

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Mercury — Home (dark)](https://refero.design/pages/859b1114-d9af-4c87-ab18-4b26fa4f8896)<br>`859b1114-d9af-4c87-ab18-4b26fa4f8896` | Welcome line + a row of action pills (Stake more · Move stake · Export); a balance card with a chart and a period dropdown; an accounts list card (validator · SOL); small cards below (alerts, rewards). | Six equal cards; banking actions. |
| secondary | [Kraken — Staking](https://refero.design/pages/aa8460b1-db4b-40aa-a920-a1921d852c4d)<br>`aa8460b1-db4b-40aa-a920-a1921d852c4d` | The balance + total-rewards pair, the staked-assets table with Stake / Unstake buttons and its empty state. | The light purple theme and the promo box. |
| secondary | [Mercury — Transactions (dark)](https://refero.design/pages/2443b687-2f0d-464a-9a30-39567fba1d25)<br>`2443b687-2f0d-464a-9a30-39567fba1d25` | Filter row + summary line + grouped rows: rewards per epoch and stake history. | Banking columns. |

To extend: `refero_get_similar_screens` on the primary, or search "dark dashboard home with balance chart and accounts list", "staking balance total rewards staked assets table", "grouped transactions list dark".

### Predict · `/predict` (`/me#predict` redirects here)

**Hero:** The market card with its YES/NO bar. Spec: `handover/pages/predict.md`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Stocktwits — poll card on an asset page (dark)](https://refero.design/pages/50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0)<br>`50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0` | Question, one bar per outcome with its share, total votes and time left, sitting inside a data page rather than a casino lobby. Our card: question, YES/NO bar with pool share, pool in points, players, closes with epoch N. | The social feed, bullish/bearish buttons, the green 'Trade' button. |
| secondary | [Kraken Pro — order form](https://refero.design/pages/cd4884df-7bf5-4c8e-9814-c604e1e9f6f0)<br>`cd4884df-7bf5-4c8e-9814-c604e1e9f6f0` | The ticket: a two-way toggle (YES / NO), amount input with preset chips, an estimate line, one full-width button. | Limit/stop order types. |
| secondary | [Coinbase Advanced — gated ticket](https://refero.design/pages/c2dbc562-373b-4790-b6dd-fa8ac6cf2c59)<br>`c2dbc562-373b-4790-b6dd-fa8ac6cf2c59` | The ticket replaced by a calm blocking state with one button: our 18+ and region check, and 'Connect wallet to call'. | KYC wording. |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6)<br>`7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | The review step: rows of what the call does (market, side, points, payout if right, points left this epoch), 'Review carefully', Cancel / Confirm. Predict is points only (1 Oct): nothing is signed. | Swap wording, the network fee row. |

To extend: `refero_get_similar_screens` on the primary, or search "poll card with percentage bars and votes", "order form buy sell toggle amount presets", "transaction preview modal before signing dark".

### Vault · `/vault`

**Hero:** The two tranche cards and the deposit panel. Spec: `handover/pages/vault.md`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Mercury — Treasury](https://refero.design/pages/26e9c3a5-c493-4ab4-a7f9-216dc95b85c6)<br>`26e9c3a5-c493-4ab4-a7f9-216dc95b85c6` | Balance + available line; an allocation ring with two named parts (Senior / Junior); net yield and all-time earnings; a Portfolio tab with one card per fund (yield, type, risk rating) and the fine-print estimate line. Rebuild it in our dark tokens. | The light theme, fund prospectus links. |
| flow | [Copperx flow 8894 · step 5 — amount and quote](https://refero.design/pages/06475d7f-d26e-4a49-b649-30fa76adc86a)<br>`06475d7f-d26e-4a49-b649-30fa76adc86a` | Amount on top, 'you get' below with a live estimate, one toggle, one button. | Bridging. |
| flow | [Copperx flow 8894 · step 11 — ready to review](https://refero.design/pages/bb22ea58-3993-48e1-aa3a-2b35c1309ad6)<br>`bb22ea58-3993-48e1-aa3a-2b35c1309ad6` | The review state before signing. | — |
| flow | [Copperx flow 8894 · step 14 — progress step list](https://refero.design/pages/09948e77-45b2-4e9b-8c90-a2bd83f81344)<br>`09948e77-45b2-4e9b-8c90-a2bd83f81344` | A vertical step list while the transaction lands (signed → confirmed → shares minted). | Cross-chain steps. |
| flow | [Copperx flow 8894 · step 16 — success](https://refero.design/pages/eb79095c-7f3d-44a2-88e8-7f58dccab175)<br>`eb79095c-7f3d-44a2-88e8-7f58dccab175` | Success modal with the amount and 'See details'. | — |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6)<br>`7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | Transaction preview rows + 'Review carefully' + Cancel / Confirm for deposit(tranche, amount). | Swap wording. |
| secondary | [Column — account with transfers (dark)](https://refero.design/pages/10d78fe2-0d3a-45e8-b086-abc28c644ac0)<br>`10d78fe2-0d3a-45e8-b086-abc28c644ac0` | KPI row over a filterable table with status badges and a direction column: the loan book and withdrawal queue. | Bank transfer types. |

To extend: `refero_get_similar_screens` on the primary, or search "treasury account allocation ring net yield", "deposit modal amount quote review", "transaction progress step list success".

### Launch · `/launch` and `/launch/[mint]` (added 1 Oct)

**Hero:** on the list, the launch card with its raise bar; on a token, the price and what backs it, beside the
Trade card. Spec: `handover/pages/launch.md`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [OpenSea — Drops](https://refero.design/pages/869184ab-10dc-4787-927f-7a90f388f24f)<br>`869184ab-10dc-4787-927f-7a90f388f24f` | `/launch`: bold title over two tabs (Active & upcoming / Past), group headings, one wide card per drop with a status badge, name and creator, a stats line, a countdown and one small button. | The light theme, banner artwork, ETH prices, cart and profile icons. |
| primary | [Wealthsimple — NVDA stock page (dark)  ← NORTH STAR](https://refero.design/pages/47b50f40-2189-480a-8279-8d1796ddf5eb)<br>`47b50f40-2189-480a-8279-8d1796ddf5eb` | `/launch/[mint]`: identity row with a watch star, one price with its change, one chart with a labelled dashed line and range pills, the sticky Buy card, then Market details → what backs it, Dividends → buybacks, News → the buyback feed, About → about and risks. | Options, the promo illustration, account-creation copy. |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6)<br>`7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | The buy and sell review with price impact, minimum received and fee rows, 'Review carefully', Cancel / Sign. | Token logos. |
| secondary | [Coinbase Advanced — gated ticket](https://refero.design/pages/c2dbc562-373b-4790-b6dd-fa8ac6cf2c59)<br>`c2dbc562-373b-4790-b6dd-fa8ac6cf2c59` | The 18+ and region gate before the first trade, with the not-an-offer line. | KYC wording. |

To extend: `refero_get_similar_screens` on OpenSea Drops, or search "token launch page bonding curve progress", "drops list wide cards countdown dark".

## Flows used

| Flow | Product | What it gives Epoch |
| --- | --- | --- |
| [8823](https://refero.design/flows/8823) | Acctual — connect crypto payout wallet | Sign in: choose wallet → connect → sign to confirm ownership → connected |
| [8894](https://refero.design/flows/8894) | Copperx — deposit (17 steps) | Vault deposit: amount + estimate → review → progress list → success → updated balance |
| [8510](https://refero.design/flows/8510) | Wealthsimple — stock detail to order | Validator profile → borrow or stake panel in context |
| [5711](https://refero.design/flows/5711) | Reown — wallet receive and activity | The account menu: address copy, switch account, activity tab |

## What Refero does not have

No Hyperliquid app screens (only its marketing style above), no Polymarket or Kalshi, no Phantom, Jupiter, Drift or any Solana-native app, and no validator dashboards. For Hyperliquid's trading-terminal feel use the saved screenshots in `handover/design/references/hyperliquid/` (local only, never committed). For Solana-specific data layouts use the live sites listed at the end of each page spec.

## Every id in one list

| Id | Product | Original page | Used on |
| --- | --- | --- | --- |
| [`26b6852a-a193-40ce-8a1e-0db681b00d76`](https://refero.design/pages/26b6852a-a193-40ce-8a1e-0db681b00d76) | Kraken | https://www.kraken.com/features/staking-coins | Landing |
| [`409d9c75-156c-4c24-a462-1623d7b5047c`](https://refero.design/pages/409d9c75-156c-4c24-a462-1623d7b5047c) | Linear | https://linear.app/ | Landing |
| [`e88e3f97-ae72-426d-9c84-5c9ac5a56b5f`](https://refero.design/pages/e88e3f97-ae72-426d-9c84-5c9ac5a56b5f) | Robinhood | https://robinhood.com/cash | Landing |
| [`0457489c-1d8c-49cd-91e3-7e4450b8b00f`](https://refero.design/pages/0457489c-1d8c-49cd-91e3-7e4450b8b00f) | Reown | https://cloud.reown.com/sign-in | Sign in |
| [`7228300f-42cc-4e74-bef3-76405358ae66`](https://refero.design/pages/7228300f-42cc-4e74-bef3-76405358ae66) | Acctual | https://app.acctual.com/payments/receive | Sign in |
| [`b17e7859-2d52-4de2-8a27-dd3bf7baaa70`](https://refero.design/pages/b17e7859-2d52-4de2-8a27-dd3bf7baaa70) | Acctual | https://app.acctual.com/payments/receive | Sign in |
| [`8a42925d-ceac-4a84-988a-d145ec6edcf4`](https://refero.design/pages/8a42925d-ceac-4a84-988a-d145ec6edcf4) | Acctual | https://app.acctual.com/payments/receive | Sign in |
| [`50d92ee2-7149-4802-80fe-6e191616ddaf`](https://refero.design/pages/50d92ee2-7149-4802-80fe-6e191616ddaf) | Acctual | https://app.acctual.com/payments/receive | Sign in |
| [`8c2b4da5-7d7a-4b6b-8ab5-752fbb032bae`](https://refero.design/pages/8c2b4da5-7d7a-4b6b-8ab5-752fbb032bae) | OpenSea | https://opensea.io/login | Sign in |
| [`18cf9c6a-e713-4e47-a3e2-db729d647cc3`](https://refero.design/pages/18cf9c6a-e713-4e47-a3e2-db729d647cc3) | Mercury | https://demo.mercury.com/insights/overview | Terminal |
| [`69751349-05f1-4fee-abac-c5452f01bc17`](https://refero.design/pages/69751349-05f1-4fee-abac-c5452f01bc17) | Kraken | https://pro.kraken.com/app/trade/dai-usd | Terminal, Fee Market |
| [`f06ee439-d696-4a31-a32c-1e1b6bdfae35`](https://refero.design/pages/f06ee439-d696-4a31-a32c-1e1b6bdfae35) | Mercury | https://demo.mercury.com/insights/overview | Terminal |
| [`9ede2f3b-2a72-41c5-8e09-19d21483cfdb`](https://refero.design/pages/9ede2f3b-2a72-41c5-8e09-19d21483cfdb) | Stocktwits | https://stocktwits.com/stream/people | Terminal, Fee Market |
| [`52465519-ed54-42b3-95db-30226a52fe32`](https://refero.design/pages/52465519-ed54-42b3-95db-30226a52fe32) | OpenSea | https://opensea.io/rankings | Validators |
| [`7e48ec24-1285-410c-8b9d-865dafa2862b`](https://refero.design/pages/7e48ec24-1285-410c-8b9d-865dafa2862b) | Stocktwits | https://stocktwits.com/sentiment | Validators |
| [`0bfeff29-e274-4df6-9006-775da4955138`](https://refero.design/pages/0bfeff29-e274-4df6-9006-775da4955138) | Kraken | https://trade.kraken.com/markets | Validators |
| [`c7c156f4-429d-41d2-ba4f-8ad2478cf703`](https://refero.design/pages/c7c156f4-429d-41d2-ba4f-8ad2478cf703) | Kraken | https://pro.kraken.com/app/trade/sbr-usd | Validators |
| [`47b50f40-2189-480a-8279-8d1796ddf5eb`](https://refero.design/pages/47b50f40-2189-480a-8279-8d1796ddf5eb) | Wealthsimple | https://my.wealthsimple.com/app/security-details/sec-s-220e8c65080c441aa87da8089460fae4 | Validator profile, Launch |
| [`363e96ab-a3d1-4eb0-bbfb-1d9e4b0052d8`](https://refero.design/pages/363e96ab-a3d1-4eb0-bbfb-1d9e4b0052d8) | Wealthsimple | https://my.wealthsimple.com/app/security-details/sec-s-220e8c65080c441aa87da8089460fae4 | Validator profile |
| [`857d5d0b-390b-4e95-a4a7-dd298180b8e7`](https://refero.design/pages/857d5d0b-390b-4e95-a4a7-dd298180b8e7) | Stocktwits | https://stocktwits.com/symbol/NVDA/sentiment | Validator profile |
| [`7afb3554-b9d2-4634-bb44-01c9afd4146f`](https://refero.design/pages/7afb3554-b9d2-4634-bb44-01c9afd4146f) | Mercury | https://demo.mercury.com/capital/ecommerce | Validator profile |
| [`859b1114-d9af-4c87-ab18-4b26fa4f8896`](https://refero.design/pages/859b1114-d9af-4c87-ab18-4b26fa4f8896) | Mercury | https://demo.mercury.com/dashboard | My Stake |
| [`aa8460b1-db4b-40aa-a920-a1921d852c4d`](https://refero.design/pages/aa8460b1-db4b-40aa-a920-a1921d852c4d) | Kraken | https://www.kraken.com/u/earn/staking | My Stake |
| [`2443b687-2f0d-464a-9a30-39567fba1d25`](https://refero.design/pages/2443b687-2f0d-464a-9a30-39567fba1d25) | Mercury | https://demo.mercury.com/transactions | My Stake |
| [`50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0`](https://refero.design/pages/50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0) | Stocktwits | https://stocktwits.com/symbol/NVDA | Predict |
| [`cd4884df-7bf5-4c8e-9814-c604e1e9f6f0`](https://refero.design/pages/cd4884df-7bf5-4c8e-9814-c604e1e9f6f0) | Kraken | https://pro.kraken.com/app/trade/btc-usd | Predict, Fee Market |
| [`c2dbc562-373b-4790-b6dd-fa8ac6cf2c59`](https://refero.design/pages/c2dbc562-373b-4790-b6dd-fa8ac6cf2c59) | Coinbase | https://www.coinbase.com/advanced-trade/BTC-USDT | Predict, Launch |
| [`7d84a622-9f0f-459a-82a6-5ec05e3dc1a6`](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6) | Reown | https://demo.reown.com/ | Predict, Vault, Fee Market, Launch |
| [`26e9c3a5-c493-4ab4-a7f9-216dc95b85c6`](https://refero.design/pages/26e9c3a5-c493-4ab4-a7f9-216dc95b85c6) | Mercury | https://demo.mercury.com/accounts/treasury/party-treasury-id-0 | Vault |
| [`06475d7f-d26e-4a49-b649-30fa76adc86a`](https://refero.design/pages/06475d7f-d26e-4a49-b649-30fa76adc86a) | Copperx | https://payout.copperx.io/app | Vault |
| [`bb22ea58-3993-48e1-aa3a-2b35c1309ad6`](https://refero.design/pages/bb22ea58-3993-48e1-aa3a-2b35c1309ad6) | Copperx | https://payout.copperx.io/app | Vault |
| [`09948e77-45b2-4e9b-8c90-a2bd83f81344`](https://refero.design/pages/09948e77-45b2-4e9b-8c90-a2bd83f81344) | Copperx | https://payout.copperx.io/app | Vault |
| [`eb79095c-7f3d-44a2-88e8-7f58dccab175`](https://refero.design/pages/eb79095c-7f3d-44a2-88e8-7f58dccab175) | Copperx | https://payout.copperx.io/app | Vault |
| [`10d78fe2-0d3a-45e8-b086-abc28c644ac0`](https://refero.design/pages/10d78fe2-0d3a-45e8-b086-abc28c644ac0) | Column | https://dashboard.column.com/app/accounts/edit/bacc_2iguSXoSImcURHkPZti9uexPGYD | Vault |
| [`869184ab-10dc-4787-927f-7a90f388f24f`](https://refero.design/pages/869184ab-10dc-4787-927f-7a90f388f24f) | OpenSea | https://opensea.io/drops | Launch |
