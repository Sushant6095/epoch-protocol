# Validator score from on-chain history: contract

Round 4 (P1) moved the Epoch Score's inputs on chain. A validator's `ValidatorHistory` account (PDA
`["history", vote]`) is filled by permissionless copies of chain state (its vote account, Jito's tip and priority-fee
distribution accounts) plus one oracle post (stake, rank, superminority, signed by the Pool's scorer), and anyone can
run `refresh_score` to recompute the score from it. The trust model is in
[docs/ARCHITECTURE.md](../ARCHITECTURE.md); the API details are in
[packages/api_app/README.md](../../packages/api_app/README.md) ("The Epoch program").

This contract is for the Manage tab's score card and any "on-chain history" panel on a validator page. Responses are
wrapped as `{ "ok": true, "data": … }`; times are IST (`+05:30`); units live in field names (`…Sol`, `…Pct`, `…Slot`);
`null` means the chain has not reported the value yet and the UI shows "—". The examples come from the API's test
simulator (`src/__fixtures__/ProgramSim.ts`), trimmed where marked `…`.

## What the UI uses

| Data                                                                                            | Source                                                 | When                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------- |
| Score, where it came from (on-chain history or the scorer's fallback) and its inputs            | `GET /v1/validators/:vote/position` → `scoreBreakdown` | with the Manage tab (cache 10 s) |
| Per-epoch history: credits vs the maximum, commissions, MEV, priority fees, revenue, stake rank | `GET /v1/validators/:vote/history` → `entries`         | on open (cache 10 s)             |
| Freshness badge ("fresh this epoch", "stale", "no copies yet")                                  | `GET /v1/validators/:vote/history` → `freshness`       | same                             |
| Live rows: history opened, copies, stake posts, refreshes                                       | WS `/v1/stream`, channel `activity`, `kind: "score"`   | each push                        |

## `GET /v1/validators/:vote/position` → `scoreBreakdown`

```json
{
  "source": "history",
  "epoch": 1100,
  "inputs": {
    "score": 87,
    "creditsOfMaxPct": 93.75,
    "creditsVsClusterPct": 94.3,
    "commissionPct": 10,
    "epochsActive": 64,
    "delinquent": false,
    "superminority": false,
    "hedged": false,
    "hedgeRequiredSol": 0.95
  },
  "history": { "address": "…", "freshness": "fresh", "lastVoteCopyEpoch": 1100 }
}
```

- `source: "history"`: the program computed the score itself (`refresh_score`). `source: "scorer"`: the Pool's scorer
  key posted it (`update_score`, the fallback while the history is not fresh); `inputs` is then `null`, because those
  inputs are not on chain. Copy: "Scored on chain from the validator's history" / "Scored by the Epoch scorer".
- `creditsOfMaxPct`: vote credits over the last 10 finished epochs as a share of the most possible (16 per slot).
  `creditsVsClusterPct`: the same against the cluster average (`scoring.creditsReferencePct` of the maximum = 100%);
  this is the formula's input and may exceed 100.
- `commissionPct`: the highest of the inflation and MEV commissions over the window and this epoch (a one-epoch drop
  does not erase last week's 100%).
- `scoreBreakdown` is `null` for a validator that is not onboarded; `history` is `null` before anyone created the
  account.

## `GET /v1/validators/:vote/history`

```json
{
  "schemaVersion": 1,
  "kind": "real",
  "asOf": "2026-10-03T10:00:00+05:30",
  "source": "Epoch program on devnet: the ValidatorHistory account (vote account, Jito and scorer copies)",
  "vote": "FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk",
  "name": "NTT DOCOMO GLOBAL",
  "address": "…",
  "createdEpoch": 1100,
  "currentEpoch": 1100,
  "currentSlot": 475205080,
  "freshness": {
    "status": "fresh",
    "lastVoteCopyEpoch": 1100,
    "lastVoteCopySlot": 475205050,
    "slotsSinceVoteCopy": 30,
    "maxCopyAgeSlots": 9000,
    "stakeInfoPosted": true,
    "refreshReady": true
  },
  "lastRefresh": {
    "score": 87,
    "creditsOfMaxPct": 93.75,
    "creditsVsClusterPct": 94.3,
    "commissionPct": 10,
    "epochsActive": 64,
    "delinquent": false,
    "superminority": false,
    "hedged": false,
    "hedgeRequiredSol": 0.95,
    "epoch": 1100,
    "slot": 475205070
  },
  "scoring": {
    "creditsWindowEpochs": 10,
    "creditsReferencePct": 99.5,
    "countBlockCommission": false,
    "maxCopyAgeSlots": 9000,
    "marketMaker": "A87ysNWAmmqQHafLSQGbYSLhtcV3BjXctR88EWuSobGP"
  },
  "entries": [
    {
      "epoch": 1099,
      "credits": 6480000,
      "maxCredits": 6912000,
      "creditsOfMaxPct": 93.75,
      "inflationCommissionPct": null,
      "blockCommissionPct": null,
      "mevCommissionPct": null,
      "priorityFeeCommissionPct": null,
      "mevEarnedSol": null,
      "priorityFeesSol": null,
      "voteAccountSol": null,
      "revenueSol": null,
      "activatedStakeSol": null,
      "stakeRank": null,
      "superminority": null,
      "lastVotedSlot": null,
      "updatedSlot": null,
      "sources": ["credits"]
    },
    {
      "epoch": 1100,
      "credits": 75750,
      "maxCredits": 6912000,
      "creditsOfMaxPct": 1.0959,
      "inflationCommissionPct": 5,
      "blockCommissionPct": 100,
      "mevCommissionPct": null,
      "priorityFeeCommissionPct": null,
      "mevEarnedSol": null,
      "priorityFeesSol": null,
      "voteAccountSol": 1,
      "revenueSol": 0.5,
      "activatedStakeSol": 193097,
      "stakeRank": 212,
      "superminority": false,
      "lastVotedSlot": 475205049,
      "updatedSlot": 475205050,
      "sources": ["vote", "credits", "stake"]
    }
  ]
}
```

- `entries` are oldest first, at most 64 (the vote account itself keeps 64 epochs of credits, so the first copy
  backfills them). The current epoch's credits are partial. On devnet there is no Jito, so the MEV and priority-fee
  fields stay `null`; on mainnet `mevEarnedSol` is the epoch's whole tip pot (`merkle_root.max_total_claim`) and
  appears once Jito uploads the merkle root, a few hours into the next epoch.
- `sources` says what filled an entry: `vote` (this epoch's vote-account copy), `credits` (the credit list), `tip`,
  `priorityFee` (Jito) and `stake` (the scorer's oracle post, the only signed input).
- `freshness.status`: `fresh` = copied this epoch; `stale` = the newest copy is older (the keepers have not run this
  epoch: show its age with `lastVoteCopyEpoch`); `empty` = created, never copied. `refreshReady` is what
  `refresh_score` checks first: a fresh copy no older than `maxCopyAgeSlots`, this epoch's stake post, and scoring set.
- 404 `NOT_FOUND` when the vote account has no history yet (any wallet can create one with `init_validator_history`;
  the keepers create it for every onboarded validator once scoring is configured); 400 for a vote that is not a
  base58 public key; 503 `PROGRAM_NOT_CONFIGURED` without `EPOCH_PROGRAM_ID`.

## WS `activity` rows (`kind: "score"`)

| Event                           | Text                                                                                                                                         | Amount                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `HistoryInitialized`            | "NTT DOCOMO GLOBAL · on-chain history opened"                                                                                                | —                               |
| `VoteAccountCopied`             | "NTT DOCOMO GLOBAL · vote account copied on chain" (first copy of each epoch only)                                                           | —                               |
| `TipDistributionCopied`         | "NTT DOCOMO GLOBAL · Jito tips copied: 8% MEV commission" (not sent when there is no Jito account)                                           | the epoch's MEV pot, once known |
| `PriorityFeeDistributionCopied` | "NTT DOCOMO GLOBAL · Jito priority fees copied: 50% commission" (same)                                                                       | priority fees sent to Jito      |
| `StakeInfoUpdated`              | "NTT DOCOMO GLOBAL · stake rank #212 posted by the scorer" (", superminority" when set)                                                      | —                               |
| `ScoreRefreshed`                | "NTT DOCOMO GLOBAL · score 87 from on-chain history" ("(delinquent, superminority, hedged)" when set; only when the score or a flag changed) | —                               |
| `ScoringConfigured`             | "Scoring settings: 10-epoch credit window, cluster average at 99.5% of the maximum"                                                          | —                               |

Frames are `{ "channel": "activity", "data": ActivityEvent, "at": "…+05:30" }` like every other activity row
(`unit: "SOL"`, `value: null`). `kind: "score"` is new in round 4: a client that does not know it should skip the row.
