# Launch · replica notes (round 3, 6 Oct 2026)

References: OpenSea Drops `869184ab` (list) and Wealthsimple NVDA `47b50f40` (token page), with Reown's swap
preview `7d84a622` (review) and Coinbase's gated ticket `c2dbc562` (gate). The Refero MCP and the reference images
were not available in the cloud box this round ran in, so the regions follow `handover/12-REPLICA-BLUEPRINTS.md`
and the Refero descriptions; `ref-compare.mjs` was not run (DECISIONS, 6 Oct).

## `/launch` (OpenSea Drops)

| Region | Built as | Library | Click map |
| --- | --- | --- | --- |
| Bold title, two tabs | `PageHeader` (Launch, Devnet badge with tooltip, Sample/Live status, the not-an-offer line) + line tabs `?tab=live\|past` | shadcn `tabs`, `badge` | LP2–LP4 |
| Group headings | On the curve now · Opens in epoch N · Graduated · buybacks still running · Ended | plain | LP5 |
| Wide drop card | Banner (token gradient, Epoch ring drawn to the raise, validator initials; no artwork) + status badge, symbol and name, share and term, Price · Market cap (fully diluted) · Buyback / epoch · Backing, raise bar, buyers line, Watch (upcoming) and View token | `badge`, `button`, fun-launch `CurveProgress` | LP6–LP8 |
| Footer note | Launch script link (GitHub) | plain | LP10 |

Differences: no countdown on upcoming cards (no upcoming token in the data; the Watch button and the group heading
carry the epoch); the validator name is plain text (no `/validators/[vote]` route in this build, LP9).

## `/launch/[mint]` (Wealthsimple NVDA)

| Region | Built as | Library | Click map |
| --- | --- | --- | --- |
| Two columns, sticky card | 8/4 grid; the Trade card sticky at `top-20`; on phones a pinned bar opens it as a bottom sheet | CSS grid, shadcn `drawer` | LP28 |
| Identity row | Back to Launch, initials avatar, symbol + watch star (`aria-pressed`), status and Devnet badges, name · validator; How it works; View on ▾ (mint, curve pool, DAMM v2 pool, escrow, RevenueToken, treasury) | `badge`, `dropdown-menu` (`Menu.LinkItem`) | LP11–LP13 |
| Big price + change | Price with subscript zeros, USD when known, change since the curve opened (vs `bandLowSol`), 24 h change, market cap fully diluted; Live/Stale/Unavailable/Sample badge | `PriceText` | LP14 |
| Chart + pills | Candles (up mint, down orange) with volume, dashed curve top and share's value labelled at the right edge, buyback markers, OHLC legend with the slice it shows, ←/→ moves the crosshair; pills 1m–1d (`?interval=`) | lightweight-charts | LP15–LP16 |
| Promo card | Curve card: raise bar and what graduation does; graduated: pool, liquidity, locked LP, Meteora's indexed view when present | `card` | LP17 |
| Market details (4 cols) | What backs it: share, term, share revenue, implied yield per epoch, backing, market cap, supply, burned, holders, mint authority, metadata, fees to lenders | `KeyValueGrid` | LP18 |
| Dividends (3 cols) + News | Buybacks and burns: headline, last epoch · next slice · escrow, slices grouped by epoch with explorer links; closed and paused states | plain lists | LP19 |
| (added) | Trades (fun-launch columns), Holders, Fees and treasury, Revenue-token terms | TanStack Table v9 | — |
| About | About the token and the risk lines, always open | plain | — |
| Buy card | Buy · Sell (· Redeem), amount with chips, quote rows, Review (Reown rows, warnings verbatim, consent), gate, stepper | `toggle-group`, `input`, `checkbox`, ReUI stepper | LP20–LP27 |

Differences: interval pills instead of 1 epoch · 4 epochs · All (the API's candles are by interval); the review is
inline in the card rather than a separate sheet; the success state is a status line and the stepper's explorer link.
