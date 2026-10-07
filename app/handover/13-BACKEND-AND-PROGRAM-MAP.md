# 13 · Backend and program map: what each screen reads and signs

Checked against the repo's `main` on 30 Sep 2026 (IST), the program as of `285503b` (phase 4); updated 1 Oct with the API
work built for the branch `feat/api-network-validators-delegators` and the Fee Market and Launch specs. This page is the overview: for every
screen, which API it reads, which transaction the wallet signs, and which program accounts sit behind it.
The per-click detail (every button, its call, its loading, empty, error and success states) stays in
`11-CLICK-MAP.md`, column "Data or call".

The backend and program code are not in this kit. They come with the repo you clone: `programs/epoch`
(the Solana program, Anchor 1.2.0) and `packages/*` (the services). Read them freely and never edit them;
anything you need from them goes in `BACKEND-REQUESTS.md` ("#" below is the line there).

## 1. Where the backend stands today

**Networks (decision 6, settled 1 Oct).** The Epoch program runs on devnet for the demo and the 5 Oct gate. The
Terminal, Validators and My Stake read live mainnet data, and native staking (Stake program: stake, move,
unstake) stays on mainnet. Two RPC variables: `NEXT_PUBLIC_SOLANA_RPC_URL` (mainnet data and staking) and
`NEXT_PUBLIC_EPOCH_RPC_URL` (the devnet program). Every screen that uses the program (Vault, Validator → Manage,
onboarding and Borrow, the Fee Market, Launch) shows a "Devnet" badge and one line saying the wallet must be switched
to devnet; its Sample badges disappear once the devnet accounts exist.

| Piece | Repo path | Ready now | Still to come | Meanwhile the app |
| --- | --- | --- | --- | --- |
| REST + websocket API | `packages/api_app` | on `main`: `GET /v1/index` (Fee Index; query `from`, `to`, `limit` 1–500, default 50) and `/health`. **Built and tested 1 Oct for the branch `feat/api-network-validators-delegators` (to commit, merge and deploy, #25):** `GET /v1/network`, `/v1/network/stake-history`, `/v1/validators` (filters, sort, cursor, facets), `/v1/delegators/biggest`, `/v1/delegators/retail-magnets` (#1, #2, #5 list, #6), tested against mainnet. Every response is wrapped `{ ok, data }` | the rest of section 2 (#3, #4, #5 profile, #7–#15, #19, #22) and deploying the branch (#25) | reads fixtures; `USE_API` flips one hook at a time as endpoints ship; `api-samples/` shows the live shapes |
| Solana program | `programs/epoch` | all 29 instructions (pool, credit, Fee Index, fee market) and their error codes in `errors.rs` | deployment to devnet (decision 6): the program ID is the placeholder `11111111111111111111111111111111` until `anchor keys sync` (Phase 5); the devnet Pool starts with `senior_rate_bps_per_epoch = 3` (#17) | shows every program number with the Sample badge until the devnet accounts exist |
| SDK | `packages/epoch-sdk` | PDA helpers: pool, vault, validator position, vote authority, fee index | the IDL and the instruction builders (#9, #9b) | builds every review screen now; the final "Sign in wallet" waits for the builders |
| Indexer | `packages/indexer_app` | the fee maths (`FeeProcessor`) | the Yellowstone stream that writes slot fees (TODO F4) and program events | `GET /v1/index` returns rows only once the indexer writes them |
| Cranks | `packages/cranks_app` | the job list: accrue, claim MEV, settle swaps, sweep, update score | sending the transactions (TODO F2–F8) | the Terminal's epoch cycle stays Sample |
| Publisher | `packages/publisher_app` | — | `post_index` / operator votes on chain (no Switchboard feed: Switchboard shut down; readers use the FeeIndex account or `GET /v1/index/latest-final`) | Fee Index bars have no proposed/final status yet (#3) |
| Predict | `packages/api_app` (points mode) · `packages/panta_bot_app` (real SOL) | — | points mode (decisions 2, 3 and 23): markets, calls, leaderboard and the job that resolves each market from the final Fee Index value (#11). The Panta bot (TODO F10) stays behind `PREDICT_REAL_SOL` (off) until there is legal advice | Predict stays Sample, in points |
| Fee Market | `programs/epoch` (market) · `publisher_app` (quotes) · `api_app` | the four market instructions in the program | the read API (#19), SDK builders (#20), the seeded maker and the hedged rule (#21) | the Fee Market tab runs on `fee-market.sample.json` |
| Launch (revenue tokens) | `packages/meteora` · `programs/epoch` (planned `launch/`) · `api_app` | ADR 0006 and plan F13 | `register_revenue_token`, `execute_buyback`, `redeem` and the escrow (#22), browser trade helpers (#23), the launch script (#24) | Launch runs on `launches.sample.json` and `launch-rkest.sample.json` |

## 2. Screen by screen

| Screen | Reads: hook → endpoint (#) | The wallet signs | Program accounts behind it | Click-map rows |
| --- | --- | --- | --- | --- |
| App shell (every app page) | `useNetwork` → `GET /v1/network` (#1) + `WS /v1/stream` channel `slot` (#4) · search over `useValidators` (#5) · `useSession` (#7) · SOL price from Jupiter | a sign-in message only (SIWS), never a transaction | — | SH1–13 |
| Landing `/` | `useNetwork` (#1, #4) · `useVault` → `GET /v1/vault` (#8): TVL and every rule number from `params` · `useBiggestDelegators`, `useRetailMagnets` → `GET /v1/delegators/…` (#6, #6b) · `usePredict` (#11) · `useValidator` (#5) | the sign-in message behind "Check my stake" | `Pool` (TVL, params) | LA1–24 |
| Terminal `/terminal` | `useNetwork` (#1 **built**, #4) · `useStakeHistory` → `GET /v1/network/stake-history` (#2 **built**) · `useFeeIndex` → `GET /v1/index` **ready** (+ `status`, #3) · `useVault` (#8, #8c) · `useTopValidators` (#5 **built**) · `useBiggestDelegators`, `useRetailMagnets` (#6, #6b **built**) · activity → `WS activity` + `GET /v1/activity` (#4) | nothing | `Pool`, `Advance` (loan book), `WithdrawRequest` (queue), `FeeIndex` | TE1–32 |
| Fee Market `/terminal?tab=market` | `useFeeMarket` → `GET /v1/market` (#19) · `useFeeIndex` · `myHedge` in the same response for operators (the five-epoch hedge) · `WS feeIndex`, `activity` | all on devnet: **Open a swap:** `open_swap(notional, side)` on a quote (#20) · **Hedge 5 epochs:** five `open_swap` in one transaction · **Settle:** `settle_swap` (anyone) | `FeeIndex`, `FeeQuote` (`["quote", maker, epoch]`), `SwapPosition` (`["swap", quote, taker]`, one per quote per wallet), `Pool` (paused) | FM1–30 |
| Validators `/validators` | `useValidators` → `GET /v1/validators` (#5, #5b) · watchlist → `GET`/`PUT /v1/me/watchlist` (#14) · alerts (#15) | the sign-in message, to save a watchlist | `ValidatorPosition.score` (Epoch Score) once a validator is onboarded | VE1–41 |
| Validator profile `/validators/[vote]` | `useValidator` → `GET /v1/validators/:vote` (#5, #5b) · `useOperatorPosition` → `GET /v1/validators/:vote/position` (#8b) · `useMyStake` (#10) | **Stake** (mainnet): Stake program `createAccount` + `delegate(vote)` (not Epoch's program) · **Onboard** (devnet): `onboard_validator` + `set_collectors` + `post_bond(lamports)` in one transaction · **Borrow** (devnet): `request_advance(amount)` | `ValidatorPosition`, `Advance`, `Pool.params`, the escrow and vote-authority PDAs | VP1–48 |
| My Stake `/me` | `useMyStake` → `GET /v1/wallets/:address/stake` (#10, #10b) · `useLenderPosition` → `GET /v1/wallets/:address/lender` (#8d, the Lend card) · alerts (#15) | **Move or unstake** (mainnet): Stake program `deactivate`, then next epoch `delegate` (move) or `withdraw` (unstake) | `LenderShares`, `WithdrawRequest` (Lend card) | MS9–41 |
| Predict `/predict` | `usePredict` → `GET /v1/predict/markets` + `GET /v1/predict/leaderboard`; a call is `POST /v1/predict/calls { marketId, side, points }` with the session cookie (#11, points mode) | nothing: a call needs the sign-in session, never a wallet transaction (points only; the Panta / real-SOL path stays behind `PREDICT_REAL_SOL`, off) | none: points markets live in `api_app` and resolve from the final `FeeIndex` value | MS42–55 |
| Vault `/vault` | `useVault` → `GET /v1/vault` (#8, #8c) + `WS vault` · `useLenderPosition` (#8d) | all on devnet: **Deposit:** `deposit(tranche, assets)` · **Withdraw:** `request_withdraw(shares)` · **Cancel:** `cancel_withdraw` (#9b) | `Pool`, `LenderShares` (one per tranche), `WithdrawRequest`, the vault PDA | VA1–37 |
| Launch `/launch`, `/launch/[mint]` | `useLaunches` → `GET /v1/launches`, `useLaunch` → `GET /v1/launches/:mint` (#22) · `WS activity` (kind `buyback`) · trade quotes from `@epoch/meteora` (#23) | on devnet: **Buy / Sell:** a Meteora DBC `swap2` on the curve, a DAMM v2 swap after graduation (#23; not Epoch's program) · **Redeem** (fallback): `redeem` (#22) | Meteora DBC pool and config, DAMM v2 pool; Epoch's revenue-token record on `ValidatorPosition` and the buyback escrow (planned, F13) | LP1–28 |
| Sign in (Connect dialog, `/me` signed out) | `POST /v1/auth/siws/nonce` → wallet `signIn()` → `POST /v1/auth/siws/verify`; `POST /v1/auth/logout` (#7) | a sign-in message only | roles from chain: operator (`ValidatorPosition.operator`), lender (`LenderShares`), delegator (stake accounts) | MS1–8, MS56–69 |

## 3. Every program instruction: who signs it, where it shows

"Anyone (crank)" means the program lets any key call it; `cranks_app` does, once per epoch. Error words
not given here are in the click-map row named; show the program's own message only as a fallback. The program
runs on devnet for now (decision 6), so every instruction below is sent through `NEXT_PUBLIC_EPOCH_RPC_URL`
with the wallet on devnet.

| Instruction | Signed by | Where it shows in the app | Errors to put in words |
| --- | --- | --- | --- |
| `initialize_pool` · `update_params` · `set_paused` · `set_roles` | admin (Sushant's key) | no screen. `Pool.params` feeds every rule number; `Pool.paused` should disable Deposit and Borrow with "Paused by the protocol" (add the rows) | `NotAdmin` (never reaches users) |
| `deposit(tranche, assets)` | the lender's wallet | Vault → Deposit (VA14–18) | `Paused` "Deposits are paused right now" · `ZeroAmount` "Enter an amount" · `PoolCapExceeded` "The vault is full; try a smaller amount" · `JuniorFloorBreached` (Senior only) "Senior is full until more Junior money comes in; try Junior or a smaller amount" |
| `request_withdraw(shares)` | the lender's wallet | Vault → Withdraw (VA19–22). A Junior request that would take Junior under `min_junior_bps` is still accepted; the crank bounces it later (next row) | `ZeroAmount` · `InsufficientShares` "More than your shares" · `JuniorLocked` "Junior shares unlock in epoch N" (last deposit epoch + `junior_lock_epochs`) |
| `cancel_withdraw` | the lender's wallet | Vault → request card (VA23) | `RequestCancelled` "Already cancelled" |
| `process_withdrawal` | anyone (crank) | the queue row turns "Paid in epoch N" (VA23, VA35). A Junior request that would take Junior under `min_junior_bps` when it reaches the head of the queue is bounced instead: cancelled, shares back to the lender, `WithdrawCancelled` with reason 1; the card reads "Bounced: Junior floor. Your shares are back." (VA23, decision 20) | — |
| `accrue` | anyone (crank) | share-price lines (Vault chart, Terminal vault pulse) | — |
| `onboard_validator` | the operator + the vote account's current withdraw authority (often the same key) | Validator → operator panel → Review onboarding (VP37–39) | `Paused`, `NotWithdrawAuthority`, `CommissionTooLow`, `NotAVoteAccount` (words in VP39) |
| `set_collectors` | anyone | sent inside the onboarding transaction; again after an identity change | `ProgramNotWithdrawAuthority`, `PositionNotActive` |
| `post_bond(lamports)` | the operator | inside the onboarding transaction (VP38) | `ZeroAmount`, `NotOperator` |
| `request_advance(amount)` | the operator | Validator → Borrow (VP42–44) | `AdvanceAlreadyOpen`, `ScoreTooLow`, `ScoreStale`, `InsufficientHistory`, `OverLimit`, `BelowMinimum`, `UtilizationCapExceeded`, `InsufficientLiquidity`, `Paused` (words in VP44) |
| `sweep` | anyone (crank) | Manage schedule and activity (VP25), Terminal loan book, Landing "How it works" | — |
| `update_score(update)` | the scorer key (crank) | Epoch Score on the profile and in the table | — |
| `mark_default` | anyone (crank) | "Defaulted" banner on Manage and in the loan book | — |
| `withdraw_bond(lamports)` · `release_validator` | the operator | **no screen before submission** (decision 19): Epoch's operator script (#16); the Manage tab says so in one line (VP23) | `BondLocked` "The bond unlocks when the advance is repaid" · `AdvanceOpen` "Repay the advance first" |
| `update_commission(kind, bps)` · `update_identity` | the operator (+ the new identity key) | **no screen before submission** (decision 19): once onboarded, a validator changes its commission or identity only through Epoch, with the operator script (#16) | `CommissionTooLow`, `CommissionChangeBlocked` "Limited while an advance is open", `BpsOutOfRange`, `AdvanceOpen` |
| `initialize_index` · `configure_index` · `veto_index` | admin | no screen; a vetoed point never turns final | — |
| `post_index(epoch, value, inputs_hash)` | the publisher key (`publisher_app`) | Terminal Fee Index bar, "proposed" (#3) | — |
| `finalize_index` | anyone (crank, after the dispute window; no job calls it yet, #21) | the bar turns "final"; swaps can settle | `NoProposal`, `DisputeWindowOpen` (never reach users) |
| `post_quote` · `withdraw_quote` | any key may post a quote; v1 shows only Epoch's market maker (the publisher key, #19, #21) | no screen: the quotes show in the Fee Market's quotes table (FM18–FM19) | `QuoteEpochMismatch`, `QuoteExpired`, `QuoteHasOpenSwaps`, `NotMaker` (never reach users) |
| `open_swap(notional, side)` | the taker (a validator hedging takes `ReceiveFixed`) | Fee Market ticket (FM13–FM17); the hedged credit limit (40% instead of 25%) depends on it (#21) | `QuoteExpired` "Trading on this epoch has closed" · `QuoteCapacityExceeded` "More than this quote has room for" · `Paused` "The market is paused" · `ZeroAmount` "Enter an amount" · the account already exists "You already hold a swap on this epoch" |
| `settle_swap` | anyone (crank; the page offers Settle now) | Your swaps (FM24) | `IndexMissing` "Settles when the epoch's index is final" (and, once the epoch has left the 16-epoch history, "can no longer settle on-chain") · the position account is closed by a settle, so a second one fails with Anchor 3012 (AccountNotInitialized): "Already settled"; `AlreadySettled` can't fire in practice |
| `register_revenue_token(share_bps, term_epochs, mint, dbc_pool)` · `execute_buyback(slice)` · `redeem` (planned, F13) | the operator with Epoch (the launch script, #24) · anyone (crank, 12 slices an epoch) · the holder | Launch: no launch screen (decision 22); the buyback feed (LP19); Redeem in fallback mode (LP27) | words to add when the instructions land |

## 4. Gaps found while checking (30 Sep; 7–12 added 1 Oct)

1. **Gate 1 (Terminal live on mainnet, 1 Oct)** needs #1, #2 and the `slot` channel of #4. #1 and #2 were built and
   tested on 1 Oct and wait to be committed and deployed (#25); the `slot` channel doesn't exist yet, so the Terminal
   ships on its real fixtures until they land.
2. **Nothing can be signed against Epoch's program** until it is deployed to devnet (a real program ID) and the
   SDK has the IDL and builders (#9, #9b). Build the review screens and the error words now.
3. **Operator settings and leaving Epoch have no screen:** `update_commission`, `update_identity`,
   `withdraw_bond`, `release_validator`. Settled 1 Oct (decision 19): not in the app before submission; the
   Manage tab points to Epoch's operator script (#16, only if a design partner needs it).
4. **The fee market had no screen**, and the operator panel's "7.6 hedged" chip promises a limit that needs
   `open_swap`. Settled 1 Oct (decisions 8 and 21): the Fee Market tab is specified in `pages/fee-market.md`
   (FM1–FM30); it needs #19–#21.
5. **Vault errors:** the click-map rows VA14 and VA22 say "the program error in words"; section 3 has the words.
6. **`Pool.paused`** has no banner in the click map; add rows for the Vault and Manage before building them.
7. **Junior floor on withdrawals (settled 1 Oct, decision 20).** The click map said a Junior request that would
   take Junior under `min_junior_bps` is accepted and waits in the queue. The program accepts it, and
   `process_withdrawal` bounces it when it reaches the head of the queue: the request is cancelled, the shares
   go back to the lender and the program emits `WithdrawCancelled` with reason 1. VA22 and VA23 now follow the
   program; the lender position needs `status: "bounced"` (#8d).
8. **`JuniorFloorBreached` has the wrong message.** `errors.rs` says "Withdrawal would push…", but a Senior
   deposit raises it. The app shows its own words (section 3, `deposit`); the message fix is #18.
9. **The hedged rule has two descriptions** (1 Oct). Plan F7 says Receive-fixed swaps covering the next 5 epochs at
   ≥ 50% of average revenue; `update_score.rs` says "a Fee Market hedge for the coming epoch". The Fee Market spec
   follows the plan (decision 21); #21 asks to align the scorer and its comment.
10. **Launch has no program code yet** (1 Oct). ADR 0006 and plan F13 name `register_revenue_token`,
    `execute_buyback` and `redeem` under a planned `instructions/launch/`; the Launch page is specified against
    them and runs on fixtures until #22–#24 land. A mainnet graduation (F13's "done when") waits for the program's
    mainnet deploy (decision 22).
11. **Nothing finalizes the Fee Index, and settlement has a 16-epoch window** (1 Oct). `finalize_index` is
    permissionless but no crank job calls it, and `post_index` refuses the next epoch while a proposal is pending.
    `settle_swap` reads the final value from the FeeIndex account, which keeps the current value and 16 history
    entries: a swap not settled within that window can never settle and its collateral stays locked. #21 adds the
    finalize-then-settle job; widening the history or storing the final value on the quote would remove the risk.
12. **`post_quote` is open to any key** (1 Oct). The Fee Market lists only Epoch's maker (#19), so a stranger's quote
    never shows up as Epoch's.
