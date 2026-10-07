# Backend requests (frontend → Sushant)

Chahat and Claude Code add requests here instead of touching `packages/`, `programs/` or `.github/`.
Each request: what, exact shape (types in `contracts/epoch-data.ts`), which page needs it, by when.
Sushant marks the status. Newest at the bottom.

| # | Request | Shape | Needed by | Page | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /v1/network` | `NetworkSnapshot` | Gate 1 (1 Oct) | Terminal, Landing, header | open |
| 2 | `GET /v1/network/stake-history?epochs=64` | `StakeHistory` | Gate 1 | Terminal | open |
| 3 | `status: "final" \| "proposed"` on `GET /v1/index` points (dispute window) | `FeeIndexPoint.status` | Gate 1 | Terminal | open |
| 4 | `WS /v1/stream` with channels `slot`, `activity`, `vault`, `feeIndex` | see 07-DATA-CONTRACTS | Gate 1 (slot), Gate 2 (rest) | all | open |
| 5 | `GET /v1/validators` (sort, chips, cursor; 683+ rows) and `GET /v1/validators/:vote` | `ValidatorList`, `ValidatorProfile` | Gate 2 (5 Oct) | Validators, profile | open |
| 6 | `GET /v1/delegators/biggest` and `/v1/delegators/retail-magnets` (nightly stake-account scan) | `BiggestDelegators`, `RetailMagnets` | Gate 2 | Terminal, Landing | open |
| 7 | SIWS: `POST /v1/auth/siws/nonce`, `POST /v1/auth/siws/verify` (check signature, domain, nonce, expiry; set session cookie), `POST /v1/auth/logout`, roles from chain | `{ address, roles: ("delegator"\|"lender"\|"operator")[] }` | Gate 2 | Sign in, My Stake | open |
| 8 | `GET /v1/vault` (Pool, tranches, advances, queue, lenders, params from the Pool account) | `VaultSnapshot` | Gate 2 | Vault, Terminal | open |
| 8b | `GET /v1/validators/:vote/position` — ValidatorPosition (operator, bond, score, swept epochs, limits) and the open Advance with its remit schedule and activity | `OperatorPosition` | Gate 2 | Validator → Manage tab | open |
| 9 | epoch-sdk: IDL + instruction builders for `deposit(tranche, amount)`, `request_withdraw`, `borrow` (advance), `onboard` | TS functions returning `TransactionInstruction[]` | Gate 2 | Vault, Manage tab | open |
| 10 | `GET /v1/wallets/:address/stake` (stake accounts, rewards per epoch via `getInflationReward`, health) | `MyStake` | Gate 3 (9 Oct) | My Stake | open |
| 11 | `GET /v1/predict/markets` + call/claim instructions (Panta) — only after the legal decision | `PredictSnapshot` | Gate 3, flagged | Predict | blocked on decision 2 |
| 12 | CI: add an `app` job (`pnpm --filter app typecheck` and `pnpm --filter app build`) | `.github/workflows/ci.yml` | any time | all | open |
| 13 | CODEOWNERS: add `/app/ @chahat-code @Sushant6095` | `.github/CODEOWNERS` | now | — | open |
| 5b | Additions to #5 from the click map (30 Sep): per row `mevCommissionPct`, `delinquent`, `commissionHistory` (last 10 epochs), `stakeHistorySol` (64 points, oldest first), `foundationSharePct` (for a Foundation-backed filter); on the list `total`, `nextCursor`, `facets.client`, `facets.country` and a `votes=<keys>` filter (Watchlist tab); `stakeByEpoch` for 64 epochs on `/v1/validators/:vote` | `ValidatorRow`, `ValidatorList`, `ValidatorProfile` | Gate 2 (5 Oct) | Validators, profile | open |
| 6b | Additions to #6: `BiggestDelegators.rows[].address` where the entity has a known address; `RetailMagnets.rows[].vote` | `BiggestDelegators`, `RetailMagnets` | Gate 2 | Terminal, Landing | open |
| 8c | Additions to #8: `advances[].vote`; `withdrawQueue[].signature` and `isMine` (or the owner address); `cycle` (this epoch's six crank steps and which one is running) | `VaultSnapshot` | Gate 2 | Vault, Terminal | open |
| 8d | Lender position for a wallet: its two Lender PDAs (shares per tranche, junior deposit epoch and lock end) and its open WithdrawRequest accounts; `GET /v1/wallets/:address/lender` or RPC reads with the IDL | `LenderPosition` (new type) | Gate 2 | Vault (Withdraw tab), My Stake (Lend card) | open |
| 9b | epoch-sdk builder for `cancel_withdraw(request)` | TS function returning `TransactionInstruction[]` | Gate 2 | Vault | open |
| 10b | `MyStakeAccount.stakeAccount`: the full stake-account pubkey (for the Orb link) | `MyStake` | Gate 3 (9 Oct) | My Stake | open |
| 14 | Watchlist sync when signed in: `GET /v1/me/watchlist`, `PUT /v1/me/watchlist` (vote keys, at most 200); signed out it stays in local storage | `{ votes: string[] }` | Gate 3 | Validators, profile | open |
| 15 | Alert preferences and sender: `GET /v1/me/alerts`, `PUT /v1/me/alerts` (offline, fee goes up, losing money, rewards landed; channels email and Telegram; the move-stake step 2 reminder), plus the job that sends them each epoch | `{ rules: { offline, feeUp, losingMoney, rewardsLanded }, channels: { email?, telegram? }, reminders: { kind, epoch }[] }` | Gate 3 | My Stake, Validators (Set an alert) | open |
