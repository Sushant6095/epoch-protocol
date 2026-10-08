# Epoch interface — 5 October 2026

This is a working local UI preview, not complete release acceptance.

## Built

- Landing: original R3F epoch object; responsive hero, network proof strip, operator cards, FAQ and navigation.
- Terminal: typed network/history hooks, epoch-range and flow controls, chart, CSV export, protocol metrics, Fee Index status colouring, activity, network health, tables and audience links.
- Validators: TanStack v9 table, desktop virtualization, URL search/filter/sort, local watchlist, compare up to three, mobile cards, CSV export. API reader follows pagination with cycle detection. Health from API is authoritative; snapshot health is computed from available revenue, concentration and uptime fields.
- Profile: route-specific summary, NTT detailed historical fixture, stake history, score explanation, complete revenue components, delegation breakdown, stake moves and reward estimator. Other profiles never reuse NTT history.
- Vault: tranche details, precision-preserving share-price chart, loan/queue/lender/parameter tables, per-borrower bond stress model, risk-gated deposit preview and SDK deposit preparation.
- My Stake: standalone sign-in, address validation, read-only API view and explicitly labelled demo dashboard, accounts CSV, health views, alert preference API UI.
- Wallet: Wallet Standard discovery, explicit connect, full SIWS message preview, nonce/verify/session/logout endpoints. No seed phrases or private keys are collected.
- Predict: current points contract, market selection, eligibility, call preview, HTTP submission, calls/rules/leaderboard. No old SOL-pool fixtures are reused.
- Data: current backend contract copies, API success/error envelopes, credentials, timeout and explicit snapshot mode. WebSocket reconnects and refreshes relevant HTTP caches. Failed API requests do not silently become sample responses.
- Transaction review: configured cluster check, program/accounts/network fee preview, wallet approval, confirmation/explorer result, changed-wallet/action rejection. No real transaction was sent during development.

## Configuration still needed

Public API origin, RPC URL, deployed program ID and program network. Variable names are in `.env.example`; no `.env` file was created. The API must allow the frontend origin for SIWS and authenticated requests. A production RPC key, if needed, belongs in the deployment's protected configuration, not chat.

## Not yet implemented or accepted

- Native stake/unstake/two-step move and operator onboarding/borrowing/manage flows.
- Lender withdrawal requests/cancellation and personal vault-share controls.
- Fee Market and Meteora launch interfaces. Their backend contracts exist; the frontend hook/contract groundwork does not count as a finished feature.
- Signed-in watchlist sync; current watches remain local to this browser.
- Every detail of the 264-row click map: advanced column preferences, full chart brush/comparison, complete Quick Answers, all stake/delegator panels and per-resource error views remain incomplete.
- Mobile >50-row virtualization is not complete; desktop uses TanStack Virtual. Full-scale pagination and API-failure cases need integration tests with a configured service.
- Live wallet, API session, email/Telegram and on-chain end-to-end tests. Only source wiring and local UI controls have been exercised.
- Strict Refero structural acceptance. Saved references and comparison images are available locally. The current pages follow the documented hierarchy and Epoch identity but do not meet the required 0.85 pixel-profile threshold; do not describe them as exact replicas or design-cop PASS.

## Validation

Production build and TypeScript pass. Four-breakpoint screenshot scans pass for Terminal, Validators, Profile, Vault, sign-in and demo My Stake (no console errors, blank chart canvases, horizontal overflow, or serious/critical axe findings). Landing passed the same scan before the final copy/accessibility-role changes. The interaction script in `scripts/ui/check-product.mjs` exercises chart tabs, URL persistence, search, local watchlist, comparison, deposit preview, stress controls, address validation, demo mode, FAQ and navigation; the final run passed. Landing and Predict also passed their four-breakpoint scans.

Design-cop reports are in `design/verdicts/`. Their source-level corrections were applied for transaction review binding, share-price precision, profile revenue detail, sign-in shell, source-history availability, phone sort direction, chart legends, status colours and overflow. They are not whole-product acceptance reports.

No deployment, commit, push or real wallet transaction has been performed.
