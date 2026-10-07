# Third-party notices

Code in this repository (outside `app/`, which has its own `app/THIRD-PARTY-NOTICES.md`) that was adapted from
third-party source. Crates and npm packages used as dependencies keep their own licences. Each adapted file says so
in its header.

| Our file | Adapted from | Licence | What changed |
| --- | --- | --- | --- |
| `programs/epoch/tests/litesvm/src/lib.rs`, `context.rs`, `setup.rs` | [jito-foundation/stakenet](https://github.com/jito-foundation/stakenet) `tests/src/steward_fixtures.rs` (`TestFixture`, `advance_num_epochs`, `submit_transaction_assert_error`); [jito-foundation/jito-tip-router](https://github.com/jito-foundation/jito-tip-router) `integration_tests/tests/fixtures/test_builder.rs` and `mod.rs` (`TestBuilder`, per-program clients, `assert_ix_error`) | Apache-2.0 | The fixture/builder split and per-instruction helpers, rewritten for LiteSVM (synchronous, no `solana-program-test`, BanksClient or tokio); Anchor-typed events and error codes; one epoch warp that keeps `Clock` consistent; instruction builders from the program's own Anchor types instead of hand-written account lists |
