# Solana Fee Index: methodology

The Solana Fee Index is one number per Solana **mainnet** epoch: what transactions paid validators for priority, in
**micro-lamports per compute unit (µL/CU)**, robust to any single leader. Epoch publishes it every epoch, commits it
on chain, and its Panta markets ("Will the Solana Fee Index for epoch N close above X?") resolve from it. This page
is the definition those markets point to.

## Definition

For mainnet epoch N:

1. **Slot median.** For every slot of N that produced a block: the median compute-unit price (the priority fee per
   compute unit set with `ComputeBudgetProgram.setComputeUnitPrice`, in µL/CU) over the block's transactions,
   **excluding transactions whose fee payer is the slot leader's identity**, so a leader cannot pad its own blocks.
   A median of an even count is the integer mean of the two middle values, rounded down.
2. **Leader median.** For every leader of N: the median of the slot medians of the slots it led.
3. **Stake-weighted median.** Leaders are sorted by their leader median, ascending, each weighted by its active stake
   in N. The index is the first leader median at which the running stake reaches at least half of the total stake.
   Leaders with no stake are left out; an epoch with no data has no value. A leader with little stake cannot move the
   index however extreme its fees.

The value is an integer number of µL/CU. Reference implementation: `slotMedianCuPrice` and `stakeWeightedMedian` in
[`packages/indexer_app/src/Processors/FeeProcessor.ts`](../packages/indexer_app/src/Processors/FeeProcessor.ts),
with tests next to it.

## From computed to final

| Step | Who | What | Status at `GET /v1/index/epochs/{N}` |
| --- | --- | --- | --- |
| N is running | — | no value yet | `pending` |
| N ended | `indexer_app` | computes the value from N's blocks into `epoch_index` | `computed` |
| posted | `publisher_app` | `post_index` on the Epoch program's FeeIndex account, with a SHA-256 hash of every slot's inputs ([inputs hash](../packages/publisher_app/README.md#inputs-hash)) | `proposed` |
| dispute window | Epoch admin multisig | may `veto_index` a wrong value during `dispute_window_slots` | `proposed`, or `vetoed` |
| finalized | anyone (`cranks_app` does it) | `finalize_index` after the window | `final` |

A final value never changes: the program never re-opens a finalized epoch, and the FeeIndex account keeps the last
16 final values. A proposal that moves more than `max_move_bps` from the last final value is refused on chain. A
vetoed value is replaced by a corrected one for the same epoch, posted and finalized the same way.

When the Epoch program runs on mainnet, a mainnet epoch's value is posted under the same epoch number. While it runs
on devnet, mainnet epoch M is posted under a devnet epoch `M + offset`
([epoch numbering](../packages/publisher_app/README.md#epoch-numbering)); the per-epoch endpoint follows the post's
signature, so it always answers in mainnet epochs.

## Operator consensus

Without consensus, one `publisher` key proposes each value. With consensus on, a small set of operators votes on it
instead, modeled on Jito's TipRouter ballot box. The admin turns consensus on with `initialize_index_operators`, which
creates the registry `["index_operators", fee_index]` and points `FeeIndex.publisher` at that PDA. No key can sign as
the publisher after that. The `FeeIndex` account layout does not change.

- **Registry.** The admin registers up to 8 operator voting keys, each with a weight (the weights total at most
  10,000). The registry also holds the threshold, in bps of the total registered weight (default 6,667, allowed 5,001
  to 10,000), and the tolerance (default 100 bps, at most 1,000). Each change emits an event and applies only to ballot
  rounds opened after it.
- **Ballot.** Each program epoch has one ballot, `["index_ballot", fee_index, epoch]`. The first `cast_index_vote`
  creates it, and that vote's payer pays the rent of about 0.0074 SOL. A ballot can only open for an epoch that is
  newer than the last final one and has already started on the cluster. The round snapshots the operators, weights,
  threshold and tolerance, so later registry changes never affect an open round.
- **Votes.** Each operator has one vote per round, with a value and the same inputs hash the publisher computes.
  - Before consensus, an operator may replace its vote.
  - After consensus, a vote already cast is locked.
  - An operator that had not voted may still vote late. The vote is recorded with its deviation and changes nothing.
- **Agreement.** The weighted median m is the lowest cast value at which the cumulative weight reaches half of the cast
  weight, so it is always an actual vote.
  - A vote v agrees when `|v − m| × 10,000 ≤ m × tolerance_bps`.
  - Every vote's deviation from m, in bps rounded up, is stored in the ballot and emitted in `IndexVoteCast`.
  - Consensus needs the agreeing weight, as a share of all registered weight, to reach the threshold. Operators that
    did not vote count against it. The share is rounded up to a whole bps, so 6,667 means at least two thirds: two of
    three equal operators pass, and one never does.
- **Proposal.** When the threshold is first met, the ballot writes m and the median voter's inputs hash into
  `FeeIndex`'s proposal slot, exactly as `post_index` does. From there the dispute window, `veto_index` and
  `finalize_index` work unchanged, and so do swaps and Panta's resolution.
  - If `FeeIndex` cannot take the proposal yet (an earlier proposal is still in its window, or the move exceeds
    `max_move_bps`), the consensus is queued. Anyone can then write it with `submit_index_ballot`.
  - A vetoed proposal reopens the ballot. The next vote, or the admin's `reset_index_ballot`, starts round + 1 with a
    fresh snapshot.
- **Clean-up.** Once `FeeIndex.epoch` is at or past a ballot's epoch, anyone can call `close_index_ballot`, which
  returns the rent to the payer. At that point the ballot's epoch is final, or a later final epoch skipped it, so it
  can never be proposed again. The events keep the full history.
- **One operator.** When the registry has exactly one operator, its single vote is consensus. That operator may also
  use `post_index` directly, passing the registry as the first remaining account, which keeps devnet simple.

### Trust model

| Question | Answer |
| --- | --- |
| Who can move the index | Operators holding at least `threshold_bps` of the registered weight (default two thirds) whose votes agree within `tolerance_bps`. No single key can move it, unless the registry has only one operator. |
| By how much | At most `max_move_bps` from the last final value per epoch (as before). While agreeing weight is more than half of the cast weight, the median stays within the agreeing operators' range. A disagreeing minority cannot drag it outside, and an operator inside the tolerance can bias it by at most the tolerance. |
| How fast | One value per program epoch. A ballot only opens for an epoch that has started, and every proposal waits `dispute_window_slots` before anyone can finalize it. |
| Who can stop it | The admin multisig, with `veto_index` inside the window (as before). A veto reopens the ballot. |
| What the admin can still do | Change operators, weights, threshold and tolerance (each an event, applied to later rounds); reset a stuck round, without choosing its value; or return to a single publisher with `configure_index`. The admin remains the root of trust for who votes and for liveness. |

Known limits:

- **Visible votes.** Votes are public before consensus, so an operator can copy the median, or place its vote to bias
  it within the tolerance. Both are visible in the stored deviations and inputs hashes. Commit-reveal would remove
  this, at the cost of two transactions per operator per epoch.
- **Liveness.** If operators holding more than a third of the weight are offline or disagree, there is no consensus
  for that epoch until the admin changes the registry and resets the round.

## Reading it

`GET /v1/index/epochs/{N}` on Epoch's API answers `{ "ok": true, "data": { … } }`:

```json
{
  "epoch": 1051,
  "value": 1400,
  "status": "final",
  "final": true,
  "unit": "µL/CU",
  "computedValue": 1400,
  "onChain": {
    "cluster": "mainnet",
    "programId": "<Epoch program id>",
    "feeIndexAccount": "<FeeIndex PDA>",
    "programEpoch": 1051,
    "postSignature": "<post_index transaction>",
    "finalizeSignature": "<finalize_index transaction>"
  },
  "methodology": "https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md"
}
```

`status` is one of `pending`, `computed`, `proposed`, `final`, `vetoed`. Only `final` settles anything: Epoch's fee
swaps (`settle_swap`) and Epoch's Panta markets. `GET /v1/index?from=&to=` lists many epochs at once.

### Verified end to end

`scripts/e2e/index-to-final.mts` runs the whole path on a local validator with the program built from this repository
(throwaway program id), a Postgres schema of its own and the built apps: an `epoch_index` row for a finished mainnet
epoch → `publisher_app` posts it (`post_index`, mapped to a program epoch by `FEE_INDEX_EPOCH_OFFSET`) → the dispute
window (`FinalizeIndexJob` waits) → `FinalizeIndexJob` finalizes it → `api_app` answers `GET /v1/index/epochs/{N}` with
`final`, the value, the program epoch and both signatures, and the next epoch `pending`; `panta_bot_app`'s strike source
reads the value as final. Run on 2026-10-05 20:28 IST: 13 of 13 checks passed (mainnet epoch 1051 under program epoch 1,
value 1,400 µL/CU, dispute window 100 slots). Run again on 2026-10-07 14:21 IST against the program with operator
consensus, with no registry (the single-publisher path): 13 of 13.

`scripts/e2e/index-consensus.mts` checks the operator consensus rules on a local validator through the SDK. It covers:

- the single-publisher path, and consensus switched on with three operators (the old publisher is then refused);
- a dissenter: 1,000 and 1,500 give no proposal; 1,004 gives two of three at 1,004, and the dissenter's 4,941 bps
  deviation is recorded;
- a vote locked after consensus;
- a consensus queued behind an open window, then submitted;
- a veto that reopens the ballot as round 1;
- `close_index_ballot`: refused while open and for the wrong payer, otherwise refunding the payer;
- the one-operator `post_index`.

Run on 2026-10-07 14:17 IST: 29 of 29 checks passed.

## How Epoch's Panta markets use it

Each market asks whether the final value for one mainnet epoch is **strictly greater** than a threshold (equal resolves
NO); the thresholds (strikes) are quantiles of the last 10 final values. Trading closes before that epoch starts, so
nobody can trade while watching its fees. If the value is vetoed, the market resolves from the corrected final value; if
no final value is published by the deadline written in the market's rule (its resolution time plus a grace period), it
resolves NO. The rule, the sources and the times are in each market's `resolutionRule` and `sourcesOfTruth` on Panta.