# epoch-sdk-vectors

Generates `../src/__fixtures__/rust-vectors.json`, the byte-exact fixtures the SDK's jest suites compare against.
It links the real program crate (`../../../programs/epoch`, `features = ["no-entrypoint"]`) and only calls the
program's own code, so the fixtures are the chain's encoding, not a re-derivation of it:

| Section | Produced with |
| --- | --- |
| `accounts` | `Discriminator`, `Space::INIT_SPACE`, `AccountSerialize::try_serialize` written over the `8 + INIT_SPACE` allocation and read back with `try_deserialize`; a `ValidatorPosition` with `open_advance: Some`, a fresh `None`, and a `Some → None` rewrite over the old bytes; ring-buffer pushes via `push_revenue` / `push_history`, plus `trailing_revenue()` and `value_for()` results |
| `instructions` | `epoch::instruction::<Name>.data()` and `epoch::accounts::<Name>.to_account_metas(None)` with PDAs from `Pubkey::find_program_address` and the program's seed constants; `Sweep` with `advance` Some and None (the None case also under the declared program id) |
| `events` | `anchor_lang::Event::data()` on every `epoch::events::*` struct |
| `pdas` | `Pubkey::find_program_address` for every seed scheme, with u64 seeds at 0, small, 2^32+, 2^53+ and `u64::MAX` |
| `errors` | `EpochError::name()`, `u32::from(e)` (Anchor's 6000 offset) and `to_string()` (the `#[msg]`) for every variant |
| `math` | `epoch::math::*` and `epoch::instructions::taker_pnl` over edge values and seeded random inputs; `null` = `None` |

Struct fields are listed through exhaustive destructuring and the error list through an exhaustive `match`, so adding
a field or a variant to the program breaks this build until the generator covers it.

## Regenerate

```bash
cd packages/epoch-sdk/vectors
cargo run --offline --release          # or: pnpm --filter @epoch/epoch-sdk vectors
cd .. && pnpm test                     # the SDK must still pass against the new fixtures
```

- The crate has its own empty `[workspace]`, so the repository's root workspace (`programs/*`) ignores it, and its
  `target/` stays here (git-ignored by `packages/epoch-sdk/.gitignore`).
- `Cargo.lock` started as a copy of the root `Cargo.lock` (Cargo trimmed it to what this crate needs), so it builds
  with `--offline` from the local cargo cache and pins the same `anchor-lang 1.2.0` dependency tree as the program.
  If the program's dependencies change, copy the root `Cargo.lock` here again before regenerating.
- The toolchain comes from the repository's `rust-toolchain.toml` (1.89). The first build takes about a minute.
- Output is deterministic (fixed program id `[42; 32]`, fixed keys `[n; 32]`, a seeded LCG for field values), so a
  diff of `rust-vectors.json` shows exactly what a program change did to the encoding.
- An optional output path can be passed as the first argument: `cargo run --offline --release -- /tmp/vectors.json`.
