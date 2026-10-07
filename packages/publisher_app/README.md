# publisher_app

Posts the Solana Fee Index on-chain (`post_index`) and runs Epoch's seeded market maker (`post_quote`,
`withdraw_quote`). One loop, every `PUBLISHER_INTERVAL_SECONDS` (60): the **IndexPublisher**, then the **QuoteMaker**.
A step that fails is logged and retried on the next tick; the loop stops cleanly on SIGINT/SIGTERM after the tick in
progress.

```bash
pnpm --filter @epoch/publisher_app build
node packages/publisher_app/dist/index.js --env .env.devnet      # or pm2 (pm2.config.js)
```

Finalizing the index and settling swaps are not done here: `cranks_app` runs `finalize_index` once a proposal's
dispute window has passed and `settle_swap` for every swap whose epoch is final.

## Epoch numbering

The Fee Index value is computed from **mainnet** slots (`indexer_app` → `epoch_index`, keyed by mainnet epoch M). The
program runs on its own cluster (devnet for now) and reads that cluster's clock: quotes are for program epochs,
`open_swap` closes when the program cluster reaches the quote's epoch, and `settle_swap` reads
`FeeIndex.value_for(quote epoch)`. So the value of mainnet epoch M is posted under program epoch P:

| `FEE_INDEX_EPOCH_OFFSET` | P | Use |
| --- | --- | --- |
| a number (default `0`) | `M + offset` | `0` when the program runs on mainnet (P = M). On devnet, see below. |
| `auto` | the program cluster's current epoch − 1 at posting time | No offset to maintain; correct as long as the publisher posts within one program epoch of M ending. |

**Choosing the offset on devnet.** Post M under the program epoch in which M **started**:
`offset = (program-cluster epoch when mainnet epoch M started) − M`. Then trading on P (which closes when P starts)
closes before M starts, and M's value is known (M ends) during P + 1, so nobody can trade on P knowing part of M's
fees. On mainnet the same rule gives offset 0. To measure it (mainnet and devnet slots are both ~400 ms):

```bash
solana epoch-info -um     # mainnet: Epoch M_now, Slot index i_m
solana epoch-info -ud     # devnet:  Epoch D_now, Slot index i_d
# M_now started i_m slots ago; devnet was then in D_now if i_d >= i_m, else in D_now - 1:
# offset = (i_d >= i_m ? D_now : D_now - 1) - M_now
```

Measured on 3 Oct 2026 (IST): mainnet epoch 1047 at slot index 413,798, devnet epoch 1173 at slot index 18,957, so
mainnet 1047 started during devnet 1172 and **`FEE_INDEX_EPOCH_OFFSET=125`** (equivalently `auto`). The brief's
alternative, "the devnet epoch in which M finished" (126 here), also works mechanically, but trading on 1173 closed
about 2 hours before mainnet 1047 ended, when about 90% of its slots were already public; avoid it. The two clusters drift
slowly, so re-check the offset now and then, or use `auto`.

Whatever the mode, the publisher never posts P before P has started on the program cluster: until then P's quotes
still trade, and the posted value would leak into open trading. In `auto` mode each program epoch takes the newest
finished mainnet epoch; if two mainnet epochs finish within one program epoch the older one is skipped, and if a
program epoch passes with no new mainnet epoch it gets no value at all (its swaps could never settle). A fixed offset
has neither problem, which is why it is the default.

## Inputs hash

`post_index(epoch, value, inputs_hash)` commits to the per-slot inputs, so anyone with the same `slot_fees` data can
recompute it: SHA-256 over

```text
"epoch-fee-index-inputs-v1"        25 ASCII bytes, no length prefix
u64 LE  mainnet epoch
for each slot_fees row of that epoch, ascending slot (52 bytes each):
  u64 LE   slot
  [u8;32]  leader identity (the base58 pubkey's raw bytes)
  u64 LE   median_cu_price (µL/CU, leader-paid transactions excluded)
  u32 LE   tx_count
```

```python
import hashlib, struct
data = b"epoch-fee-index-inputs-v1" + struct.pack("<Q", 1047)
data += struct.pack("<Q", 452304000) + bytes([7] * 32) + struct.pack("<Q", 12345) + struct.pack("<I", 678)
print(hashlib.sha256(data).hexdigest())  # 7982b9d4b3332e217dd3352d9402554bcbb48da40e4ee5ece4ac6e1a026c8a68
```

(`src/Index/InputsHash.ts`; the test pins that vector.) The hash covers the per-slot fee inputs only; the stake
weights of the stake-weighted median are the epoch's public stake distribution.

## IndexPublisher (`post_index`, PUBLISHER key)

Each tick, reading `epoch_index` rows with `posted_signature IS NULL` after the last posted one:

1. **Unrecorded post.** If the FeeIndex's pending or last final `inputs_hash` is one of the unposted epochs', the
   transaction landed but the database write did not (a crash): it finds the signature in the publisher key's recent
   history and records it, so the same mainnet epoch is never posted twice.
2. **One proposal at a time.** While a proposal is pending it waits (`post_index` would fail with
   `DisputeWindowOpen`); `cranks_app` finalizes it.
3. **Vetoed?** If its latest posted epoch is not the FeeIndex's last final value, it stops with an error. The admin
   decides: to re-post, correct `epoch_index.value` if needed and set that row's `posted_signature` to NULL; to skip,
   delete the row.
4. **Next epoch, in order.** Offset mode takes the oldest unposted epoch whose P is above the last final epoch (the
   very first post takes the newest whose P has started, instead of replaying history); `auto` takes the newest.
   Then: P must be above the last final epoch and must have started; the move from the last final value must be
   within `max_move_bps` (`|value − last| ≤ last × max_move_bps / 10,000`, skipped while the last value is 0, as in
   the program), otherwise it **stops**: the admin widens the bound with `configure_index` or corrects the row, and the
   publisher resumes on its own; the epoch must have `slot_fees` rows (no hash of nothing).
5. Sends `post_index(P, value, inputs_hash)` and records `posted_signature`.

Waits and stops are logged once, not every minute; stops are errors (`STOPPED: …`).

### Operator consensus (`cast_index_vote`, operator keys): the default once consensus is on

When the admin runs `initialize_index_operators`, the operator registry PDA becomes the FeeIndex's `publisher` and
no single key can post (`docs/FEE_INDEX_METHODOLOGY.md`, "Operator consensus"). The IndexPublisher sees that and votes
instead of posting, with every key in `INDEX_OPERATOR_KEYPAIR_PATHS` that the registry lists (without that variable,
the `PUBLISHER_KEYPAIR_PATH` key is the one voter: the devnet setup with one operator). Several keys in one process
are for the demo; in production each operator runs its own publisher, indexer and database with its own key, so the
votes are independent. Each tick:

1. **Unrecorded vote.** If one of our keys voted an unposted row's `inputs_hash` in a ballot that is voting, queued,
   proposed or agreed and final, the vote landed but the database write did not: it finds the signature in that key's
   recent history (`IndexVoteCast`) and records it. The ballots are the record, so a mainnet epoch is never voted twice.
2. **Our open ballot.** For the lowest ballot above the last final epoch that holds one of our votes: our keys that
   have not voted yet vote the same value and hash (a crash between two votes); otherwise it waits while the ballot
   is `voting` (logging agreeing weight, threshold and our deviation), `queued` (cranks_app submits it) or `proposed`
   (cranks_app finalizes it after the window), and **stops** when its proposal was vetoed. The admin decides, as in
   legacy mode: set the row's `posted_signature` to NULL (after correcting the value if needed) and every key votes
   again, which opens the next round; or delete the row.
3. **Next epoch.** The same choice of row and P, the same `max_move_bps` and `slot_fees` checks as `post_index`. Every
   registered key that has not voted in the round that counts sends `cast_index_vote(P, value, inputs_hash)` (paying
   for itself; the first vote pays the ballot's rent, refunded when `CloseBallotsJob` closes it). A key registered
   after the round opened is not in its snapshot: it stops and points at `reset_index_ballot`. The first vote's
   signature becomes the row's `posted_signature`.

TODO(F9, out of scope): a Switchboard On-Demand mirror of the final value (`docs/ARCHITECTURE.md` notes Switchboard
shut down on 25 Sep 2026, so the program is its own oracle).

## QuoteMaker (`post_quote` / `withdraw_quote`, MAKER key)

- Quotes every program epoch `current + 1 … current + QUOTE_EPOCHS_AHEAD` that has no quote from the maker:
  fixed rate = the last final Fee Index value × (10,000 + `QUOTE_SPREAD_BPS`) / 10,000, max notional
  `QUOTE_MAX_NOTIONAL_SOL`, max move `QUOTE_MAX_MOVE_BPS`, expiry slot = the first slot of that epoch (trading closes
  when the epoch starts). Only epochs after the last final index epoch (the program requires it), only once there is a
  final value, never while the pool is paused.
- Collateral per quote = max notional × max move: **10 SOL** at the defaults, 50 SOL for five epochs, plus rent. It
  checks the maker's balance first and stops quoting (warning once) when it cannot fund the next quote.
- Withdraws every one of its quotes whose epoch has started (or whose expiry slot passed) once no swap is open against
  it; the account closes and the remaining collateral comes back.

Only quotes from Epoch's maker count: set `EPOCH_MARKET_MAKER` (read by `api_app` for `/v1/market` and by
`cranks_app` for the hedged flag) to the MAKER key's public key; the publisher warns at start if they differ.

## Configuration (`PublisherConfigSchema`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `EPOCH_CLUSTER`, `EPOCH_RPC_URL`, `EPOCH_RPC_FALLBACK_URL` | devnet | the program's cluster |
| `EPOCH_PROGRAM_ID` | required | the deployed program |
| `PUBLISHER_KEYPAIR_PATH` | unset = IndexPublisher off (unless operator keys are set) | keypair FILE of the FeeIndex's `publisher`; needs `DATABASE_URL`; the one voter once consensus is on, when `INDEX_OPERATOR_KEYPAIR_PATHS` is unset |
| `INDEX_OPERATOR_KEYPAIR_PATHS` | unset | comma-separated keypair FILES of Fee Index operators (at most 8) that vote once consensus is on; needs `DATABASE_URL` |
| `MAKER_KEYPAIR_PATH` | unset = QuoteMaker off | keypair FILE of Epoch's market maker (funds the collateral) |
| `EPOCH_MARKET_MAKER` | — | the maker's public key, as the API and cranks know it |
| `DATABASE_URL` | — | Postgres with `epoch_index` and `slot_fees` |
| `PUBLISHER_CU_PRICE_MICROLAMPORTS` | 10000 | priority fee |
| `PUBLISHER_INTERVAL_SECONDS` | 60 | loop interval |
| `DRY_RUN` | false | simulate every transaction, log it, send nothing, write nothing |
| `FEE_INDEX_EPOCH_OFFSET` | 0 | a whole number or `auto` (above) |
| `QUOTE_MAX_NOTIONAL_SOL` | 50 | per quote |
| `QUOTE_MAX_MOVE_BPS` | 2000 | payoff clip and collateral rate |
| `QUOTE_EPOCHS_AHEAD` | 5 | epochs quoted ahead |
| `QUOTE_SPREAD_BPS` | 0 | −9,999 … 10,000; negative quotes below the index |

Keypairs are read from the paths at start and never logged; keep the files outside the repo.
