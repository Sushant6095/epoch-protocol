# @epoch/epoch-sdk

TypeScript client for the Epoch Anchor program (`programs/epoch`): PDAs, account and event decoders, instruction
builders, the error table and exact mirrors of the program's integer math. It is written by hand against the Rust
source and verified byte for byte against the program crate (see [Verification](#verification)).

```ts
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { accountFilters, decodeValidatorPosition, deposit, fieldFilter, solToLamports } from '@epoch/epoch-sdk';

const programId = new PublicKey(process.env.EPOCH_PROGRAM_ID!);

// Deposit 2.5 SOL into the junior tranche.
const tx = new Transaction().add(...deposit({ programId, owner: wallet, tranche: 'junior', lamports: solToLamports('2.5') }));

// Every validator position operated by `wallet`.
const accounts = await connection.getProgramAccounts(programId, {
  filters: [...accountFilters('ValidatorPosition'), fieldFilter('ValidatorPosition', 'operator', wallet)],
});
const positions = accounts.map(({ account }) => decodeValidatorPosition(account.data));
```

## Design rules

- **Browser-safe.** Plain TypeScript on `@solana/web3.js` v1 (`PublicKey`, `TransactionInstruction`, `SystemProgram`,
  `SYSVAR_CLOCK_PUBKEY`). No Anchor runtime, no Node built-ins, no `crypto`: discriminators are precomputed constants,
  Borsh, base58 and base64 are implemented in `src/borsh.ts` and `src/encoding.ts`. Nothing imports `buffer`:
  `TransactionInstruction.data` is built with web3.js's own Buffer class (Node's under Node, the npm polyfill in a
  browser bundle), so a strict bundler (esbuild/Vite) needs nothing beyond what web3.js already needs.
  `index.test.ts` enforces this; the built package bundles with `esbuild --platform=browser` and runs without
  `Buffer`/`process` globals.
- **`programId` is always an argument.** The program still declares the placeholder `11111111111111111111111111111111`,
  so nothing in the SDK hard-codes an address of the program; every PDA finder and builder takes `programId`.
- **Units.** Every `u64`/`i64` is a `bigint` (lamports, shares, epochs, slots, index values); `u8`/`u16`/`u32` are
  `number`s (bps, bumps, counts); pubkeys are `PublicKey`; byte arrays are `Uint8Array`. Lender shares are an internal
  ledger with a 1,000× virtual offset: the first deposit mints 1,000 shares per lamport, so one UI share is
  `RAW_SHARES_PER_UI_SHARE = 1e12` raw shares and is worth 1.0 SOL at par. `share_price_e9` (events, `sharePriceE9`)
  is lamports per raw share × 1e9, so par is 1,000,000; `sharePriceE9ToSol` and `rawSharesToUi` convert for display.
  `solToLamports('0.1') === 100000000n` uses exact decimal arithmetic and throws on more than 9 decimals;
  `lamportsToSolString` is its exact inverse.
- **Enums** use string unions: `Tranche` (`'senior' | 'junior'`), `Side` (`'payFixed' | 'receiveFixed'`, Rust
  `PayFixed = 0`), `PositionStatus`, `AdvanceState`. `TRANCHES`, `SIDES`, `POSITION_STATUSES`, `ADVANCE_STATES` list
  the variants in Borsh order.

## What is exported

| Area | Exports |
| --- | --- |
| Constants | `SEEDS`, `VOTE_PROGRAM_ID`, `PROGRAM_CONSTANTS`, `RAW_SHARES_PER_UI_SHARE`, `sharePriceE9ToSol`, `rawSharesToUi`, `COMMISSION_KIND`, enum types and variant lists |
| PDAs | `findPoolPda`, `findVaultPda`, `findLenderPda`, `findWithdrawRequestPda`, `findPositionPda`, `findVoteAuthPda`, `findEscrowPda`, `findAdvancePda`, `findFeeIndexPda`, `findQuotePda`, `findSwapPda` — each returns `[PublicKey, bump]` |
| Accounts | Types for all 8 accounts; `decodePool`, `decodeLenderShares`, `decodeWithdrawRequest`, `decodeValidatorPosition`, `decodeAdvance`, `decodeFeeIndex`, `decodeFeeQuote`, `decodeSwapPosition`, `decodeAccount`; `ACCOUNT_DISCRIMINATORS`, `ACCOUNT_SIZES`, `FIELD_OFFSETS`, `accountFilters`, `fieldFilter`; `feeIndexHistory`, `feeIndexValueFor`, `revenueHistory`, `trailingRevenue` |
| Events | `EpochEvent` (union of all 26, discriminated by `name`), `EpochEventMap`, `EVENT_DISCRIMINATORS`, `decodeEvent`, `parseEventsFromLogs`, `eventToJson` |
| Instructions | A builder per instruction (29) plus `onboardWithBond` and `openSwaps`; `INSTRUCTION_DISCRIMINATORS`; `solToLamports`, `lamportsToSolString`; input types (`DepositInput`, …) |
| Errors | `EPOCH_ERRORS` (54, code 6000 + declaration index, `#[msg]` verbatim), `epochErrorFromCode`, `parseEpochError` |
| Math | `bpsOf`, `bpsOfCeil`, `mulDiv`, `assetsToShares`, `sharesToAssets`, `sharePriceE9`, `creditLimit`, `splitSweep`, `attributeRepayment`, `distributeIncome`, `juniorRatioBps`, `absorbLoss`, `takerPnl`, `swapCollateral`, `computeScore`, `EpochMathError` |
| Discriminator lookups | `accountNameOf`, `instructionNameOf`, `eventNameOf`, `ACCOUNT_NAMES`, `INSTRUCTION_NAMES`, `EVENT_NAMES` |
| Encodings | `base58Encode`, `base58Decode`, `base64Encode`, `base64Decode`, `bytesToHex`, `hexToBytes` |

## Instructions

Every builder returns `TransactionInstruction[]` (usually one element) with the accounts in the exact order of the
Rust `#[derive(Accounts)]` struct, the same signer/`mut` flags, and `data = discriminator ++ borsh(args)`. PDAs are
derived for you; pass the values the program uses as seeds when they are not derivable:

- `requestWithdraw({ …, withdrawTail })`: `pool.withdraw_tail` at send time (the new request's `seq`).
- `requestAdvance({ …, advanceSeq })`: `position.advance_seq` at send time.
- `cancelWithdraw` / `processWithdrawal({ …, seq, tranche })`: the request's `seq` and tranche.
- `withdrawQuote({ maker, epoch })`, `openSwap({ quote })`, `settleSwap({ quote, taker })`.

**Optional accounts.** `Sweep.advance` is an `Option<Account<Advance>>`. Anchor 1.2 reads an optional account as
`None` when its key equals the executing program's id (`anchor-lang` `accounts/option.rs`), so `sweep({ openAdvance:
null })` passes `programId` (read-only, non-signer) in that slot, and a present advance is passed writable. Note that
Anchor's generated *Rust* client fills the slot with the compile-time `declare_id!` instead; the SDK uses the
`programId` you pass, which is what the program compares against.

`onboardWithBond` returns `[onboard_validator, set_collectors (cranker = operator), post_bond]` for one transaction
(`bondLamports: 0n` omits `post_bond`; `setCollectors: false` omits `set_collectors` on clusters where SIMD-0232
collectors are not active yet). `openSwaps` returns one `open_swap` per leg (e.g. a five-epoch hedge).

## Accounts

Decoders check the 8-byte discriminator, then read Borsh sequentially, like Anchor's `try_deserialize`; they throw on
a wrong discriminator, short data, or a bool/Option/enum byte Borsh would reject. `decodeAccount` returns `null` for
an unknown discriminator.

`ValidatorPosition.open_advance` is an `Option<Pubkey>`. The account is allocated at its maximum size (415 bytes),
but when the option is `None` it serializes to one byte, every later field moves 32 bytes earlier, and the tail keeps
stale bytes from earlier writes. Decoding is therefore sequential, and only the pubkey fields before that option are
offered as memcmp filters:

| Account | Size | `FIELD_OFFSETS` |
| --- | --- | --- |
| Pool | 374 | — |
| LenderShares | 130 | pool 8, owner 40 |
| WithdrawRequest | 115 | pool 8, owner 40 |
| ValidatorPosition | 415 | pool 8, vote 40, operator 104 |
| Advance | 196 | pool 8, vote 40 |
| FeeIndex | 486 | — |
| FeeQuote | 151 | pool 8, maker 40 |
| SwapPosition | 133 | quote 8, taker 40 |

`accountFilters(name)` gives `[memcmp(discriminator) at 0, dataSize]`; `fieldFilter(name, field, key)` adds a memcmp
on one of the fields above and throws for anything else. Ring buffers come back raw (`revenue`, `history`);
`revenueHistory` / `feeIndexHistory` return the filled entries oldest → newest, and `trailingRevenue` /
`feeIndexValueFor` mirror `ValidatorPosition::trailing_revenue` and `FeeIndex::value_for` exactly.

## Events and errors

```ts
const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
for (const event of parseEventsFromLogs(tx?.meta?.logMessages ?? [], programId)) {
  if (event.name === 'Swept') console.log(event.data.gross); // narrowed by name
  console.log(eventToJson(event)); // pubkeys base58, bigints decimal strings, bytes hex
}
```

`parseEventsFromLogs` tracks the invocation stack (`invoke [n]` / `success` / `failed`) and decodes only
`Program data:` lines written while the Epoch program is the innermost frame, so data logged by programs it calls,
or that call it, is ignored.

`parseEpochError(error)` returns `{ code, name, message }` for an Epoch error found in a `TransactionError`
(`{ InstructionError: [i, { Custom: n }] }`), a confirmation or simulation result, web3.js's `SendTransactionError`
(logs or message), Anchor's `Error Code: X. Error Number: N.` log line, `custom program error: 0x…`, an RPC error
object or a plain string, and `undefined` otherwise (system program and Anchor framework errors included).

## Math

`src/math.ts` mirrors `programs/epoch/src/math/*.rs` and `taker_pnl` in `swap.rs` with `bigint`: the same u128 / i128
intermediates, rounding (floor, `bps_of_ceil`, i128 division truncating toward zero) and overflow points. Where the
Rust function returns `None` (the program fails with `MathOverflow`) the mirror throws `EpochMathError`; arguments the
Rust types cannot hold (a negative amount, a u16 above 65,535) throw `RangeError`/`TypeError`.

## Verification

`vectors/` is a small Rust binary that depends on the program crate (`features = ["no-entrypoint"]`) and writes
`src/__fixtures__/rust-vectors.json` using the program's own code: `AccountSerialize::try_serialize` for every account
(including a `ValidatorPosition` rewritten from `Some` to `None` over its old bytes), `InstructionData` and
`ToAccountMetas` for every instruction, `Event::data` for every event, `Pubkey::find_program_address` for every seed
scheme, `EpochError` codes and messages, and the `epoch::math` functions and `taker_pnl` over edge and random inputs.
The jest suites assert that decoders reproduce every field, builders produce identical data bytes and account metas,
events, PDAs and the error table match, and every math case agrees (including the `None` cases).
`discriminators.test.ts` recomputes all discriminators with SHA-256.

Regenerate after any program change (Rust 1.89 toolchain from `rust-toolchain.toml`; offline, from the local cargo
cache):

```bash
pnpm --filter @epoch/epoch-sdk vectors     # = cargo run --offline --release --manifest-path vectors/Cargo.toml
pnpm --filter @epoch/epoch-sdk test
```

See [`vectors/README.md`](vectors/README.md) for details.

The test files stub `rpc-websockets` with `jest.mock(…, { virtual: true })`: web3.js loads it at import time and it
pulls in an ESM-only `uuid` that jest's CommonJS runtime cannot parse. The SDK never opens a websocket; everything else
in the tests is the real web3.js.
