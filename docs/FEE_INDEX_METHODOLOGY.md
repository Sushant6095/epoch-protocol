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
    "postSignature": "<post_index transaction>"
  },
  "methodology": "https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md"
}
```

`status` is one of `pending`, `computed`, `proposed`, `final`, `vetoed`. Only `final` settles anything: Epoch's fee
swaps (`settle_swap`) and Epoch's Panta markets. `GET /v1/index?from=&to=` lists many epochs at once.

## How Epoch's Panta markets use it

Each market asks whether the final value for one mainnet epoch is **strictly greater** than a threshold (equal
resolves NO). Trading closes before that epoch starts, so nobody can trade while watching its fees. If the value is
vetoed, the market resolves from the corrected final value; if no final value is published by the deadline written in
the market's rule (its resolution time plus a grace period), it resolves NO. The rule, the sources and the times are
in each market's `resolutionRule` and `sourcesOfTruth` on Panta.
