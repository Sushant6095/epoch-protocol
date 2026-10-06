# 01 · Product and users

## What Epoch does

Solana validators earn per epoch (about every 32 hours: 432,000 slots). Many earn less than their vote
fees, and none can borrow against income they are sure to receive. Epoch is the revenue desk for them:

- **Validators** borrow an *advance* against their next epochs of revenue. Repayment is taken at the
  source every epoch: the program sweeps 50% of what the validator's accounts collect until the advance
  plus a 2% flat fee is repaid. The validator keeps the rest.
- **Lenders** deposit SOL into the **Vault** and pick a tranche: **Senior** (paid first, a *target* of
  0.03% per epoch ≈ 8.1% a year at 271.5 epochs a year) or **Junior** (first loss after the validator's
  bond, keeps everything above the senior target; locked 10 epochs; at least 20% of the vault).
- **Every staker** sees which validators are healthy: stake, APY split (staking + tips), fees kept after
  vote costs, how much depends on one delegator, uptime, and the Epoch Score.
- The **Solana Fee Index** is Epoch's published number per epoch: the stake-weighted median priority fee
  (micro-lamports per compute unit). **Predict** lets a signed-in wallet make a *call* in points on an
  epoch's Fee Index: 100 points an epoch, calls of 10 to 100 points, no cash value, no wallet transaction.
  Points only for v1; real SOL through Panta stays off until there is legal advice (decisions 2 and 3 in
  `10-OPEN-DECISIONS.md`).
- The **Fee Market** (a Terminal tab) lets a validator lock in its fee revenue for coming epochs with a
  fixed-rate swap on the Fee Index (Receive fixed), against Epoch's seeded market maker; anyone can take the other
  view (Pay fixed). A validator holding Receive-fixed swaps on each of the next 5 epochs counts as **hedged** and
  borrows at 40% instead of 25% (decision 21, `pages/fee-market.md`).
- **Launch** lets a validator sell a fixed share of its commission for a fixed term as a **revenue token** on a
  Meteora bonding curve; Epoch buys it back at source every epoch and burns it (ADR 0006, decision 22,
  `pages/launch.md`). A devnet demo: nothing in it is an offer.

### The rules the UI must show correctly

| Rule | Value today | Where it lives on-chain |
| --- | --- | --- |
| Credit limit | min(25% of 10 epochs' swept revenue — 40% when hedged, 4 × bond, cap) | `advance_bps_unhedged` / `_hedged`, `bond_multiplier` |
| Fee on an advance | 2% flat | `fee_bps = 200` |
| Repayment | 50% of each epoch's sweep | `remit_bps = 5000` |
| Income order each epoch | protocol fee (10%) → senior coupon (target) → junior keeps the rest | `protocol_fee_bps`, `senior_rate_bps_per_epoch = 3` |
| Loss order | validator's bond → junior (all of it) → senior (only after both are gone) | — |
| Default | 3 late epochs or 20 open epochs | `max_advance_epochs = 20` |
| Utilisation cap | 60% of the vault lent out at most | `max_utilization_bps = 6000` |
| Minimum score to borrow | 60 / 100 | `min_score = 6000` |

Never hard-code these in components: they come from the Pool account (`params` in the vault data).

## The four user groups

Design for the delegator first: they are the 500k-user market.

| Group | Size today (real) | What they want | Lands on | Signs in? |
| --- | --- | --- | --- | --- |
| Delegators (retail stakers) | 582,644 wallets, 1,356,362 stake accounts, median 1 SOL | Is my SOL safe, what did I earn, where should it go | My Stake | Yes, or read-only by pasting an address |
| Lenders | Senior: retail. Junior: funds, DAOs, treasuries | Yield above plain staking (4.95%) with clear loss rules | Vault | Yes, to deposit or withdraw |
| Validator operators | 683 validators; 136 earn less than their vote fees | Working capital against future revenue | Validator profile → Manage tab | Yes, with the validator's operator wallet |
| Public: judges, researchers, the curious | — | See the whole market at once | Landing, Terminal, Validators | No |

## Sign-in and accounts

1. **Connect.** Wallet Standard list: Phantom, Solflare, Backpack, then any other detected wallet. Show
   "Detected" or "Install" per wallet.
2. **Sign In With Solana.** The wallet signs a message, not a transaction: no fee, nothing moves. Show the
   full message in mono *before* the wallet pops up (domain, address, statement, nonce, issued-at, expiry).
3. **Account created.** The server checks signature, domain, nonce and expiry, creates the account keyed
   by the wallet address and sets a session cookie. No email, no password. (Endpoint requested in
   `BACKEND-REQUESTS.md`.)
4. **Optional later.** Email or Telegram for alerts, added from the Alerts card.
5. **Read-only mode.** Paste any address to see its dashboard; every action button then says
   "Sign in to …" and routes back to step 1.

## Roles come from the chain, never from a form

| Role | How the app knows | What changes in the UI |
| --- | --- | --- |
| Delegator | Wallet is staker or withdrawer on at least one stake account | My Stake lists its accounts |
| Lender | A Lender account exists for the wallet (seeds `lender`, pool, owner, tranche) | Vault shows shares and the withdraw action |
| Operator | Wallet equals `ValidatorPosition.operator`, or, before onboarding, the vote account's withdraw authority | The Manage tab appears on that validator's page |

One wallet can hold several roles at once.

## Health rules (one module in code, shared by My Stake, Validators and alerts)

- **Watch** when any of: health per epoch is negative (earns less than vote fees), the biggest delegator
  holds over 50%, uptime under 99% in the last 30 days, commission raised in the last 10 epochs.
- **Offline** when delinquent.
- Otherwise **Healthy**. Every badge shows its reason in words ("below break-even · 86% one delegator").

## Epoch Score

0–100, the same formula the program uses: vote credits up to 60, commission up to 25, tenure up to 15;
zero when delinquent; capped at 50 for the top 18 validators so the protocol never pushes stake to the
biggest. Explain it in a tooltip and a small "How the score works" dialog.

## Glossary for copy

Epoch (≈32 h cycle) · slot · stake account · delegator · validator · vote account · commission · tips
(Jito) · advance (what a validator draws; "borrow" is the verb, "loan book" the list of advances) · sweep
(repayment at the source) · bond · tranche (Senior, Junior) · target (the senior rate) · share price ·
Fee Index · call, market, pool, payout, points (Predict). Never: bet, gamble, wager, odds.
