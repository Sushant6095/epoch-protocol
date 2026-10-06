# Provenance — every component that did not start from a blank file

A row per pulled or reused component. No row = not done (design-cop fails the TOKENS line without it). Licence must be MIT,
Apache-2.0, BSD, ISC or CC-BY; never AGPL, "all rights reserved", unlicensed, or Shadcnblocks.
Code reused from before the hackathon window (for example from omnipitch) is marked `pre-hackathon`
and disclosed in the PR description.

| Component (our path) | Source (registry / repo / URL) | Licence | Pulled via | Where used | What we changed | Pre-hackathon? |
| --- | --- | --- | --- | --- | --- | --- |
| `src/styles/tokens.css`, `globals.css`, `src/design/motion.ts`, `src/lib/gsap.ts`, `src/lib/anime.ts` | this handover kit (patterns follow omnipitch 2's motion/tokens files) | repo MIT | copy | everywhere | written for Epoch | pattern only |
| `src/components/ui/{alert,avatar,badge,button,card,chart,checkbox,collapsible,dialog,drawer,dropdown-menu,empty,hover-card,input,label,popover,progress,scroll-area,separator,sheet,skeleton,sonner,table,tabs,toggle,toggle-group,tooltip}.tsx` | shadcn/ui registry, style `base-nova` (Base UI) | MIT | `shadcn add` | every page | Epoch tokens on button, card, tabs (line variant), tooltip; 44 px touch targets; `DropdownMenuLinkItem` added (Base UI `Menu.LinkItem`); pixel arbitrary values replaced by scale classes | no |
| `src/components/reui/stepper.tsx` | ReUI registry `styles/base-nova/stepper` (reui.io) | MIT | registry JSON fetched with curl (CLI blocked by the proxy) | `src/components/tx/tx-stepper.tsx` (Predict, Launch) | none in the file; the wrapper renders it as an `<ol>` progress list | no |
| `src/components/launch/fun-launch/{age,curve-progress,trades-table}.tsx` | MeteoraAg/meteora-invent `scaffolds/fun-launch` (commit dd77ef3d) | MIT (repo LICENSE.md; the scaffold's package.json says ISC) | adapted by hand, see `app/THIRD-PARTY-NOTICES.md` | Launch list and token page | Epoch words and tokens, TanStack Table v9, SOL units, venue column, buyback rows, IST, frozen sample clock | no |
| `src/components/charts/use-lw-chart.ts`, `src/components/live/slot-strip.tsx`, `src/components/launch/price-chart.tsx` | TradingView lightweight-charts 5 (npm) | Apache-2.0 | npm | Live, Launch | written for Epoch; the attribution logo stays on and the footer links TradingView | no |
| `src/components/live/distribution-chart.tsx`, `src/components/predict/forecast-chart.tsx` | Recharts 3 through shadcn `chart` | MIT | npm + `shadcn add chart` | Live, Predict | written for Epoch | no |
| `src/components/data/data-table.tsx` | TanStack Table v9 (npm) | MIT | npm | every table | written for Epoch (sortable headers with `aria-sort`, numeric columns) | no |
