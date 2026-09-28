# UI sources for the Epoch terminal

Where the screens, components and code for the ten Epoch pages come from, so
nothing is designed from scratch. Verified 28 Sep 2026 across ~600 fetches
(six research sweeps) plus first-hand checks in the browser and through the
MCP servers connected to this workspace.

Legend: **VERIFIED** = read on the vendor's own page or checked in the
browser/MCP this session · **REPORTED** = third-party page · **UNVERIFIED** =
could not be confirmed. Prices in ₹ are the regional prices shown to an Indian
account on 28 Sep 2026; $ prices are list prices.

Stack this is written for: Next.js 16 (App Router), React 19, Tailwind v4,
shadcn/ui (CLI v4; Base UI default since July 2026, Radix via `-b radix`),
Claude Code writing the code. The repo is public, so only MIT / Apache-2.0 /
BSD / ISC / CC-BY sources may be copied into it.

---

## 1. The five sources to use (ranked)

| # | Source | What Epoch gets | Integration with Claude | Cost (verified) |
| --- | --- | --- | --- | --- |
| 1 | **Mobbin** — <https://mobbin.com> · MCP docs <https://docs.mobbin.com/mcp/introduction> | 621,500+ shipped screens. The only library with verified **web** screens of Binance (dashboard, symbol list), Kraken, Coinbase (flows) and Uniswap (analytics dashboard, token table, price chart, wallet selection, swap flow), plus Robinhood, Phantom, Cash App, Wealthfront and Revolut Web flows — all in the standard library, not Finance+. | Remote MCP `https://api.mobbin.com/mcp` (OAuth; Pro+). Tools `search_screens`, `search_flows`, `search_sections`; each hit carries a low-res inline preview for the model and a hi-res `image_url` (expires after 30 days). 60 requests/60 s. | Pro **₹1,200/mo billed quarterly (₹3,600)** or **₹800/mo billed yearly (₹9,600)**; Team ₹1,920 / ₹1,280 per member. **No monthly billing.** Finance+ is **$399/mo billed $4,788/yr, Team & Enterprise only** (71 exclusive apps: Bybit, Kalshi, Polymarket, eToro, Webull, IBKR, Trading 212, Uphold…) — not needed. |
| 2 | **Refero** — <https://refero.design> · MCP docs <https://doc.refero.design/mcp/getting-started> | Web-first library (web + iOS) with **Styles**: per-brand hex palettes, type scales, spacing, radii, do/don't notes that a coding agent can apply directly. Verified entries: Kraken, Coinbase, Phantom style, Public style, Linear style. | Remote MCP `https://api.refero.design/mcp` (OAuth or Bearer; Pro+). 10 tools incl. `refero_get_style`, `refero_search_screens`, `refero_get_screen_image`, `refero_search_flows`; **8,000 calls/month**. Claude Code skill: `npx skills add https://github.com/referodesign/refero_skill --skill refero-design`. | Pro **₹333/mo billed ₹999 per quarter**, ₹250/mo billed ₹3,000 yearly, or **₹8,999 lifetime**; Team ₹367/seat quarterly. |
| 3 | **Nicelydone** — <https://nicelydone.club> | **207,358 web-only screens** from 500+ SaaS products, 26,177 flows, 15,814 components — the Linear (518 product screens), Mercury, Ramp, Stripe, Coinbase density Epoch's Console, Vault and settings pages need (tables, filters, statements, transfers). | MCP with 12 tools included on every paid plan (endpoint shown after sign-in; Team gets 2× the call quota). | Solo **₹1,500/mo billed quarterly (₹4,500)** or ₹916.67/mo yearly (₹11,000) — regional pricing; list is $39/seat/mo. Quarterly minimum. |
| 4 | **shadcn registry ecosystem (one MCP, all MIT)** — <https://ui.shadcn.com/docs/mcp> + <https://dashboardcn.com> + <https://www.kibo-ui.com> + <https://reui.io> + <https://data-table.openstatus.dev> + <https://blocks.tremor.so> + <https://magicui.design> | The components that make the pages: shadcn `dashboard-01` / `sidebar-07` / `sidebar-16` / `chart-*` blocks; dashboardcn KPI Card, Trend Chart, Data Table, Radial Gauge, Activity Heatmap, Bar List, Allocation/Distribution cards; Kibo **Ticker** (finance ticker with coloured change %), Table, Status, Relative Time, Marquee; ReUI 1,149 free components (+ Pro app shells, stats, steppers, data grid); openstatus data-table (faceted filters, infinite scroll, URL state); Tremor Blocks 300+ (29 KPI cards, spark charts, status monitoring, filterbar, page shells); Magic UI number-ticker / marquee / animated-list. | `npx shadcn@latest mcp init --client claude` — the public registry index (471 registries) resolves `@dashboardcn/…`, `@kibo-ui/…`, `@reui/…`, `@data-table-filters/…`, `@magicui/…` automatically on `npx shadcn add`. ReUI also runs its own MCP at `https://mcp.reui.io` (free, 100 req/day). Magic UI's MCP is already connected to this workspace and answered a test query this session. | Free / MIT (ReUI Pro $249 one-time and Shadcnblocks $149–299 are optional; Shadcnblocks' licence forbids publishing its components in a public repo). |
| 5 | **Permissively licensed Solana/DeFi frontends to lift code from** — <https://github.com/solana-foundation/explorer> (MIT) · <https://github.com/mrgnlabs/mrgn-ts> (Apache-2.0 / mrgn-ui MIT) · <https://github.com/MeteoraAg/meteora-invent> (ISC, `scaffolds/fun-launch`) · <https://github.com/Yaugourt/liquidterminal_front> (MIT) · <https://github.com/mihailgaberov/orderbook> (MIT) | Explorer: epoch progress + cluster stats provider, `EpochOverviewCard`, `VoteAccountSection` (commission, block-revenue commission and collectors — exactly Epoch's fields), stake history, dark-only OKLCH tokens, on **Next 16.3 / React 19.2**. marginfi: TanStack markets table with filters, deposit/withdraw **action box**, wallet sheet. Meteora fun-launch: the DBC launchpad explore grid + token page (chart, swap terminal, stats, tx/holders) for the Launch tab. Liquid Terminal: Hyperliquid-style markets table + order book on Next 16 / React 19 / shadcn / lightweight-charts. orderbook: depth-bar ladder for the Fee Market quotes. | `git clone`, copy the files listed in §4, re-token Tailwind 3 → 4 where needed. | Free. |

Cheapest complete kit for the week: Mobbin Pro (₹3,600) + Refero Pro (₹999) + Figma Professional Dev seat ($12, see §6) ≈ ₹5,600, with everything in row 4 and 5 free. Add Nicelydone (₹4,500) if the Console/Vault pages need more SaaS-density references, and Gummble Browse ($9.99/mo, MCP included) for mobile crypto onboarding/KYC/deposit flows.

Do this before **5 Oct 2026**: Mobbin's Deep Search is unmetered until then; afterwards Pro gets 300 credits/month = 60 Deep Searches (5 credits each, on the site or through MCP; Standard Search stays free).

---

## 2. Everything evaluated

### 2a. Screen and flow galleries (Mobbin-type)

| Source | Holds | Fintech/crypto coverage verified | Claude integration | Price | Fit | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Mobbin <https://mobbin.com> | 621,500+ screens, 142k flows, iOS/Android/web | Coinbase (iOS/Android/Web), Robinhood iOS, Kraken (iOS/Android/Web), Binance (iOS/Web/Android), Uniswap Web, Phantom iOS, Cash App, Wealthfront, Revolut Web; category `crypto-web-3` | MCP (Pro+), REST API (Team+), Figma plugin | ₹3,600/qtr Pro (VERIFIED in browser) | 4/5 | **Buy** |
| Refero <https://refero.design> | 135–150k screens, web + iOS, Styles | Kraken, Coinbase, Phantom/Public/Linear styles | MCP (Pro+, 8k calls/mo), Figma plugin, skill | ₹999/qtr Pro (VERIFIED) | 4/5 | **Buy** |
| Nicelydone <https://nicelydone.club> | 207,358 web screens, 26k flows, 15.8k components | Linear 518, Ramp 114, Mercury, Coinbase, Stripe; no trading terminals | MCP (12 tools, paid plans) | ₹4,500/qtr Solo (VERIFIED) | 4/5 | Buy if budget allows |
| Gummble <https://gummble.com> | 300k screens, 21k flows, 1,500 apps | Coinbase Web 1,335 screens / 55 flows; Binance iOS 1,811; Kraken iOS 451; Phantom iOS 129; Crypto.com iOS 909 | MCP on all paid plans (`https://mcp.gummble.com/mcp`, 14 tools) | Browse $9.99/mo, Pro $14.99/mo, 7-day refund (VERIFIED) | 3/5 | Cheap mobile-flow supplement |
| A1 Gallery <https://www.a1.gallery> | 1,000+ marketing sites, "Web3 & crypto" 37, default dark | Landing pages only | Free MCP (`https://www.a1.gallery/api/mcp`, 50 calls/day; Pro $7/mo 2,000/day), `analyze_design_tokens` | Free | 3/5 | Use for the landing page |
| dark.design <https://www.dark.design> | 400+ dark sites incl. app UIs (Linear, Retool, Height), Web3 category | Web3 landing pages | Browse only | $5/mo or $199 once (VERIFIED) | 3/5 | Optional |
| Page Flows <https://pageflows.com> | Recorded flow videos, 79k+ screens (Screenlane merged into it 2024) | Revolut / Robinhood desktop flows | None | $39/quarter (VERIFIED) | 2/5 | Skip |
| SaaSFrame <https://www.saasframe.io> | 5,000+ examples, 176 dashboard examples | Mercury, Stripe, Linear | Browse only | $14/mo (VERIFIED) | 3/5 | Optional |
| SaaS Interface <https://saasinterface.com> | 26 page types incl. Dashboard, Lists & Tables, Activity Feed | Generic SaaS | Browse only | Paid, price UNVERIFIED | 3/5 | Optional |
| SaaSUI <https://saasui.design> | 142 products, 3,500 screenshots | Generic | Browse only | Free | 2/5 | Free browse |
| Lapa Ninja <https://www.lapa.ninja> | 7,300+ landing pages; tags Web3 368, Cryptocurrency 138, Solana 4 | Landing pages | Browse only | Free | 2/5 | Landing refs |
| Land-book, Saaspo (dark-mode filter 91), Landingfolio (Crypto/Fintech), Curated.design ($9/mo), Minimal.gallery, recent.design (ex-Godly), Dark Mode Design, Navbar Gallery, Footer.design, Bento Grids, Design Spells, Component Gallery | Marketing pages / micro-patterns | Landing only | Browse only | Free–$9 | 1–2/5 | Landing-page mood only |
| cryptodesign.club <https://cryptodesign.club> | ~50 web3 products (Aave, Phantom, Lido…); Exchange category has 2 entries; last dated 2025 | Sparse | Browse only | Free | 2/5 | Skip |
| ScreensDesign (absorbed UI Sources, Design Vault, Scrnshts) | 2,715 iOS apps, MCP `https://api.screensdesign.com/v1/mcp` | iOS only | MCP (Pro $39/mo REPORTED) | — | 1/5 | Skip (mobile) |
| UX Archive, Pttrns, Handheld, Appshots, Lazyweb, Collect UI, Dribbble/Behance | Mobile or concept work | — | — | — | 1/5 | Skip |
| UI Garage, Interfaces.pro, web3.design, wgmi.design, dapp.design | **Dead / shut down** | — | — | — | — | — |

Not in any gallery's public index: **Hyperliquid, Jupiter, Drift, dYdX, Robinhood Legend (web), MetaMask, Bybit (Finance+ only), Public**. Capture those yourself (§6, html.to.design) — Hyperliquid's app is public without a wallet.

### 2b. Component and block registries with agent integration

| Registry | Finance-relevant items | Install / MCP | Primitives · TW4 · React 19 | Price · licence | Fit |
| --- | --- | --- | --- | --- | --- |
| shadcn/ui <https://ui.shadcn.com/blocks> | `dashboard-01` (sidebar + charts + data table), `sidebar-01…16` (07 icon-collapse, 08 inset, 15 dual, 16 sticky header), `login-01…05`, `chart-{area,bar,line,pie,radar,radial,tooltip}-*` on Recharts; Data Table guide (TanStack v9) | `npx shadcn@latest mcp init --client claude`; `npx skills add shadcn/ui`; registry index `https://ui.shadcn.com/r/registries.json` (471 registries auto-resolve) | Base UI default / Radix · yes · yes | Free MIT | 4/5 |
| dashboardcn <https://dashboardcn.com> | KPI Card, Trend Chart, Data Table, Funnel, Bar Chart, Radial Gauge, Activity Heatmap, Bar List, Composed Chart; 25 blocks (Allocation, Breakdown, Distribution, Period Bar Chart, Insight cards) | `npx shadcn@latest add @dashboardcn/<name>`; agent docs at `/docs/components/<name>.md` | Radix or Base UI · yes · yes | Free MIT, no licence key | 4/5 |
| Kibo UI <https://www.kibo-ui.com> | **Ticker** (symbol/price/change, ISO-4217), Table (TanStack), Status, Marquee, Relative Time, Pill, Contribution Graph, Gantt, Kanban, Dialog Stack | `npx kibo-ui add ticker` or `npx shadcn add @kibo-ui/ticker`; docs MCP via `mcp-remote https://www.kibo-ui.com/api/mcp/mcp` | Radix · CSS-variables build only · React 18+ | Free MIT | 4/5 |
| ReUI <https://reui.io> | 1,149 free components; Pro: App Shell 31, Navbar 13, Chart 30, Stats 15, Stepper 15, Data Grid, command menu, 16 templates | `npx shadcn@latest add @reui/<name>`; own MCP `https://mcp.reui.io` (`search`, `get_block`, `compose_page`, `get_install_command`; free 100 req/day) | Radix + Base UI · yes · yes | Free MIT; Pro $249 / Ultimate $499 one-time | 4/5 |
| openstatus data-table <https://data-table.openstatus.dev> | Faceted filters (checkbox, input, slider, time range), sorting, infinite scroll, bulk actions, server-side filtering, `nuqs` URL state | `npx shadcn search @data-table-filters` → `npx shadcn add @data-table-filters/<item>` | shadcn · yes · yes | Free (licence text UNVERIFIED) | 5/5 for logs/explorers |
| Tremor Blocks <https://blocks.tremor.so> | 300+ blocks: KPI Cards 29, Chart Tooltips 21, Chart Compositions 15, Spark Charts, Status Monitoring, Tables, Page Shells, Filterbar, Billing & Usage | Copy-paste (Tremor Raw); no registry | Radix; own Tailwind tokens → map to shadcn CSS vars; blocks' TW4 status UNVERIFIED | Free MIT (blocks) / Apache-2.0 (components) | 4/5 |
| Magic UI <https://magicui.design> | number-ticker, marquee, animated-list, shine-border, bento grid | `npx shadcn add @magicui/number-ticker`; MCP `npx @magicuidesign/cli@latest install claude` (**connected here; tested OK**) | Motion-based · TW4 not stated | Free MIT; Pro $199 lifetime (landing only) | 2/5 (cherry-pick) |
| number-flow <https://number-flow.barvian.me> | Animated numbers with `Intl.NumberFormat` currency, `trend`, continuous plugin, `NumberFlowGroup` | `npm i @number-flow/react` | Framework-agnostic · React 18/19 | MIT | 5/5 for KPI tiles |
| blocks.so <https://blocks.so> | Stats 15, Tables 5, Command Menu 4, Sidebar 6, Dashboard 1, Dialogs 12 | shadcn registry `@blocks-so` | shadcn | Free (licence UNVERIFIED) | 3/5 |
| Shadcnblocks <https://www.shadcnblocks.com> | Dashboard 18 (13 = real-time sessions & latency), Data Table 32 (24 transactions, 25 invoices, 27 virtualized, 32 multi-sort), Chart Group 15, Sidebar 21; Admin Kit 139 pages (payments app 36 pages, developer console) on Next 16 / React 19 / TW4 | `@shadcnblocks` registry with `SHADCNBLOCKS_API_KEY`; `{style}` serves Base UI / Aria | Radix (+ Base UI via `{style}`) · yes · yes | Pro $149 / Premium $299 / Elite $399 one-time; **licence prohibits publishing components in a public repository** | 4/5 but blocked by licence |
| Shadcn UI Kit <https://shadcnuikit.com/dashboard/crypto> | 16 dashboards incl. Crypto (wallets, buy/sell, activity), Finance, Payment; Next 16 / React 19 / TW4 | Copy screens | shadcn | Pro $79 sale / $129, Team $199 one-time; public-repo terms not addressed | 4/5 | Optional |
| shadcn Studio <https://shadcnstudio.com> | 1,000+ blocks, 9+ dashboard templates | CLI / copy; MCP setup UNVERIFIED | Base UI + Radix | $99 / $199 one-time | 3/5 |
| shadcnspace <https://www.shadcnspace.com> | 457 blocks incl. charts, widgets, sidebars, TanStack tables | CLI; "live MCP" UNVERIFIED | Radix + Base UI | **Starter Monthly $49** (only monthly plan among block kits); Pro $149 lifetime | 3/5 |
| Untitled UI React <https://www.untitledui.com/react> | 5,000+ components, Dashboards 01/02 (40 pages), Metrics 16, Tables 12, Progress steps 18 | Own CLI `npx untitledui@latest`; MCP `https://www.untitledui.com/react/api/mcp` | **React Aria** (parallel system to shadcn) · TW 4.3 · React 19 | Free MIT tier; PRO SOLO $349 | 3/5 (two systems) |
| 21st.dev <https://21st.dev/mcp> | 10,000+ community components; no finance set | `npx @21st-dev/cli@latest init --client claude` (API key) | Mixed | Search free, 2 installs/day; Builder $6/mo billed yearly | 2/5 |
| Tailwind Plus <https://tailwindcss.com/plus> | Application shells, stats, tables, command palettes, Catalyst kit | Copy-paste; no CLI/MCP | Headless UI, not shadcn | One-time (REPORTED $299); licence allows open-source end products but not component repos | 3/5 |
| coss ui (ex-Origin) <https://coss.com/ui> | 50+ Base UI-native inputs (Number Field, Slider, Table) | `@coss` registry | Base UI native | Free MIT (`apps/ui`) | 3/5 |
| Aceternity, Tailark, Cult UI, Animate UI, SmoothUI, Skiper, Eldora, Syntax, Fancy, Cuicui, Neobrutalism, Basecn, HextaUI (retired), shadcn-extension (down) | Marketing/motion effects | — | — | Free–$199 | 1–2/5 | Skip for a terminal |
| Solana kits: wallet-ui <https://github.com/wallet-ui/wallet-ui> (MIT; Wallet Standard + MWA; `@wallet-ui/react`, `@wallet-ui/tailwind`), Jupiter Unified Wallet Kit <https://github.com/TeamRaccoons/Unified-Wallet-Kit> (MIT in package.json; Light/Dark/Jupiter themes), solanauth <https://github.com/aymanch-03/solanauth> (shadcn wallet modal, legacy web3.js), create-solana-dapp templates (MIT; Next.js + Tailwind + `@solana/kit`, no shadcn) | Wallet connect | npm | None ships as a shadcn registry item | Free | — | Build the wallet dialog on shadcn `Dialog` + `@wallet-ui/react` hooks, cribbing solanauth's layout |

No registry ships an order book, candlestick wrapper, token-amount input or swap widget — those come from the repos in §2d.

### 2c. Templates and starters

| Template | Stack (verified from package.json) | Pages useful to Epoch | Licence | Price | Fit | Use |
| --- | --- | --- | --- | --- | --- | --- |
| **arhamkhnz/next-shadcn-admin-dashboard** <https://github.com/arhamkhnz/next-shadcn-admin-dashboard> | next 16.2, react 19.2, tailwind 4.1, Radix shadcn, TanStack Table 8.21, Recharts 3.8, zustand 5 | Finance + Infrastructure dashboards, users table, invoice, auth, collapsible sidebar, theme presets | MIT | Free | 4/5 | **Best skeleton** for Terminal / Console / Vault |
| Kiranism/next-shadcn-dashboard-starter <https://github.com/Kiranism/next-shadcn-dashboard-starter> | next 16.2, react 19.2, tailwind 4.2, **Base UI** shadcn, Clerk, TanStack Table, Recharts 3.8 | Data tables with search/filter/pagination, notification centre, kanban | MIT | Free | 4/5 | Alternative if going Base UI; strip Clerk |
| abderrahimghazali/shadcn-fintech <https://github.com/abderrahimghazali/shadcn-fintech> | Next 16, TW4, shadcn (Radix), Recharts, Motion | 11 fintech pages: Dashboard, Accounts, Transactions, Transfers, Crypto, Investments, Analytics, Budgets, Settings; live ticker; dark/light | MIT | Free | 4/5 | Lender portfolio, transactions |
| feremabraz/bloomberg-terminal <https://github.com/feremabraz/bloomberg-terminal> | Next 15, React 19, shadcn, TW 3.4, Jotai, Recharts 2.15 | Terminal chrome: keyboard shortcuts, watchlist split, movers, dense KPI strip | MIT | Free | 4/5 | Terminal shell ideas (re-token TW3→4) |
| Superior-Trade/trading-terminal <https://github.com/Superior-Trade/trading-terminal> | next 16.2, react 19.2, tailwind 4, lightweight-charts 5.2.1 | Hyperliquid + Lighter datafeeds, chart panels, liquidation heatmap | Apache-2.0 | Free | 4–5/5 | Fee Market chart panel + WebSocket feed |
| mihailgaberov/orderbook <https://github.com/mihailgaberov/orderbook> | React/TS, styled-components, react-use-websocket (Kraken feed) | Depth-bar ladder, grouping selector | MIT | Free | 4/5 | Fee Market quote ladder (port to Tailwind) |
| Tremor templates (dashboard-oss, dashboard, insights, solar, planner) <https://github.com/tremorlabs> | Next 14–15, React 18–19, TW 3.4 (solar/planner TW4 beta) | Overview/details/settings pages, KPI + chart compositions | MIT / Apache-2.0 | Free | 3/5 | Copy blocks, not the app |
| Cruip Open PRO <https://cruip.com/open-pro/> | Next 16, TW4 | Dark SaaS marketing site, 12 pages | Commercial | $49 | 4/5 (landing only) | Optional landing |
| Criptic (ThemeForest) <https://themeforest.net/item/criptic-react-next-web3-nft-crypto-dashboard/38316242> | Next 15, Tailwind | Swap/liquidity/trading-bot/coin-detail pages | Regular licence forbids redistributing source (public repo conflict) | $17 | 3–4/5 | Reference only |
| TailAdmin, Horizon UI, Mosaic (GPL), Tabler (Bootstrap), Refine, Materio/Vuexy/Berry/Mantis (MUI), Taxonomy (archived), Precedent, supastarter $299, ShipFast $199, Makerkit $349 | Various | Generic admin / SaaS shells | Mixed | — | 1–3/5 | Skip |
| ThemeForest crypto dashboards (DefibotX $49, Crypo $99 Bootstrap, CryptoZone $29, Zenix $19 HTML), ui8 kits (Cryptex, Coinstax, Crypto Whale, Chainex, BitCloud — prices not fetchable) | None on Next 16 + TW4 + shadcn | Portfolio-tracker looks | Single end-product licences | — | 2–3/5 | Skip |

### 2d. Open-source DeFi / trading / staking frontends — licence matrix

| Repo | Licence | Stack | Screens for Epoch | Copy into public repo? |
| --- | --- | --- | --- | --- |
| solana-foundation/explorer <https://github.com/solana-foundation/explorer> | MIT (LICENSE fetched) | Next 16.3, React 19.2, TW 3.4, Radix, cva, chart.js, swr, @solana/kit | Epoch overview + progress, cluster stats, vote account (commission, block-revenue commission, collectors, pending delegator rewards), stake account + history, staking totals, cards, tables, `Copyable`, `SolBalance`, `TimestampToggle` | **Yes — #1 lift** |
| mrgnlabs/mrgn-ts <https://github.com/mrgnlabs/mrgn-ts> | Apache-2.0; `packages/mrgn-ui` MIT | Next 14, React 18, TW 3.2, Radix, TanStack Table 8, Recharts, zustand, react-query | `AssetList.tsx` markets table with filters; `action-box-v2` deposit/withdraw/borrow with preview; `wallet-v2` sheet | Yes (deprecated but licensed) |
| MeteoraAg/meteora-invent `scaffolds/fun-launch` <https://github.com/MeteoraAg/meteora-invent> | ISC (package.json; no LICENSE file) | Next 15.5, React 19.2, TW 3.4, radix-ui, sonner 2, DBC SDK 1.5 | Launchpad Explore grid, token page (TokenHeader/TokenStats/TokenChart/Terminal swap/TokenBottomPanel tx + holders), create pool | Yes (confirm with Meteora if cautious) |
| Yaugourt/liquidterminal_front <https://github.com/Yaugourt/liquidterminal_front> | MIT | Next 16.2, React 19.2, TW 3.4, shadcn, lightweight-charts 5, Recharts 3.8, zustand 5, sonner 2 | Spot/perp markets table, order books, explorer tables, portfolio dashboard, 4-tier services pattern | Yes |
| Squads-Protocol/public-v4-client <https://github.com/Squads-Protocol/public-v4-client> | MIT | React 19, TW 3.3, Radix, sonner | Transaction list, member cards, sonner tx lifecycle, verifiable build scripts | Yes |
| TeamRaccoons/Unified-Wallet-Kit <https://github.com/TeamRaccoons/Unified-Wallet-Kit> | MIT (package.json only) | React 18, TW 3.2 | Wallet connect modal (Light/Dark/Jupiter) | Yes, or use as dependency |
| jup-ag/plugin <https://github.com/jup-ag/plugin> | MIT (package.json only) | Next 13, TW 3.3 | Swap form + pair selector | Yes, or embed |
| Kiranism starter, arhamkhnz dashboard | MIT | Next 16 / TW4 | Data tables, shells | Yes |
| balancer/frontend-monorepo <https://github.com/balancer/frontend-monorepo> | MIT | Next 16.3, React 19.3, Chakra, echarts | Pool page + TVL/APR charts (restyle) | Yes (restyle) |
| curvefi/curve-frontend (MIT, MUI), raydium-ui-v3-public (Apache-2.0, Chakra), solend-lite (MIT, Chakra), sushiswap `packages/ui` (MIT), Mythic-Project/governance-ui (Apache-2.0), solana-foundation/templates (MIT) | Permissive | Off-stack styling | Tables, proposal cards, kit wiring | Yes (restyle) |
| **Avoid:** blockworks-foundation/mango-v4-ui (AGPL-3.0), dydxprotocol/v4-web (AGPL-3.0), gmx-io/gmx-interface (BUSL-1.1 → GPL-2.0+), Uniswap/interface `apps/web` (GPL-3.0), lidofinance/ethereum-staking-widget (GPL-3.0), raydium-frontend (GPL-3.0, archived), OpenBB (AGPL-3.0), Plane (AGPL-3.0), Mosaic (GPL), aave/interface (**All Rights Reserved**), Neuberg (BSL non-commercial), TradingView `charting_library` (proprietary) | Copyleft / proprietary | — | mango's `Orderbook.tsx`, dYdX and Neuberg are **visual references only** | **No** |
| **Unlicensed = all rights reserved:** drift-labs/vaults-ui-template, velocity-exchange/drift-ui-template (Next 15.4 / React 19 / TW4 / lightweight-charts — closest stack twin, but no LICENSE), SOL-Strategies/stakewiz-frontend, openbook-v2-ui, marinade psr-dashboard | None | — | Reference only | **No** |

There is no production-grade open-source Solana validator dashboard in React (validators.app is Ruby; Stakewiz's frontend has no licence; StakeNet has no web UI). Epoch's validator explorer is built from explorer's `useVoteAccounts` data pattern + marginfi's `AssetList` table.

### 2e. Figma kits and design-to-code

The official **Figma MCP server is already connected to this workspace** (`get_design_context`, `get_metadata`, `get_screenshot`, `get_variable_defs`, `create_design_system_rules`), so any kit duplicated into your Figma becomes readable by Claude.

| Kit | Contents | Dark · variables | Price · licence | Fit |
| --- | --- | --- | --- | --- |
| Obra shadcn/ui Community Edition <https://www.figma.com/community/file/1514746685758799870/> (listed on <https://ui.shadcn.com/docs/figma>) | Every shadcn component in 8 styles, <300 variables, 1,800 Lucide icons, 50,000+ duplicates | Yes · yes | Free (CC BY 4.0) | 4/5 — the system |
| Prime Trade — Crypto Trading Dashboard UI Kit <https://ldesignstudio.gumroad.com/l/primetrade> | 90+ screens: spot terminal, order book + candles, markets, buy/sell panels, portfolio analytics, wallet/deposit/withdraw, **staking dashboards**, KYC/settings | Light + dark · **Figma variables** | $35, no redistribution | 5/5 — closest to Epoch's pages |
| FrontDEX 4.0.0-alpha.3 (Openware) <https://www.figma.com/community/file/1081520624421222872> | 40+ exchange screens, 100+ elements: order books, order forms, candles, tickers, deposit/withdraw, KYC | Dark (REPORTED) · no variables (2022) | Free, CC BY 4.0 (REPORTED) | 4/5 for layout |
| Free Crypto Dashboard UI Kit — Dark Mode & Auto-Layout (Web3 Ready) <https://www.figma.com/community/file/1553868859015156218> | Title only — contents UNVERIFIED | — | Free | 3/5 provisional |
| shadcn/ui Kit for Figma (Wierzbicki) <https://www.shadcndesign.com/pricing> | 340+ Pro Blocks (Plus), variables → CSS variables export, Next.js templates (Premium) | Yes · yes | $119 / $299 / $599 one-time | 5/5 as system |
| Untitled UI PRO Figma $129 (10,000+ components, 420+ pages, variables) · Frames X $129 (130+ chart/dashboard templates) · Setproduct Orion $148 (40+ chart templates) · Craftwork Snow $59 (dark dashboard) | Dashboards & charts | Yes | Paid | 4/5 for charts |
| Title-only candidates to open: Foxstocks Finance Dashboard (1369359008216990725), Trading Orderbook UI Kit (1325073010083791404), Cryptoin Exchange Dashboard (1357420317197997316), Dark Finance & Crypto Dashboard (1522238618706669989), Crypto Trading Platform (1584862901011316556) | UNVERIFIED | — | Free | — |

Figma MCP facts (VERIFIED on developers.figma.com / help.figma.com): remote server `https://mcp.figma.com/mcp` works on all plans; read-tool limits are **Starter 20 calls/month**, Professional Dev/Full seat **200/day + 10/min** (Dev seat $12/mo, Full $16/mo), Organization 200/day, Enterprise 600/day. Limits follow the plan of the team that owns the file — a Community duplicate in Drafts gets Starter caps, so **move it into a project in a paid team** and check `whoami` reports `tier: pro`. Code Connect is Organization/Enterprise only; use `create_design_system_rules` + a rules file instead. Ten pages ≈ 60–100 calls → one Professional Dev-seat day.

Design-to-code tools: **html.to.design** <https://html.to.design/> (live site → editable Figma layers; free 10 imports/30 days; PRO $12/mo annual or $18 monthly) is the capture path for Hyperliquid / Kraken Pro / Jupiter / Kamino pages; **v0** <https://v0.app/pricing> (Plus $30/mo; imports the GitHub repo and opens PRs; Figma-link import on paid plans) for one or two days of layout drafting; **Subframe** <https://www.subframe.com/> (free 1 project; reads your components/tokens, uses your own Claude subscription); Builder.io Visual Copilot (free 60 credits); Magic Patterns ($20 Starter; generic React export); Google Stitch (free, REPORTED); Onlook (Apache-2.0). Lovable / Bolt generate whole new apps — wrong fit for an existing Next.js 16 repo.

### 2f. Data-heavy building blocks (versions from the npm registry)

| Need | Pick | Licence | Notes |
| --- | --- | --- | --- |
| Live Fee Index series, streaming bars | **lightweight-charts 5.2.1** + `lightweight-charts-react-components 2.6.0` | Apache-2.0 **+ attribution** (NOTICE + link to tradingview.com) / MIT | Canvas; `series.update()`; panes for histogram; Skills file for AI assistants in the repo |
| Revenue history bars, KPI sparklines, 16-epoch index history | shadcn Chart (**Recharts 3.10**) | MIT | Shares shadcn CSS tokens |
| Tranche waterfall | **visx 4.0** | MIT | Low-level D3 + React |
| 5,000-row validator table | **TanStack Table** (v8.21 to match starters, or v9.2 to match the shadcn guide — pick one) + **TanStack Virtual 3.14** | MIT | Fallback with batteries: AG Grid Community 36.1 (MIT) |
| KPI tiles, epoch countdown, preview box | **@number-flow/react 0.6.2** | MIT | Currency format, `trend`, reduced-motion aware |
| Very high-frequency sparklines | uPlot 1.6.32 | MIT | ~50 KB canvas |
| Avoid | Glide Data Grid (peer deps stop at React 18), react-financial-charts (React ≤18), MUI X (MUI + paywall), TradingView Advanced Charts (needs approval; can't live in a public repo), finos/perspective (too heavy for 7 days) | | |

---

## 3. What the community evidence says (design rules)

- Praised terminals share one grammar: chart or table top-left, action panel fixed on the right, positions/history below, no banners (Hyperliquid, Axiom, Kraken Pro, Robinhood Legend). Copy it on every transactional page.
- Tables, not cards, for validators / vaults / tranches; one-click actions per row (Axiom "Quick Buy", Legend one-click orders).
- Real terminals do not use pure black + acid green: Hyperliquid is deep green-black (`#04060C` / `#051814`) with a mint accent (`#97FCE4` / `#8CF5D2`); Polymarket is `#15191D` surfaces, `#242B32` borders, blue action, red/green reserved for outcomes. Anthropic's own frontend-design skill flags "near-black + single acid-green accent" as the generic AI look. Use Radix `teal-dark` 1–3 for surfaces, `gray-dark` 6–8 borders, 11–12 text; keep red/green for P&L only.
- Tabular numerals in a mono face (Geist Mono) for every number column; `font-variant-numeric: tabular-nums`.
- Show the numbers validators judge by: APY not commission, vote/block performance, stake concentration, MEV/Jito split (Blockworks' issuance / Jito / tx-fee decomposition); add a compare view (StakeNet compares 5).
- Presets + a preview "safety net" box + hotkeys on action panels; animated numbers on the preview.
- Never show placeholder data; explicit devnet/mainnet badge; tx-status toasts; handle priority fees (Superteam's Colosseum guide lists missing priority fees as a demo killer).
- Colosseum judges "Product + Execution: how well does the product work?" and asks for a ≤3-minute product-demo video; make every page legible at 1280 px screen-recording scale — one headline metric, one primary action, staged disclosure for advanced parameters.
- The loudest criticism of shadcn on HN is shipping the defaults ("the epitome of all LLM generated websites"); re-theme via CSS variables before building pages.

---

## 4. Page-by-page sourcing map

| Page | Reference screens (via MCP / capture) | Skeleton | Components | Data libs | Code to lift |
| --- | --- | --- | --- | --- | --- |
| 1 Landing | A1 Gallery Web3 (tokens), dark.design Web3, Lapa Ninja Crypto/Web3 tags, Refero Phantom/Linear styles | Cruip Open PRO ($49) or Tremor `template-solar` (MIT) | Magic UI hero bits, shadcn sections | — | — |
| 2 Terminal (public) | Mobbin: Binance Web Dashboard, Uniswap Analytics Dashboard, Kraken Web; Jito StakeNet | shadcn `dashboard-01` + arhamkhnz Finance dashboard | dashboardcn KPI Card / Trend Chart, Kibo Ticker + Marquee (fee tape), Status, number-flow | lightweight-charts (Fee Index), Recharts | explorer `solanaClusterStats.tsx`, `page.tsx` cluster-stats rows, `StakingSection.tsx`; liquidterminal markets table |
| 3 Validator explorer | Nicelydone Linear/Ramp tables, Mobbin Binance Symbol List, Uniswap Token Table | arhamkhnz users table | openstatus data-table (faceted filters, URL state), Kibo Table | TanStack Table + Virtual | mrgn-ts `AssetList.tsx` pattern; explorer `useVoteAccounts` |
| 4 Validator profile | StakeNet validator page; validators.app fields | arhamkhnz detail layout | dashboardcn Radial Gauge (Epoch Score), Bar List, Activity Heatmap (credits) | Recharts revenue bars | explorer `VoteAccountSection.tsx` (commission, block-revenue commission, collectors), `StakeHistoryCard.tsx`, `Copyable`, `SolBalance` |
| 5 Validator Console | Nicelydone Mercury/Ramp settings & statements; Mobbin Coinbase business account flow | ReUI App Shell (free) or Shadcnblocks developer console (private repo only) | shadcn Field/Item/Empty, Tremor Status Monitoring, Kibo Relative Time | number-flow | mrgn-ts `action-box-v2` (advance request) |
| 6 Advance flow (wizard + preview) | Hyperliquid order panel (capture with html.to.design), Mobbin Coinbase/Revolut deposit flows | ReUI Stepper or shadcn Questionnaire | Preview card with number-flow, Sonner promise toast | — | mrgn-ts action box navigator; Squads sonner wiring |
| 7 Vault (senior/junior) | Drift Vaults (visual only), Balancer pool page (MIT), Morpho Vault V2 docs for copy | arhamkhnz Finance dashboard | dashboardcn Allocation / Distribution cards, Tremor KPI cards | visx waterfall, Recharts share price | balancer `frontend-v3` pool charts (restyle); explorer `TableCardBody` for the withdrawal queue |
| 8 Lender portfolio | Mobbin Wealthfront / Robinhood portfolio, Cash App Investing | shadcn-fintech Investments + Transactions pages (MIT) | dashboardcn Trend Chart, Kibo Pill | Recharts area | shadcn-fintech |
| 9 Fee Index | crypto-charts (Pyth) pattern <https://github.com/jstnw10/crypto-charts>; Blockworks validator-revenue decomposition for methodology copy | arhamkhnz Analytics | shadcn Chart tooltips (Tremor Chart Tooltips) | lightweight-charts histogram + line, 16-epoch history in Recharts | explorer `TimestampToggle` |
| 10 Fee Market | Mobbin Binance/Kraken web trading; Hyperliquid capture | Superior-Trade chart-panel composition (Apache-2.0) | Quote ladder from mihailgaberov/orderbook (MIT), swap form from jup-ag/plugin (MIT) | lightweight-charts, TanStack Table (positions) | liquidterminal order book; Squads sonner tx toasts |
| 11 Launch (Meteora DBC) | launch.meteora.ag; hackathon DBC simulators (meteora-dbc-studio, curveforge) | meteora-invent `fun-launch` token page + Explore grid (ISC) | dashboardcn Period Bar Chart Card (buyback feed), Kibo Marquee | Recharts curve progress | `scaffolds/fun-launch/src/components/{Explore,TokenHeader,TokenChart,TokenTable,Terminal}` |

---

## 5. Claude Code setup (project `.mcp.json`)

```json
{
  "mcpServers": {
    "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] },
    "mobbin": { "type": "http", "url": "https://api.mobbin.com/mcp" },
    "refero": {
      "type": "http",
      "url": "https://api.refero.design/mcp",
      "headers": { "Authorization": "Bearer ${REFERO_TOKEN}" }
    },
    "gummble": { "type": "http", "url": "https://mcp.gummble.com/mcp" },
    "reui": { "type": "http", "url": "https://mcp.reui.io" },
    "figma": { "type": "http", "url": "https://mcp.figma.com/mcp" },
    "magicuidesign-mcp": { "command": "npx", "args": ["-y", "@magicuidesign/mcp@latest"] },
    "kibo-ui": { "command": "npx", "args": ["-y", "mcp-remote", "https://www.kibo-ui.com/api/mcp/mcp"] }
  }
}
```

Then in Claude Code: `/mcp` → authenticate mobbin, gummble, reui and figma (OAuth in the browser). `npx skills add shadcn/ui` and `npx skills add https://github.com/referodesign/refero_skill --skill refero-design`.

`components.json` only needs entries for authenticated registries; public ones resolve from the index:

```json
"registries": {
  "@reui": { "url": "https://reui.io/r/{style}/{name}.json", "headers": { "Authorization": "Bearer ${REUI_LICENSE_KEY}" } }
}
```

First installs: `npx shadcn@latest add dashboard-01 sidebar-07 sidebar-16 login-03 chart-area-interactive chart-bar-multiple @dashboardcn/kpi-card @dashboardcn/trend-chart @dashboardcn/radial-gauge @dashboardcn/bar-list @magicui/number-ticker @magicui/marquee` · `npx kibo-ui add ticker table status relative-time pill` · `npx shadcn search @data-table-filters` · `pnpm add lightweight-charts lightweight-charts-react-components @number-flow/react @tanstack/react-table @tanstack/react-virtual`.

Note: the third-party "Shadcn UI" MCP connected to this workspace failed this session with "Unexpected response from GitHub API" (unauthenticated GitHub calls); the official `npx shadcn@latest mcp` does not have that dependency.

---

## 6. Purchases (₹, verified 28 Sep 2026 in the browser)

| Item | Price | Why |
| --- | --- | --- |
| Mobbin Pro, quarterly | ₹3,600 (₹1,200/mo); yearly ₹9,600 | Screens + MCP; no monthly plan exists |
| Refero Pro, quarterly | ₹999 (₹333/mo); yearly ₹3,000; lifetime ₹8,999 | Styles/tokens via MCP, 8,000 calls/mo |
| Figma Professional Dev seat | $12/mo (Full $16) | Raises Figma MCP from 20 calls/month to 200/day |
| Nicelydone Solo, quarterly (optional) | ₹4,500 (₹1,500/mo) | Linear/Mercury/Ramp density; MCP included |
| Gummble Browse (optional) | $9.99/mo, 7-day refund | Coinbase Web 1,335 screens, mobile crypto flows, MCP |
| Prime Trade Figma kit (optional) | $35 | Trading terminal + staking screens with variables |
| html.to.design PRO (optional) | $12/mo annual or $18 monthly; free tier 10 imports/30 days | Capture Hyperliquid / Kraken Pro into Figma |

Skip: Mobbin Finance+ ($4,788/yr, Team-only), Shadcnblocks (licence vs public repo), Untitled UI PRO (second component system), Tailwind Plus (off-stack), ThemeForest/ui8 kits (wrong stack, single-product licences), v0/Lovable/Bolt as primary builders.

---

## 7. Gaps

- Mobbin: whether the MCP exposes a `mode` parameter to force free Standard searches (the REST API does); Finance+ gating of any individual standard-library app was checked only via the Finance+ app list and Google's index, not a paid login.
- Nicelydone MCP endpoint and Solo call quota are shown only after sign-in.
- Gummble MCP responses: image URLs not confirmed.
- Figma Community files could not be fetched, so likes/duplicates/updated dates for the crypto kits are unverified; the free "Crypto Dashboard UI Kit — Dark Mode" contents are unverified.
- Tremor Blocks' Tailwind v4 status; dashboardcn and openstatus item slugs (confirm with `npx shadcn search`).
- Jupiter plugin / Unified Wallet Kit / meteora-invent carry MIT/ISC in package.json but no LICENSE file.
- No open-source React validator dashboard exists; no gallery has Hyperliquid, Jupiter, Drift or Robinhood Legend web screens.

---

## 8. Sources

Galleries: mobbin.com/pricing, mobbin.com/finance, mobbin.com/mcp, docs.mobbin.com (mcp/introduction, mcp/features, ai-credits, rate-limits, api/quickstart), help.mobbin.com articles 691712 / 691968 / 692160, mobbin.com/terms · refero.design/pricing, doc.refero.design (mcp/getting-started, mcp/tools, mcp/data-model, mcp/business, skill/overview, help/plans, help/billing, legal/terms-of-use), styles.refero.design (Phantom) · nicelydone.club (pricing, mcp, apps/linear, apps/mercury, apps/ramp) · gummble.com (pricing, mcp, terms, apps/coinbase-web, apps/binance-ios, apps/kraken-ios, apps/phantom-ios) · a1.gallery (pricing, mcp, category/crypto) · dark.design · pageflows.com/pricing · saasframe.io · saasinterface.com · saasui.design · lapa.ninja · land-book.com · saaspo.com · landingfolio.com · curated.design · minimal.gallery · recent.design · darkmodedesign.com · cryptodesign.club · screensdesign.com/mcp · uigarage.net · toolworthy.ai/blog/mobbin-alternatives · gummble.com/blog/best-mobbin-alternatives-2026.

Registries: ui.shadcn.com (docs/mcp, docs/registry/registry-index, docs/skills, blocks, charts, changelog 2026-07 and 2026-03) · dashboardcn.com · kibo-ui.com (docs/mcp, components/ticker) · reui.io (pricing, docs/mcp) · data-table.openstatus.dev · blocks.tremor.so · vercel.com/blog/vercel-acquires-tremor · magicui.design/docs/mcp · github.com/magicuidesign/mcp · number-flow.barvian.me · shadcnblocks.com (pricing, license, blocks/dashboard, blocks/data-table, blog/shadcn-admin-kit, docs/shadcn-cli/overview) · shadcnuikit.com/pricing · shadcnstudio.com/pricing · shadcnspace.com/pricing · untitledui.com/react (integrations/mcp) · 21st.dev/pricing · tailwindcss.com/plus/license · coss.com/ui · github.com/birobirobiro/awesome-shadcn-ui · github.com/wallet-ui/wallet-ui · github.com/TeamRaccoons/Unified-Wallet-Kit · github.com/aymanch-03/solanauth · github.com/solana-foundation/templates.

Templates and repos: github.com/arhamkhnz/next-shadcn-admin-dashboard · github.com/Kiranism/next-shadcn-dashboard-starter · github.com/abderrahimghazali/shadcn-fintech · github.com/feremabraz/bloomberg-terminal · github.com/Superior-Trade/trading-terminal · github.com/mihailgaberov/orderbook · github.com/tremorlabs (template-dashboard-oss, template-dashboard, template-insights, tremor-blocks) · cruip.com/open-pro · themeforest.net items 38316242, 59030237, 31864895, 42841386, 63718712 and licenses/terms/regular · github.com/solana-foundation/explorer (LICENSE, package.json, tailwind.config.ts, app/page.tsx, app/epoch/[epoch]/page-client.tsx, app/providers/stats/solanaClusterStats.tsx, app/features/vote/ui/VoteAccountSection.tsx, app/features/stake/ui/StakeHistoryCard.tsx, app/shared/ui/Card/BaseCard.tsx) · github.com/mrgnlabs/mrgn-ts (LICENSE, apps/marginfi-v2-ui/src/components/desktop/AssetList/AssetList.tsx, packages/mrgn-ui/src/components/action-box-v2/action-box.tsx, packages/mrgn-ui/src/components/wallet-v2/wallet.tsx) · github.com/MeteoraAg/meteora-invent (scaffolds/fun-launch package.json, src/pages/token/[tokenId].tsx, src/components/Explore/index.tsx) · github.com/Yaugourt/liquidterminal_front · github.com/Squads-Protocol/public-v4-client · github.com/jup-ag/plugin · github.com/blockworks-foundation/mango-v4-ui (LICENSE) · github.com/dydxprotocol/v4-web (LICENSE) · github.com/gmx-io/gmx-interface (LICENSE) · github.com/Uniswap/interface (apps/web/LICENSE) · github.com/aave/interface (LICENSE.md) · github.com/drift-labs/vaults-ui-template · github.com/velocity-exchange/drift-ui-template · github.com/SOL-Strategies/stakewiz-frontend · github.com/pramaths/solana-staking-dashboard · github.com/jito-foundation/stakenet · github.com/balancer/frontend-monorepo · github.com/KoNananachan/Neuberg · github.com/OpenBB-finance/OpenBB · github.com/tradingview/lightweight-charts · github.com/ukorvl/lightweight-charts-react-components · registry.npmjs.org (lightweight-charts, @tanstack/react-table, @tanstack/react-virtual, recharts, @visx/visx, @number-flow/react, ag-grid-react, @glideapps/glide-data-grid, react-financial-charts, uplot).

Figma and tools: developers.figma.com/docs/figma-mcp-server (rate-limits-access, tools-and-prompts, remote-server-installation) · help.figma.com articles 32132100833559, 39252411778583, 39888612464151, 23920389749655, 360038510873 · figma.com/pricing · forum.figma.com threads 54926, 55255 · shadcn.obra.studio · ui.shadcn.com/docs/figma · shadcndesign.com/pricing · untitledui.com/pricing · framesxdesign.com/pricing · setproduct.com/dashboards · ldesignstudio.gumroad.com/l/primetrade · ui4free.com (FrontDEX) · html.to.design (docs/pro-plan, docs/free-features) · v0.app (pricing, docs/figma, docs/github, docs/design-mode) · subframe.com · builder.io/pricing · magicpatterns.com/docs · onlook.com/pricing · animaapp.com/pricing.

Community and design: news.ycombinator.com items 47984512, 48791328, 47174021, 42025263, 42784184, 47596655, 19153875, 45621481, 46434037 · onekey.so Hyperliquid vs CEX UX · coinbureau.com reviews (Hyperliquid, Axiom, Phantom) · blog.kraken.com Pro interface + charting updates · finder.com Robinhood Legend · avark.agency prediction-market design patterns · jito.network StakeNet UI post · laine-sa.medium.com validator picking · blockworks.com Solana validator operator revenue · brandfetch.com/hyperliquid.xyz · design.withfudge.com (hyperfoundation.org, polymarket.com) · vercel.com/geist/colors · linear.app/now (UI redesign, StyleX) · unpkg.com/@radix-ui/colors@3.0.0 · nngroup.com complex-application-design · colosseum.com/hackathon (judging factors) · blog.colosseum.com (how-to-win, perfecting-your-hackathon-submission, Frontier winners) · github.com/SuperteamCanada/how-to-win-colosseum-hackathon · github.com/anthropics/claude-code frontend-design skill.
