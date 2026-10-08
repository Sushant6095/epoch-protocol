# 12 · Replica blueprints: build the Refero screens

As of 30 Sep 2026 (IST). **The look of every page is its Refero screen.** Rebuild each screen's structure
1:1 (shell, grid, region order and size, spacing, type steps, component anatomy, states, flows, motion)
and fill it with Epoch's content. Identity stays Epoch's: colours (`--ep-*`), fonts (Geist, Geist Mono),
logo, icons (lucide), words and data. Method: the `refero-replica` skill; check: `scripts/ui/ref-compare.mjs`.

The design canvas and `design/boards/*.jpg` are now only the **content and behaviour map**: which numbers,
controls and states exist. Where a board and its Refero screen disagree on layout, the Refero screen wins.

Geometry below is read from Refero's 800 px images and scaled to a 1440 px viewport (× 1.8). Treat it as the
starting point; measure the full images precisely (skill step 2) before building.

## App shell for every app page (Terminal, Validators, Validator, My Stake, Predict, Vault)

Target: the Mercury shell, which three of the app screens share ([Insights](https://refero.design/pages/18cf9c6a-e713-4e47-a3e2-db729d647cc3),
[Home](https://refero.design/pages/859b1114-d9af-4c87-ab18-4b26fa4f8896), [Treasury](https://refero.design/pages/26e9c3a5-c493-4ab4-a7f9-216dc95b85c6));
Stocktwits (Predict) also uses a left sidebar. OpenSea and Wealthsimple use a top bar; their content area is
rebuilt inside this shell so the app has one shell.

| Region | Geometry (1440) | Epoch content | Library |
| --- | --- | --- | --- |
| Sidebar | ≈ 240 px wide, full height, hairline on the right | Top: workspace-switcher row → Epoch ring + "Epoch" + network chip "Mainnet ▾". Nav rows (16 px icon + label, 36 px tall, selected row filled): Terminal · Validators · My Stake (alert count badge) · Vault · Predict. Group label like Mercury's "Workflows" → "Tools": Alerts · Export for taxes · Docs. Bottom: epoch progress (SH6) and "Mainnet · slot · TPS" (SH10) | shadcn `sidebar` (start from the `sidebar-07` block), lucide icons, `badge` |
| Top bar | ≈ 64 px, search field ≈ 680 px wide starting at the content edge | Search with ⌘K hint (SH3–SH5); right: epoch pill (SH6) and SOL price (SH7), then the primary action button with a caret like "Move money ▾" → "Stake ▾" (Stake more · Move stake · Deposit to the Vault), icon buttons (eye = hide balances, bell = alerts), avatar = wallet chip or Connect (SH8, SH9) | shadcn `command`, `dropdown-menu`, `button`, `avatar`, `tooltip`; `@number-flow/react` for the countdown |
| Footer | none (Mercury has none) | The TradingView attribution link sits under each lightweight-charts chart (licence); Sample and network badges live in the sidebar bottom | — |

The landing and sign-in do not use this shell.

## Landing `/` · rows LA1–LA24

Screens: **[Kraken staking landing](https://refero.design/pages/26b6852a-a193-40ce-8a1e-0db681b00d76)** (primary, whole page) ·
[Linear proof band](https://refero.design/pages/409d9c75-156c-4c24-a462-1623d7b5047c) · [Robinhood dark hero object](https://refero.design/pages/e88e3f97-ae72-426d-9c84-5c9ac5a56b5f). Kraken's page is light and purple; Epoch keeps the dark emerald tokens.

| # | Region (Kraken, top to bottom) | Geometry (1440) | Epoch content | Library |
| --- | --- | --- | --- | --- |
| 1 | Marketing top bar: logo left, 7 text links, two pill buttons right (ghost + filled) | ≈ 86 px tall, full bleed | Epoch logo · Terminal · Validators · Vault · Predict · How it works · Docs · buttons "Open the Terminal" (ghost) and "Check my stake" (filled) | shadcn `navigation-menu`, `button` |
| 2 | Hero, two columns inside a left-aligned ≈ 830 px block: headline with a bold number phrase + lighter second line, 4-line paragraph, one small pill button; right a 16:9 media box | text column ≈ 330 px, media ≈ 435 × 245 px (scale both to the content width you choose, keep the ratio) | a number-led headline in Kraken's pattern, e.g. "**136 of 683** validators lose money every epoch." + a lighter second line "See if yours is one of them."; paragraph from `pages/landing.md`; button Check my stake (LA3). Media box = the live epoch ring and countdown (the Robinhood-style single object; WebGL allowed here only) | Magic UI `number-ticker`, `@shadergradient/react` or R3F for the object, GSAP SplitText for the headline |
| 3 | Proof band (Linear): four very large numbers, tiny captions, one line above | full content width | 683 validators · 441.0M SOL staked · 582,644 delegator wallets · 4.95% median APY (LA7) | Magic UI `number-ticker` |
| 4 | Three numbered steps: circle number, coloured title, two-line text, centred in three columns | three columns ≈ 1/3 each | How it works: Stake with a healthy validator → Validator borrows against revenue → Lenders earn the fees (LA10–LA11) | shadcn layout + Motion Primitives `in-view` for the reveal |
| 5 | Card grid: 4 columns of cards (icon, name, pill tag, "Yearly rewards" label + value in green, full-width pill "Stake" button, fine print) | 4 cols, cards ≈ 185 × 370 px, gaps ≈ 24 px, 3 rows | Validator cards from `validators.real.json`: avatar, name, pill (Healthy / Top 18 / Firedancer), "Yearly APY" + value, button "Stake" → the validator page, fine print "commission N%" | shadcn `card`, `badge`, `button` |
| 6 | Two-column FAQ: bold coloured question, 6–8 line answer, 2 × 2 | two columns ≈ 1/2 each | What is an epoch? · How do validators borrow? · Is my SOL safe? · What is the Fee Index? + "Any additional questions? → Docs" | shadcn `accordion` on phones |
| 7 | Bordered disclaimer box | full content width | Unaudited pre-alpha · not financial advice · targets are not promises · Vault SOL is not staked | shadcn `alert` |
| 8 | Full-bleed brand block footer: left CTA (headline + two pill buttons), three link columns, bottom row (logo, round social icons, legal links, language select) | full bleed, ≈ 700 px tall | CTA "Check my stake" + "Open the Terminal"; columns Product · Learn · About; social X · GitHub · Discord | shadcn `select` |

Moved off the landing (no slot in Kraken's page): Why now charts → Terminal "Validators over time"; Who holds
the stake and Where retail stakes → Terminal; Predict teaser → the Predict page; explorer tiles → validator page.

## Terminal `/terminal` · rows TE1–TE32

Screens: **[Mercury Insights](https://refero.design/pages/18cf9c6a-e713-4e47-a3e2-db729d647cc3)** (primary: header, tabs, brush, metric row, chart) ·
[Kraken Pro dashboard](https://refero.design/pages/69751349-05f1-4fee-abac-c5452f01bc17) (KPI strip, docked tables) ·
[Mercury insight cards](https://refero.design/pages/f06ee439-d696-4a31-a32c-1e1b6bdfae35) (cards under the chart) ·
[Stocktwits index explainer](https://refero.design/pages/9ede2f3b-2a72-41c5-8e09-19d21483cfdb) (dialog).

| # | Region | Geometry (1440, content ≈ 1140 px beside the sidebar) | Epoch content | Library |
| --- | --- | --- | --- | --- |
| 1 | Page title + small chip (Mercury "Insights · Share feedback") | title ≈ 28 px text, chip beside it | "Terminal" + Live chip; Sources popover (TE1) | shadcn `badge`, `popover` |
| 2 | Right of the title: date-range dropdown + "Compare to" dropdown | two ≈ 210 px controls | Range "Epochs 1013–1044" (TE5) · Compare to "previous 32 epochs" | shadcn `select` / `dropdown-menu` |
| 3 | KPI strip (Kraken Pro): one line of label/value pairs, no cards | one row, full content width | SOL staked · Validators · Median APY · Fee Index · Vault · Open advances (TE2, TE3) | dashboardcn `kpi-card` (compact) or plain shadcn |
| 4 | Segmented tabs (Overview / Money in / Money out) + ⋮ menu | ≈ 370 px segmented control | Overview / Arriving / Leaving (TE4); ⋮ → Export CSV | shadcn `toggle-group` / Animate UI tabs |
| 5 | Range brush strip with a selection box | ≈ 36 px tall, full width | epochs 980–1044, selection = range (TE6) | lightweight-charts time scale or visx `brush` |
| 6 | Metric row: big number with a dashed-underline label, two component numbers, right: granularity dropdown + chart-type toggle | big number ≈ 40 px | Net stake flow −0.02M · Arriving +0.95M · Leaving −0.97M · "Per epoch ▾" · line/bar toggle | `@number-flow/react`, shadcn `select`, `toggle-group` |
| 7 | One large chart, y labels left, x labels below, hover card with three rows | full width × ≈ 470 px | total active stake + in/out bars; hover card Total active / Arriving / Leaving / Net (TE7) | lightweight-charts + lightweight-charts-react-components |
| 8 | Insight cards row (Mercury insight cards) | 3 cards, equal width | What changed this epoch (TE10) | shadcn `card` |
| 9 | Quick answers: same card anatomy, 4 across, with a segmented control | 4 cards | For stakers · validators · lenders (TE11–TE13) | shadcn `card`, `toggle-group` |
| 10 | Two-column card rows (Mercury Home card anatomy: header, big number, small chart) | 2 or 3 cards per row | Fee Index (TE14–TE15) · Live activity (TE16) · Who holds the stake · Where retail stakes · Validator health · What SOL earns · Vault pulse · Validators over time (TE17–TE23) · network tiles (TE24) | shadcn `card`, `chart` (Recharts), Magic UI `animated-list` (activity) |
| 11 | Docked tabbed tables (Kraken Pro bottom tabs) | full width, 44 px tab row | Loan book · Epochs · Top validators · Biggest delegators · Withdrawal queue (TE25–TE30) | TanStack Table via ReUI `data-grid` or openstatus data-table |
| 12 | Explainer dialog (Stocktwits) | ≈ 440 px dialog | What is the Fee Index? (TE14) | shadcn `dialog` |

## Validators `/validators` · rows VE1–VE41

Screens: **[OpenSea collection stats](https://refero.design/pages/52465519-ed54-42b3-95db-30226a52fe32)** (primary) ·
[Stocktwits trending](https://refero.design/pages/7e48ec24-1285-410c-8b9d-865dafa2862b) (sparkline column) ·
[Kraken filters](https://refero.design/pages/0bfeff29-e274-4df6-9006-775da4955138) (filter popover) ·
[Kraken Pro chips](https://refero.design/pages/c7c156f4-429d-41d2-ba4f-8ad2478cf703) (chips + cards toggle).

| # | Region (OpenSea) | Geometry (1440) | Epoch content | Library |
| --- | --- | --- | --- | --- |
| 1 | Very large bold page title | ≈ 54 px text | "Validators"; Export CSV and Set an alert as quiet buttons at the right (VE1, VE2) | shadcn `button` |
| 2 | Underline tabs: Top / Trending / Watchlist | ≈ 44 px row | All · Healthy · Watch · Watchlist (VE8) | shadcn `tabs` (underline variant) |
| 3 | Filter row: category dropdown left, icon chip group, time-range segmented control right | ≈ 52 px row | Client dropdown (VE14) · chips Below break-even · One delegator > 50% · Hide top-18 · Firedancer · 0% commission (VE19) · trend 8 / 32 / 64 epochs (VE21); search and Filters ▾ (VE9, VE12) sit before the chips | shadcn `select`, `toggle-group`, `popover` (Kraken filter popover), `input` |
| 4 | Table with small-caps header and sort caret, no card around it; rows ≈ 92 px: rank, 40 px square avatar, name + verified mark, bold right-aligned numbers, coloured % change, star at the end | full width | # · Validator (avatar, name, Top-18 mark) · Stake ▾ · Net flow % (coloured) · APY · Delegators · Epoch Score · Health · Trend sparkline (Stocktwits) · star (VE23–VE32) | TanStack Table + Virtual via openstatus data-table; Recharts `sparkline`; shadcn `checkbox` |
| 5 | (no footer in OpenSea) infinite list | — | Load 50 more (VE33) as infinite scroll with a skeleton row | TanStack Virtual |

Additions (no slot in OpenSea): the compare tray and dialog (VE36–VE40) as a floating bottom bar built from
shadcn `sheet` + `card`. Moved: the five filter tiles → the Terminal's Validator health card.

## Validator profile `/validators/[vote]` · rows VP1–VP48

Screens: **[Wealthsimple NVDA page](https://refero.design/pages/47b50f40-2189-480a-8279-8d1796ddf5eb)** (primary, the north star) ·
[its order step](https://refero.design/pages/363e96ab-a3d1-4eb0-bbfb-1d9e4b0052d8) (panel in use) ·
[Stocktwits score gauge](https://refero.design/pages/857d5d0b-390b-4e95-a4a7-dd298180b8e7) (score dialog) ·
[Mercury Financing](https://refero.design/pages/7afb3554-b9d2-4634-bb44-01c9afd4146f) (Manage view).

| # | Region (Wealthsimple) | Geometry (1440) | Epoch content | Library |
| --- | --- | --- | --- | --- |
| 1 | Two columns: main ≈ 2/3, sticky action card ≈ 1/3 on the right | main ≈ 900 px, card ≈ 420 px | — | CSS grid |
| 2 | Identity row: small logo, ticker + star, company name; right: segmented Stocks / Options + "Advanced" button | ≈ 60 px | Avatar, NTT DOCOMO GLOBAL + watch star (VP4), vote key with copy (VP5); right: Overview / Manage (Manage only for the operator, VP16) + "View on ▾" (VP7) | shadcn `avatar`, `toggle-group`, `dropdown-menu` |
| 3 | Big price with unit + change line | price ≈ 40 px | 193,097 SOL active stake · +1,121 this epoch (VP10) | `@number-flow/react` |
| 4 | Line chart with crosshair, date label at the top, dashed reference line with its value at the right edge | ≈ 900 × 300 px | Stake by epoch; the dashed line = break-even stake (VP14) | lightweight-charts |
| 5 | Range pills centred under the chart | ≈ 420 px pill group | 8 · 16 · 32 · 64 epochs (VP15) | shadcn `toggle-group` |
| 6 | Promo card: small image, title, one line, small pill button | full main width, ≈ 160 px | "Borrow against your revenue" → Manage for operators; for others "What the Epoch Score means" → score dialog (VP11) | shadcn `card` |
| 7 | "Market details": 4-column grid of label/value pairs, 3 rows | 4 columns | Validator details: commission · MEV commission · APY · delegators · blocks a day · skip rate · uptime · client · location · since epoch · vote credits · Epoch Score (VP17–VP18) | plain grid |
| 8 | "Dividends" 3-column pairs | 3 columns | Rewards: per epoch · a year · next rewards (VP19) | plain grid |
| 9 | "Financials" 2-column pairs | 2 columns | Revenue: commission and tips, break-even (VP19–VP20) | plain grid, Recharts bar for the waterfall |
| 10 | "News": stacked cards (source, headline, time) + "View all" pill | full main width | Stake moves (VP26–VP27): one card per move, "View all on Orb" | shadcn `card` |
| 11 | "About": paragraph + Show more | full main width | About the validator (VP28), Delegators split (VP21) | shadcn `collapsible` |
| 12 | Right: "Buy" card: title, order-type select, limit-price input with a bid/ask helper line, shares input, estimated cost row, helper text, full-width pill button | ≈ 420 px, sticky | Stake: action select (Stake / Unstake), amount input with "Balance 4.21 SOL", chips 1 · 10 · 25 · 100, "You'll earn ≈" row, button Connect / Review stake → review → pending → done (VP29–VP36, order step 363e96ab) | shadcn `select`, `input`, `toggle-group`, `button` |
| 13 | Manage view (Mercury Financing): outstanding balance, repayment progress bar, "N payments left", upcoming payments table, activity table | main column | Onboard, borrow and repay console (VP23–VP25, VP37–VP48) | shadcn `progress`, TanStack table, ReUI `stepper` |
| 14 | Score dialog (Stocktwits gauge with bands) | ≈ 480 px dialog | Epoch Score 85 with its three parts (VP11–VP12) | dashboardcn radial gauge or Magic UI `animated-circular-progress-bar` |

## My Stake `/me` · rows MS9–MS41

Screens: **[Mercury Home](https://refero.design/pages/859b1114-d9af-4c87-ab18-4b26fa4f8896)** (primary) ·
[Kraken Staking](https://refero.design/pages/aa8460b1-db4b-40aa-a920-a1921d852c4d) (staked table and empty state) ·
[Mercury Transactions](https://refero.design/pages/2443b687-2f0d-464a-9a30-39567fba1d25) (history).

| # | Region (Mercury Home) | Geometry (1440) | Epoch content | Library |
| --- | --- | --- | --- | --- |
| 1 | "Welcome, Jane" title | ≈ 28 px | "gm, 4Tq9…mW2c" or the wallet label; read-only banner above when viewing an address (MS9) | — |
| 2 | Action pill row: one filled pill (Send), ghost pills, "Customize" at the right | ≈ 32 px pills | Stake more (filled) · Move stake · Unstake · Export for taxes · Alerts; right: SOL / USD / INR switch (MS10–MS14) | shadcn `button` (pill), `toggle-group` |
| 3 | Two cards per row. Balance card: label + check icon, big amount with small decimals, chart/table toggle, period dropdown, in and out amounts, area chart with dates | cards ≈ 1/2 width, ≈ 380 px tall | Staked 100.00 SOL, rewards per epoch chart, period dropdown, +earned / −fees (MS16–MS18) | Recharts area via shadcn `chart`, `@number-flow/react` |
| 4 | Accounts card: header with + and ⋮, list rows (icon, name, amount), "View all accounts" | same size | Stake accounts: avatar, validator, SOL, health dot; + = Stake more; "View all" → the full table (MS19–MS22) | shadcn `card`, `avatar` |
| 5 | Second row. Disputes card with a pager (1/9) and progress bars | ≈ 1/2 width | Alerts: page through alerts ("Project 0 Horizon earns less than its vote fees"), See healthier options (MS14–MS15, MS38) | shadcn `card`, `progress` |
| 6 | Credit card card: amount, a two-part progress bar, available amount, Autopay line + Pay button | ≈ 1/2 width | Lend to validators: your vault shares (Senior 4.00 SOL), lent-out bar, Manage in the Vault (MS41) | shadcn `progress`, `button` |
| 7 | Full stake table with Stake / Unstake per row and its empty state (Kraken Staking) | full width | All stake accounts (MS19–MS23); empty wallet → Browse validators | TanStack table |
| 8 | Transactions list: filter row, summary line, grouped rows (Mercury Transactions) | full width | Rewards and stake history (MS35–MS37) | TanStack table with grouping |

Additions: Healthier homes and the two-signature move plan (MS24–MS34) open in a right-side sheet from
"Move stake" (shadcn `sheet`); the sheet's inside follows the Copperx step list (flow 8894).

## Sign in `/me` signed out · rows MS1–MS8, MS56–MS69

Screens: **[Reown split sign-in](https://refero.design/pages/0457489c-1d8c-49cd-91e3-7e4450b8b00f)** (primary) ·
[Acctual wallet flow 8823](https://refero.design/flows/8823) (list → continue → sign → connected) ·
[OpenSea wallet list](https://refero.design/pages/8c2b4da5-7d7a-4b6b-8ab5-752fbb032bae).

| # | Region (Reown) | Geometry (1440) | Epoch content | Library |
| --- | --- | --- | --- | --- |
| 1 | Full-screen split 50 / 50, no app shell | two halves | — | CSS grid |
| 2 | Left half: gradient panel, logo pills top-left, a centred card with an app icon tile, title, subtitle, three check lines | card ≈ 380 × 500 px | Epoch ring tile · "See what your SOL is really doing" · three checks: signing is a message, not a transaction · you approve every action · paste any address (MS2) | shadcn `card`; the gradient uses Epoch tokens only |
| 3 | Right half: centred form column: title, one input, primary button, "or", secondary button | column ≈ 420 px | "Check your stake" · Connect a wallet (primary, MS3) · or · View an address instead (MS4–MS6) | shadcn `input`, `button` |
| 4 | Connect dialog steps (Acctual 8823): searchable list with Installed tags → "Continue in your wallet" → "Sign to confirm ownership" with the message → connected | ≈ 420 px dialog | Phantom · Solflare (Detected), Backpack (Install); the full SIWS message in mono; rejected and error states (MS56–MS69) | shadcn `dialog`, `command`; `@solana/wallet-adapter-react` |

## Predict `/predict` (was `/me#predict`) · rows MS42–MS55

Screens: **[Stocktwits poll card on an asset page](https://refero.design/pages/50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0)** (primary) ·
[Kraken Pro order form](https://refero.design/pages/cd4884df-7bf5-4c8e-9814-c604e1e9f6f0) (ticket) ·
[Coinbase gated ticket](https://refero.design/pages/c2dbc562-373b-4790-b6dd-fa8ac6cf2c59) (18+ and region gate) ·
[Reown transaction preview](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6) (review).
Predict needs a page of its own to match its screen: `/predict`, behind the Predict flag; `/me#predict` redirects.

| # | Region (Stocktwits) | Geometry (1440) | Epoch content | Library |
| --- | --- | --- | --- | --- |
| 1 | Ticker tape under the top bar | ≈ 30 px | Epoch · Fee Index · median APY · open markets, scrolling | Magic UI `marquee` |
| 2 | Breadcrumb, symbol header (logo, name, rank chip, watchers, Watching / Alerts / primary action buttons), price + change line, stats row of 5 | ≈ 200 px | Market header for the featured market: question, pool SOL, players, closes with epoch N; rule pills 18+ · where allowed · cap 5 SOL · settles by Panta (MS42) | shadcn `breadcrumb`, `badge`, `button` |
| 3 | Tabs row (About / Feed / News / Sentiment / Earnings / Fundamentals) | ≈ 44 px | Markets · Your calls · Leaderboard · Rules | shadcn `tabs` |
| 4 | Poll card: header + collapse, question, one bar per outcome with its share, footer with votes and time left, share and comments buttons | main column | YES / NO bars with pool share, players, closes in (MS43–MS44) | shadcn `card`, `progress` |
| 5 | Right column: news list with thumbnails | ≈ 1/3 | Other markets (MS44) and live calls | shadcn `card` |
| 6 | Ticket (Kraken Pro order form): two-way toggle, amount with preset chips, estimate line, one full-width button | in the right column | YES / NO, amount chips 0.1–5 SOL, estimated payout, Preview call (MS47–MS50) | shadcn `toggle-group`, `input`, `button` |
| 7 | Gate (Coinbase): the ticket replaced by a calm blocking state with one button | same slot | I'm 18 or older · calls are allowed where I live (MS45–MS46) | shadcn `checkbox`, `button` |
| 8 | Review (Reown preview): rows of what will be signed, "Review carefully", Cancel / Confirm | dialog | Call review → Confirm in Phantom → done (MS51–MS53) | shadcn `dialog` |
| 9 | Tables below | full width | Your calls · Leaderboard (MS54–MS55) | TanStack table |

## Vault `/vault` · rows VA1–VA37

Screens: **[Mercury Treasury](https://refero.design/pages/26e9c3a5-c493-4ab4-a7f9-216dc95b85c6)** (primary) ·
[Copperx deposit flow 8894](https://refero.design/flows/8894) (amount → review → progress → success) ·
[Reown transaction preview](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6) ·
[Column account tables](https://refero.design/pages/10d78fe2-0d3a-45e8-b086-abc28c644ac0). Mercury's Treasury screen is light; Epoch keeps its dark tokens.

| # | Region (Mercury Treasury) | Geometry (1440) | Epoch content | Library |
| --- | --- | --- | --- | --- |
| 1 | Title + right: "Documents" link + split button "Transfer funds ▾" | ≈ 28 px title | "Vault" · Rules and risks (VA2) · split button Deposit ▾ (Deposit · Withdraw) opens the deposit sheet | shadcn `button` + `dropdown-menu` |
| 2 | Two cards. Balance card: label with info icon, big amount with small decimals, a second label/value, a link with › | ≈ 1/2 width | In the vault 1,633.00 SOL · Lent out now 189.52 SOL · How a validator borrows › (VA1, VA3) | shadcn `card`, `tooltip` |
| 3 | Allocation card: ring + two legend lines with ticker pills + edit icon; below two figures (Net yield in green, All-time earnings) | ≈ 1/2 width | Senior 69% / Junior 31% with share prices; Senior target ≈10.9% · Paid to lenders (VA5, VA7) | Recharts `pie` via shadcn `chart` or Magic UI `animated-circular-progress-bar` |
| 4 | Underline tabs: Activity / Portfolio | ≈ 44 px | Tranches · Protection · Loan book · Withdrawal queue · Lenders · Parameters (VA29) | shadcn `tabs` |
| 5 | Portfolio rows: ring %, fund name, description, "Fund data as of … Prospectus ↗", right column of key/values (Ticker, Net yield, Shares, Fund type, Risk rating) | full width, ≈ 160 px per row | One row per tranche: Senior (paid first, target, withdraw any epoch) and Junior (first loss, 10-epoch lock); key/values: share price, target or since-launch yield, your shares, lock, loss order; Deposit in Senior / Junior (VA6) | shadcn `card`, `separator` |
| 6 | Footnote box | ≈ 1/3 width, right | "*Targets are not promises. Vault SOL is not staked; unlent SOL earns nothing." (VA24) | shadcn `alert` |
| 7 | Deposit sheet (Copperx): amount on top with a live "you get" estimate, one toggle, one button → review (Reown rows) → vertical progress list → success with amount and See details | right sheet ≈ 440 px | Tranche toggle, amount + chips, risk checkbox, review, progress (signed → confirmed → shares minted), success (VA8–VA18); Withdraw tab (VA19–VA23) | shadcn `sheet`, `input`, `toggle-group`; ReUI `stepper`; `canvas-confetti` on the first deposit only |
| 8 | Tables (Column): KPI row over a filterable table with status badges | full width | Loan book, Withdrawal queue, Lenders, Parameters (VA30–VA37) | TanStack table via ReUI `data-grid` |
| 9 | Protection tab | full width | Loss order Bond → Junior → Senior and the stress test (VA27–VA28) | visx or Recharts stacked bar, shadcn `button` |

## After each page

Run `node scripts/ui/ref-compare.mjs <route> <page> --ref design/screens/<page>/ref-primary-<id8>.png` at 1440
and 1280, fix what the edge overlay shows, then the design-cop loop. Record every deliberate difference from
the reference (content that did not fit, an addition) in `design/screens/<page>.replica.md`.
