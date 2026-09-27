# Epoch program

Anchor 1.2 program. An Epoch PDA holds each onboarded validator's vote-account
withdraw authority; advances are repaid at source every epoch; lenders fund
them through senior and junior tranches; the program publishes the Solana Fee
Index and settles fee swaps against it.

## Layout

| Path | What lives there |
| --- | --- |
| `src/lib.rs` | Dispatch only |
| `src/state/` | One account per file: `Pool`, `LenderShares`, `WithdrawRequest`, `ValidatorPosition`, `Advance`, `FeeIndex`, `FeeQuote`, `SwapPosition` |
| `src/math/` | Pure arithmetic with unit tests: tranche shares with virtual offsets, sweep and income waterfalls, credit limit, Epoch Score |
| `src/vote_account.rs` | Reads the head of a vote account (v1.14.11, v3, v4) without deserialising the tower; layout pinned by tests against `solana-vote-interface` |
| `src/cpi/vote.rs` | Vote-program instruction encoders, byte-for-byte checked against the upstream crate in tests |
| `src/cpi/system.rs` | Lamport transfers out of program-derived system accounts |
| `src/instructions/` | One file per instruction, grouped: `pool/`, `credit/`, `market/` |
| `src/events.rs` | One event per state change; the indexer replays these |

## Build phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation: state, math, vote reader, CPI encoders, admin instructions | done |
| 2 | Pool: deposit, FIFO withdrawal queue (request, cancel, process), epoch accrual with senior→junior waterfall | done |
| 3 | Credit: onboard (one-tx authority handover), collectors, score, bonds, advance, sweep, default with bond-first write-off and 100% recovery, release, covenant-gated commission and identity changes | done |
| 4 | Fee Index (propose → dispute window → finalize, bounded moves, admin veto, 16-epoch history) and fee swaps (maker quotes, bounded payoff, permissionless settlement) | done |
| 5 | LiteSVM epoch-warp tests, fuzzing, invariants, program keys, IDL to `epoch-sdk`, devnet | next |

## Invariants

- `senior_assets + junior_assets + income_unallocated == cash + outstanding_principal` after every instruction (`Pool::assert_ledger`).
- The vault always holds `cash + bond_total + rent`.
- A sweep never takes the vote account below rent + pending delegator rewards + the admission-ticket reserve.
- Rounding favours the pool: deposits mint fewer shares, redemptions pay fewer lamports.

## Commands

```bash
cargo test -p epoch                          # unit tests
cargo clippy -p epoch --all-targets -- -D warnings
anchor build                                 # needs the Solana toolchain
```
