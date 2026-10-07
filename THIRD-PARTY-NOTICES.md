# Third-party notices

Code outside `app/` that was adapted from third-party source (the app keeps its own list in
`app/THIRD-PARTY-NOTICES.md`). Every adapted file starts with an `Adapted from <repo>/<path> (<licence>): <what changed>`
comment. Crates and npm packages keep their own licences.

| Epoch file | Adapted from | Licence | What changed |
| --- | --- | --- | --- |
| `programs/epoch/tests/litesvm/src/lib.rs`, `context.rs`, `setup.rs` | [jito-foundation/stakenet](https://github.com/jito-foundation/stakenet) `tests/src/steward_fixtures.rs` (`TestFixture`, `advance_num_epochs`, `submit_transaction_assert_error`); [jito-foundation/jito-tip-router](https://github.com/jito-foundation/jito-tip-router) `integration_tests/tests/fixtures/test_builder.rs` and `mod.rs` (`TestBuilder`, per-program clients, `assert_ix_error`) | Apache-2.0 | The fixture/builder split and per-instruction helpers, rewritten for LiteSVM (synchronous, no `solana-program-test`, BanksClient or tokio); Anchor-typed events and error codes; one epoch warp that keeps `Clock` consistent; instruction builders from the program's own Anchor types instead of hand-written account lists |
| `programs/epoch/src/vote_account.rs` (voting record) | [jito-foundation/stakenet](https://github.com/jito-foundation/stakenet) `utils/vote-state/src/lib.rs` | Apache-2.0 | Borrowing, bounds-checked walk to the credit list for V1_14_11, V3 and V4; also returns the newest voted slot; pinned by real mainnet vote accounts |
| `programs/epoch/src/state/validator_history.rs` | stakenet `programs/validator-history/src/state.rs` | Apache-2.0 | Ring indexed by `epoch % 64` instead of an append-ordered `CircBuf`; `u64` epochs; exact lamports; Epoch's fields; 8 KiB instead of 64 KiB |
| `programs/epoch/src/math/history.rs` | stakenet `programs/steward/src/score.rs` | Apache-2.0 | Integer bps instead of `f64`; TVC maximum from the EpochSchedule; delinquency from the newest vote; rescaled onto Epoch's score; Epoch's hedge rule |
| `programs/epoch/src/instructions/history/common.rs` | stakenet `programs/validator-history/src/instructions/copy_tip_distribution_account.rs`, `copy_priority_fee_distribution.rs` | Apache-2.0 | Fixed program ids; a missing account is a no-op; vote cross-check; one reader for both layouts |
| `programs/epoch/src/instructions/history/update_stake_info.rs` | stakenet `programs/validator-history/src/instructions/update_stake_history.rs` | Apache-2.0 | Signed by the pool's scorer; bounded to the ring; rank checked |
| `programs/epoch/src/math/consensus.rs`, `programs/epoch/src/state/index_ballot.rs` | [jito-foundation/jito-tip-router](https://github.com/jito-foundation/jito-tip-router) `core/src/ballot_box.rs` | MIT or Apache-2.0 | Ballot box per epoch, operator votes tallied against the total registered weight, vote changes before consensus, locked votes and late votes after it. Rewritten in Anchor for a numeric index: votes agree within a tolerance of the weighted median instead of being equal, the threshold is a bps parameter with an explicit rounding rule, every vote's deviation is stored, the operator set is snapshotted into the ballot, and a vetoed round reopens in place |
| `programs/epoch/src/state/index_operators.rs` | jito-tip-router `program/src/cast_vote.rs` (operators from [jito-foundation/restaking](https://github.com/jito-foundation/restaking), Apache-2.0) | MIT or Apache-2.0 | An admin-registered list of up to eight voting keys and weights instead of restaking operators, vault delegations and weight tables; ballots copy it when a round opens |

`programs/epoch/src/jito_account.rs` implements the public account layouts of
[jito-foundation/jito-programs](https://github.com/jito-foundation/jito-programs)
(`mev-programs/programs/tip-distribution/src/state.rs`, `priority-fee-distribution/src/state.rs`, Apache-2.0) in order to
read those accounts; no code is copied.

## Apache License 2.0 notice

The adapted files above are distributed under the Apache License, Version 2.0, the licence of the original work
(jito-tip-router is dual-licensed MIT or Apache-2.0; Epoch takes it under Apache-2.0). You may obtain a copy of the
licence at <https://www.apache.org/licenses/LICENSE-2.0>. Unless required by applicable law or agreed to in writing,
software distributed under the licence is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
either express or implied. The changes made are listed in the table and in each file's header.
