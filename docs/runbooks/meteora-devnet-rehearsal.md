# Meteora launch rehearsal (devnet stand-in)

A full lifecycle of one revenue token, end to end, with the code in this repo: the launch CLI, trades through the
Launch page's API (`POST /quote` + `POST /build`, signed by test wallets), graduation, the permissionless migration to
DAMM v2, trades on DAMM v2, and every claim through the fee-claim job. Run on 3 Oct 2026, 18:08–19:47 IST, and again
after a restart on 4 Oct 2026, 09:36–09:47 IST. Times below are IST.

[Part 2](#9-part-2-the-launch-with-the-epoch-program) (4 Oct 2026, 11:43–11:50 IST) ran the launch against the merged
Epoch program: the treasury PDA as fee claimer and leftover receiver, and `register_revenue_token` signed by the
validator's operator.

[Round 2](#10-round-2-the-whole-loop-through-the-program-5-oct-2026) (5 Oct 2026, 22:45–22:52 IST) ran the whole loop
through the program on a fresh stand-in: launch, trades, graduation, a sweep, buyback slices and the treasury's claims.
Every Launch endpoint, the activity feed and the WS frames were checked against the chain: 46 of 46 checks passed.

**Where:** the public devnet faucet refused every airdrop, so the rehearsal ran on a local `solana-test-validator`
loaded with **Meteora's mainnet program binaries** (DBC, DAMM v2, Metaplex token metadata) and the DAMM v2 migration
configs, dumped from mainnet. That is closer to the mainnet launch than devnet would have been: devnet runs different
builds of DBC and DAMM v2 (below). Explorer links use the explorer's custom-cluster mode, so they only open while that
local validator runs (`?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A38899`).

The recorded transactions and accounts are test fixtures in `packages/meteora/src/__fixtures__/rehearsal/`.

## 1. Devnet faucet: refused

| When (IST) | Request                                  | Answer                                                                                    |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| 18:08:48   | `requestAirdrop` 0.5 SOL → launcher       | `429` "You've either reached your airdrop limit today or the airdrop faucet has run dry" |
| 18:08:56   | 0.5 SOL → trader 1                        | same                                                                                      |
| 18:09:04–18:09:28 | two more rounds, 8 s apart          | same                                                                                      |

The web faucet (faucet.solana.com) was not an option: this run creates no accounts and uses no sign-ins. Fallback: a
local stand-in.

## 2. The local stand-in

```bash
S=<scratch>/agent-mlaunch
solana program dump -u m dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN $S/clone/dbc.so
solana program dump -u m cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG $S/clone/cpamm.so
solana program dump -u m metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s $S/clone/metaplex.so
# the 7 DAMM v2 configs DBC graduates into (DAMM_V2_MIGRATION_FEE_ADDRESS), as JSON accounts
solana account -u m <config> --output json > $S/clone/damm-config-<config>.json
$S/start-validator.sh      # solana-test-validator 4.3.0 (Agave): --bpf-program × 3, --account × 7,
                           # RPC 127.0.0.1:38899, faucet 39900, gossip 38000, --limit-ledger-size 200000
```

| Program                                         | Mainnet build (used here)          | Devnet build                        |
| ----------------------------------------------- | ---------------------------------- | ----------------------------------- |
| DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | slot 445,503,633 · 2,326,577 bytes | slot 503,167,099 · 1,983,568 bytes  |
| DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | slot 445,230,614 · 2,174,352 bytes | slot 503,166,267 · 1,559,448 bytes |
| Metaplex `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | slot 380,725,176 · 793,991 bytes (immutable) | —                         |

Throwaway keypairs live in the scratch folder only (never in the repo), funded from the local faucet:

| Role                                     | Address                                        |
| ---------------------------------------- | ---------------------------------------------- |
| Launch payer (first pool creator)        | `GnNyB2cCmfLekJecobs1g5evzgEgh3jDb9TUiyZFKfkq` |
| Epoch treasury (partner, fee claimer, leftover receiver; `rREH` only, a plain wallet: part 2 uses the program's treasury PDA) | `AQ3gcCLTPwTHsBhNBTFz94L2kxKevZuywYWobx9H9Mf8` |
| Validator wallet (pool creator after hand-over) | `GjMZo48qTs7nuowtcPYj7K6vtsMiXJbRUePgmK6RF1c1` |
| Trader 1 · 2 · 3                          | `6MTBgCMiLQLbXrMXmWa172Hv2hE2q1wANkfPZD2QMTA5` · `9aWtdiPTKM8mpY88oABQnfyzXXxDNPjaMNpQRaS529Hn` · `CuioAkwCMnBr7gb4wCSqFi9baBEkpv6uj4VuyHwhqaWu` |

Meteora's pool authorities were funded with 5 SOL each, as they are on mainnet and devnet (see Surprises):
DBC `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`, DAMM v2 `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC`.

## 3. Launch (`pnpm --filter @epoch/meteora launch`)

Config (`rehearsal-launch.json`): `rREH`, 5% of the commission of mainnet vote account
`FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk` for 10 epochs, 1,000,000 tokens (6 decimals), raise target 0.75 SOL,
curve fee 100 bps, DAMM v2 fee 100 bps, an initial buy of 0.02 SOL, `creator` = the validator wallet.

```bash
LAUNCH_KEYPAIR_PATH=$S/keys/launcher.json EPOCH_TREASURY=AQ3g…9Mf8 LAUNCHES_PATH=$S/rehearsal/registry.json \
pnpm --filter @epoch/meteora launch -- --config $S/rehearsal/rehearsal-launch.json --cluster devnet \
  --rpc http://127.0.0.1:38899 --allow-unknown-genesis            # dry run, twice
… --execute --yes                                                 # 18:42 IST
```

Revenue read from mainnet (public RPC, rate-limited: retried on 429): inflation commission (`getInflationReward`,
exact), block revenue (leader slots from `getLeaderSchedule`, 6 sampled `getBlock` per epoch; the public RPC no longer
has the leader schedule of epochs 1038–1039), Jito MEV commission (Kobe API). Average **6.820714 SOL an epoch**
(inflation 1.728801 + blocks 4.92515 + MEV 0.166763) → share revenue **0.341036 SOL an epoch** → share value 3.4104 SOL
→ 0.00000341036 SOL a token → curve band 0.00000204621 (60%) to 0.00000323984 (95%), sqrt prices
834440317571969274 → 1049981040630518967 (Q64.64). Raise 0.75 SOL; supply 291,289 on the curve, ≈69,448 for the DAMM
v2 seed, 639,263 leftover.

| Step              | Signature                                                                                   | Payer cost        |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------- |
| `createConfig`    | `RTEHXybzL3QXHr6P6rx1MEHSemVSmENBPLLtcFbrujenCTSuj9KNguZjWNGwjY57SZ24yoJdW623ZjpUuTT9J5P`   | 0.00819496 SOL    |
| `createPool` + first buy 0.02 SOL | `2hadiQ4cAwJcW2U89Ln4WoJgkaCgniWAGWLuN6beHLSyMcLwngnFRwFBWX7kpc4pD25a6bNuJuKbPJnUznpBfhWY` | 0.04654696 SOL (0.02 buy, 0.00203928 the buyer's token account) |
| `transferPoolCreator` → validator | `3LnZVGTA1EvPTK18KbtYZkAVcVnXMxyU2bDStwz2en9z5hY5FTEHahabG65sN17EjbSJziKFg4YkiJntjX1mjfDd` | 0.000005 SOL |
| **Total**         |                                                                                             | **0.05474692 SOL** (≈ 0.0327 without the first buy) |

| Account                   | Address                                        |
| ------------------------- | ---------------------------------------------- |
| Mint `rREH`               | `2gg2Sun6S8EoJq2E9QjrjPf9bENzrveDGCvP9CHM7Tby` |
| DBC config                | `3kZTyWpdohzCLo14rbqDGBWTh3CFcRvkQswxyJFUvWBJ` |
| DBC pool                  | `FHoX5HBgmWG9x4z95zjmidM9jGVWUjbQ5poaMHZ9HfE1` |
| Curve vaults (token, SOL) | `6bRDSFxaXs3BVy9j9jL3r4QcJ1gcboLK5WeFf48aXHU1`, `7oPLC1zAc2xs9Q5nSJAyWZyxfRQ1MYKugwYQiehQByKN` |
| Token metadata            | `FBjd2G4dk7Rhtz1B4GCfXUgJ7Asu55XBm4QUA2P6WtuN` |

Verification after the launch (the CLI reads it back): partner = treasury, leftover receiver = treasury, pool creator =
validator, threshold 0.750000386 SOL, migration fee 70% with creator share 100%, DAMM v2 LP 100% locked with the
partner, fixed supply 1,000,000, no mint authority, no freeze authority, metadata `is_mutable = false` with update
authority `11111111111111111111111111111111`, name and symbol: all **PASS**; every transaction finalized. The launch
record (public keys and signatures only) went to `LAUNCHES_PATH`.

## 4. Trades on the curve (through the API, as the Launch page does)

API on port 47110 with `LAUNCHES_PATH`, `LAUNCH_RPC_URL=http://127.0.0.1:38899`, Postgres `epoch_test_mlaunch`.
`pnpm --filter @epoch/meteora rehearse -- trade --api http://127.0.0.1:47110 --wallet <trader> --side … --amount …`:
quote, build (`consent: true`), sign with the test wallet, send.

| When  | Trade                        | Signature                                                                                   | Quote → result                                                             |
| ----- | ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 19:07 | trader 1 buys 0.2 SOL        | `P2r3JR57VBGMCntNMaGpGYo5gCiG915M12yNf9C3bq78ByEF6vSaAhAsFEwXZommPWPyYJvxEAgkX947QxHdu9n`   | 89,402.418317 tokens, impact 6.77%, fee 0.002 SOL                          |
| 19:08 | trader 2 buys 0.15 SOL       | `4eNgFtUFvSWc63PqCXBaKEr1EbtQSrD6qqq6mUhJfYzYKUxiCrCafyJzjgQX8fPnhgNHvR8n2LxWXmkqJrDYzpZF`   | 59,946.428903 tokens                                                       |
| 19:08 | trader 1 sells 30,000 tokens | `22sfkw6Bqv8hBTnYRwX4kctFZw3WdhtwVEpaZDMPr5j2f8h9u2hYkRgqg39FMGWMNSFfY16prA48mZEAVUT2k3EA`   | 0.075281111 SOL after a 0.000760416 SOL fee                                |
| 19:08 | trader 3 buys 0.6 SOL        | `3QnwyUkzdN8fq6z4ttDSsJXPyveMCrCSdH3iPH6V9Z66ke4CkmbLjKVjaRTdBacSjZnCY4RuhvUPSJiUQx1FGyav`   | **completes the raise**: only 0.464385772 SOL used (PartialFill), reserve 0.750000387 SOL |

WS `launch:<mint>` pushed each trade, then the market (`state curve → complete`, `venue dbc → null`), and a `fee`
frame `curveComplete` (0.750000387 SOL, 708,710.925708 tokens left in the curve).

## 5. Graduation: migration to DAMM v2

No migrator runs on a local validator, so after a 30 s wait `rehearse migrate` sent the permissionless
`migrateToDammV2` itself (on mainnet and devnet Meteora's migrator does it within minutes):

| Step                         | Signature                                                                                   | Payer cost     |
| ---------------------------- | ------------------------------------------------------------------------------------------- | -------------- |
| `migrateToDammV2` (19:10)    | `3StAiDQNbSBo9SWy4MPPDYzn27UR3G3g4jUvAqdEGYubif3oWZ1iVZwKDGDtSoo8qLZYQkS5HG4B5xpjE8qFCcri`   | 0.02262108 SOL |

DAMM v2 pool `849LsiGbYgC9vRSMiMi3SKrT7C3D3dYPCYX1HD1cGokj` (config `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`),
seeded with 0.224550116 SOL + 69,309.029363 tokens at the migration price 0.00000323984; position
`Aw6zrpyw47WSTHZ5xBKqdKP2Qy8faJEX2bH4uQSUjNzY` owned by the treasury, **100% permanently locked**
(`EvtPermanentLockPosition`). The ingester learned the pool from `EvtInitializePool` and started reading it; WS sent
`fee: dammPoolCreated`.

## 6. Trades on DAMM v2

| When  | Trade                          | Signature                                                                                   | Result                                    |
| ----- | ------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 19:10 | trader 2 buys 0.1 SOL          | `2BbeEkGz5TGgU8J2vczBaqW31v1HmEsM3GCfRGsjfUxzbj3JzMyhfpjHEqy6wKteQS4Z4GsWr4j74harqdThYExX`   | 21,207.205771 tokens, impact 44%          |
| 19:10 | trader 3 sells 50,000 tokens   | `5peHujVnzefbTM11oDXgiGbp2jCRGje3KeWdZ7CikXg2cFy1TP3FaM6scqavtdzxxbvaQbRYr6doFxajueWRSfbo`   | 0.162926566 SOL                           |
| 19:10 | trader 1 buys 0.05 SOL         | `5XoMzRAivewoMTAJRebgspoH8CRhnYGKNx95qkQDeukxe9P2GStqxz3VdyxvSt9DvjCtwMFQT7JT2fcy5rXDyifc`   | 23,294.177937 tokens                      |

The API switched the venue by itself (quotes say `"venue": "damm-v2"`).

## 7. Claims (`cranks_app` `LaunchFeeClaimJob`, `node dist/launch-claims.js --once`)

| Run               | Result                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Dry run, no keys  | 2 claims simulated OK and logged, nothing sent: partner trading fee 0.00728342 SOL, creator migration fee 0.52500027 SOL |
| With keys (19:11) | 4 claims sent (below)                                                                           |
| Again             | nothing to claim (idempotent: each one-shot withdrawal is flagged on the pool)                  |

| Claim                                   | Signer → receiver         | Signature                                                                                   | Amount                    |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| Partner trading fees (curve)            | treasury → treasury       | `4SoGHp34nQGc7hyYpBAqhm9awJ8ShcEU45uK2ALWgrsbUnL23Rg9GRYzT2uKQqWFBazDpjCXuToBp8HEimb92HV8`   | 0.00728342 SOL            |
| Creator migration fee (the 70%)         | validator → validator     | `3f35E7FznPXTAyickGWua4xJpicDkcnuXBJdCsonET1yuooMMAWztC9Yiks5ravjKf8m169og2gYTdrtYhYpNPuK`   | 0.52500027 SOL            |
| Leftover (opt-in kind)                  | treasury (anyone) → treasury | `4e5Kfe54otZhsmSCTnTGNYRH9ggRUjahr8UAzBfKGUv6L1dTPGLKiqSmJXjQ1v8KivifRnv5j1g74xn6PkSwJcxy` | 639,263.000567 tokens     |
| Locked LP position fees (DAMM v2)       | treasury → treasury       | `3jwxeMW7MEBSffjn4kUeqwxbm4RFxrA1R3jYHZGq6rADcw8tgb1xYcihJpiggwgfPc68bmqphae632SD1bkdyyND`   | 0.002862904 SOL           |

Each claim cost 0.000005 SOL; the first partner claim also created the treasury's token account for `rREH`
(0.00203928 SOL), because DBC pays partner fees in both tokens. After the claims, the LP position still reads 100%
locked (`permanentLockedLiquidity` = its whole liquidity, `unlockedLiquidity` 0) and keeps earning fees.

## 8. Day 2: after a container restart (4 Oct, 09:36–09:47 IST)

Every process had stopped. `start-validator.sh` resumed the ledger (slot 4,483) with the state intact; the API restarted
from its Postgres cursors and read only what was new.

| Step                               | Signature                                                                                   | Result                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| trader 3 buys 0.03 SOL (API path)  | `5jrzHEKToeyKmg7H5hn4CjJTfuVFxkhmusFLD7YoLqNcJoH9LJ7tmXgY7SpTqtk4SCoJRYPqcu1RADmas7vfNkHE`   | 9,328.739549 tokens (DAMM v2) |
| trader 2 sells 10,000 tokens       | `5Dxhu7YRuVYK9aVBoxnouKu7xTMD4mH5UPvhCKZ9adKm17ViKVymLqnFMxvhSxdHNe27BonDB4EokxWhQ56FnZ9t`   | 0.031112399 SOL              |
| trader 1 buys 0.02 SOL             | `3TJYznw4kJyrC5UEZfAwQdP9Ax8mkudomjK7mTQi3ko9jXhsQGXdvq6kHKDHiKEyUPKMbearFHEEw3ukiHV6ePu9`   | WS: `snapshot`, `trade`, `market` |
| Claim job: LP fees (min 0)         | `5VHNHcgvx5rrXLNYtK5AWHxYsNGTqFvbMUURG3A2ruWr8wkVcGxfQYCPhVZxGeXotj8U4pzuiZw15ZKkXPynoHB7`   | 0.000750739 SOL to the treasury; a second run claimed nothing |

`GET /fees` then showed the LP position's claimed total 0.003613643 SOL and `toLenders.claimedSol` 0.010897063 SOL.
The `rREH` example responses in [docs/pages/launch.md](../pages/launch.md) come from this run.

## 9. Part 2: the launch with the Epoch program

4 Oct 2026, 11:43–11:50 IST, on the same stand-in (resumed ledger), with the code of this branch.

- **What changed.** The launch CLI derives the Epoch program's treasury PDA `["treasury", pool]` from
  `EPOCH_PROGRAM_ID` and makes it the DBC fee claimer and the leftover receiver.
- **New checks.** Before anything is sent, it checks the program, the Pool, the terms and the validator's position.
- **Registration.** It ends with `register_revenue_token`, signed by the validator's operator, or prints what the
  operator signs.

### The program on the stand-in

The merged `programs/epoch` was built with `cargo build-sbf` (platform-tools v1.57) in a scratch copy, with
`declare_id!` set to a throwaway program id. The repo's id is untouched. The `.so` is 820,832 bytes; `solana program
deploy` landed at slot 4,960 (5.714 SOL of program-data rent). Setup used the SDK's builders from scratch scripts:

| Step | Signature | Result |
| --- | --- | --- |
| `initialize_pool` | `2YDoxky8synTNDTcJcw15uZDMVWBcJqHV8XPVa6esRGAwpqRmFnRqLSNSLjXtSwCw3L8ZrEopMCbHMvDis1epeAb` | Pool `4jMRj2Bz3gfjEbE7y55bW7rx14KL6uJjtHqfHoNzdJoj`, treasury PDA `CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP` |
| Validator 1: vote account `F8bkJtsc9HhPj9spAQXzGaVYUCtdUMwZVevSvR68d3jB` (withdrawer: its operator), vote floor funded | `3vsj5Pw2q1wyYgx6yMaVGQsrm9FGRXGU6mCo7QjaSXyArqKMPXyBRZGaSnkP6MQyN3DfKAaGotadTavJfN5kgoY9` | identity `9dg1t573kr9qF2KhqmQmNLqMRN1zYcrv2htLtdvNGY9e` |
| `onboard_with_bond` (with collectors) | `5yvrW8wEtqusHF6az5XaYDnMwKsjtgDRa8bnmQm6BZN1Za2QjrgKZEL9G2zWkaTLedFho55eoEWgX86J1ncC8QDq` | position `EYixcxJ5WPQcHawNzzTjkgUYwmBb19aaFArVpPoityWX` Active, operator `3Wg6vJYo9jz881tVExLZdBh9x72ZPSUZTwmf5wWANCVJ` |
| Validator 2: vote account `BztUNanbPuuxEsqFDfoSWs59FnEvnVj7J26HMoYJnob8`, vote floor funded | `5aKJgNtsfmXPZWbJJCPC4ga5WZtfqKK2gy1wRLrawCvQkpDzMYW5sVzhwnGnbW6KPn6dCstWg1UTzQKJ9UCccprG` | identity `5xcNpELoWSG7o2k5eZLDBfrjhSgfLk9UbDLFp5QTd1Hf` |
| `onboard_with_bond` | `md5PqG3QUVLe7sqeW2pPgnENgw2bQ8kynyX6uLenikLmP8SLoPzR9fQhAT8hAyBLzygUZLQZ4LDQtJJvRYA62ax` | position `FFxhtviiiqa8KhieEM8h31it8fneHiGTFZK6DpDeo2Xt` Active, operator `EofAhUV9KtKTNoQ47iCUbqq4mpTsRpCovWP2rxqm8ted` |

### `rLOC`: launched and registered in one run (the operator's key loaded)

The config: `rLOC`, 5% for 10 epochs, 1,000,000 tokens. Revenue is 1.895564 SOL an epoch, given in the config because the
vote account is not on mainnet. Raise 0.5 SOL, a first buy of 0.02 SOL, and `creator` = the operator's wallet.

```bash
LAUNCH_KEYPAIR_PATH=$S/keys/launcher.json LAUNCH_OPERATOR_KEYPAIR_PATH=$S/keys/epoch-operator.json \
EPOCH_PROGRAM_ID=HQRKb1MYw1JHbLVYoLke5bNuL4zJJ5VQFAzigdNn8Jff LAUNCHES_PATH=$S/rehearsal/registry.json \
pnpm --filter @epoch/meteora launch -- --config $S/e2e/launch-program.json --cluster devnet \
  --rpc http://127.0.0.1:38899 --allow-unknown-genesis --skip-uri-check     # dry run (11:45)
… --execute --yes                                                           # 11:46
```

The dry run's new lines:

- `Epoch program HQRK…Jff · Pool 4jMR…oJoj · treasury PDA CgSS…1ECP (fee claimer and leftover receiver)`;
- the registration it will send, account by account, with the data (`1JmFMKRLgyr0AQoA` = the discriminator, 500, 10);
- the cost line `Registration rent (the operator pays) 0.00732192 SOL`.

The pre-flight added these checks, all **PASS**:

| Check | Detail |
| --- | --- |
| Epoch program | deployed |
| Epoch Pool | `4jMR…oJoj` (not paused) |
| Partner (treasury PDA) | `CgSS…1ECP` = `["treasury", pool]`: the fee claimer `register_revenue_token` requires |
| Leftover receiver | the treasury PDA (the program burns the unsold supply) |
| Terms (register_revenue_token) | 500 bps of gross revenue for 10 epochs |
| Validator position | `EYix…tyWX`: Active, operator `3Wg6…CVJ` |
| Start epoch | 1 (the epoch after registration) |

| Step | Signature |
| --- | --- |
| `createConfig` | `5LnHb48YPyMGty6o914vE86FJYoCwsSN2VxWrAiZbi8GszZDMsXPRhpSYgDdLAp3NpxNDVRxTvcf14o9ddiVD6cX` |
| `createPool` + first buy 0.02 SOL | `2dGxYtEpMUjMZ9XLP56oXS8r4P91AZRPANKwYY529eVBBBPTXYLdG4NA2x9koa72u2httfB2q5rUGeJWwbp15Po7` |
| `transferPoolCreator` → the validator | `EkZdzx1oZHwrES5qM5vKR9e5fSF9cz4ub8C4dPpC6RK1C9D3H4gJhJtCrv8Mo3qnU4zAPeKyTqsHdy2yL7X5aG5` |
| `register_revenue_token(500, 10)`, signed by the operator | `2UFYzk34LV5GinVdMGKKGFzggfjzbQVzY696MmCXajwUWmBLHyVDhWQ6TvgyAXde9AL7xFzXto8nceWKqPDifgqq` |

| Account | Address |
| --- | --- |
| Mint `rLOC` | `G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq` |
| DBC config · pool | `7gs7DvMjnzPxGEFGLbHrtCqSGbvV4R6Resb68C2npsWf` · `AYr4ALrNGSqnxCFuv52NKBfhtXFeQi197bktKEH9NsVp` |
| `RevenueToken` `["revenue_token", vote]` | `3mbboR1eVR4EdUtt64sMMpT4NGe9a466cRdgRZDyLeTd`: epochs 1–10, registered in epoch 0, commission floors 500 / 1,000 bps |
| Buyback escrow `["buyback", vote]` | `9wjpf4Uw2w1BQ3SC3mygBz7tUDNi7Fwpu4WRSAL9PHva` |

The read-back verification passed every check, including `partner = Epoch treasury PDA` and `leftover receiver` (the
PDA). The launch record gained `programId`, `revenueToken`, `escrow`, `registeredEpoch: 0` and
`signatures.registerRevenueToken`. Every transaction finalized.

### A wrong `EPOCH_TREASURY` is refused

With `EPOCH_TREASURY=AQ3g…9Mf8` (the part 1 wallet), the CLI stopped before reading anything else, with exit 1:

```
EPOCH_TREASURY is AQ3gcCLTPwTHsBhNBTFz94L2kxKevZuywYWobx9H9Mf8, but the fee claimer must be the Epoch program's treasury PDA CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP (["treasury", pool]): register_revenue_token refuses any other. Unset EPOCH_TREASURY or set it to the PDA.
```

### `rOPR`: the operator signs separately

Validator 2's launch ran without `LAUNCH_OPERATOR_KEYPAIR_PATH`, and its config had no first buy:

| Step | Signature |
| --- | --- |
| `createConfig` + `createPool` (one transaction) | `ftDPZc43KmR2iZXKjGPoi42HQ6PkDxHbojtUetZRDs69h2VUK1awQe9kfxEjGpGYgDSutpRfmAf3M6DDc7PXGFs` |
| `transferPoolCreator` | `4NfjUANJY58QFRo1yGHkgULCUS7EfMS1FU6xosMsbhmimtQzLkqXZh8bpgNmUbsnXzX3UqiMtjQUqVP8jm1ro84T` |

The launch printed the registration the operator signs: the program, all 14 accounts with their labels and flags, and
the data in base64. After the launch it printed the command to run, and the operator ran it with its own key (11:48):

```bash
LAUNCH_OPERATOR_KEYPAIR_PATH=$S/keys/epoch-operator-2.json EPOCH_PROGRAM_ID=HQRK…Jff LAUNCHES_PATH=$S/rehearsal/registry.json \
pnpm --filter @epoch/meteora register -- --symbol rOPR --cluster devnet --rpc http://127.0.0.1:38899 \
  --allow-unknown-genesis --execute --yes
```

Every check passed: the program, the Pool, the terms, the position, the mint, the DBC config (SOL-quoted, graduates
to DAMM v2, SPL Token, fee claimer = the treasury PDA), the operator's balance, and the simulation (43,409 compute
units). `register_revenue_token`
`5WqAW5pLskXPWHaFmcncvqV2HVzsxNugeNnMQQQ2VRdvYwEjPcb9WQgVNjcqcv39NQpYpR5W5LLY2vgukfP5mofL` created `RevenueToken`
`8rNLSShcX5hxUcWqdFaTPbwzq9Xq2etZHqnmu1jEu2Xz` (escrow `12Ye82gdLr68Rki7H3NpQmnWvg2w6aUuk6UTLz1XDSrw`), term 1–10.
The record was updated in place.

### `register` on a token it cannot register

`rREH`, launched in part 1, gets 2 **FAIL** checks and exit 1, with nothing sent:

- **Validator position:** `FzUN…AmMk` is not onboarded with Epoch. It must onboard before it can register the token.
- **DBC config:** its fee claimer `AQ3g…9Mf8` is not the treasury PDA, and the program refuses it. The only fix is to
  relaunch with the PDA.

### The Launch page API on the program

The API ran with `EPOCH_PROGRAM_ID=HQRK…Jff`, `EPOCH_CLUSTER=localnet` and `EPOCH_RPC_URL=http://127.0.0.1:38899`.
0.1 SOL was sent to `rLOC`'s escrow by hand, to stand in for a share.

- **`GET /v1/launches/rLOC/page`** answered with `revenueToken.source: "program"`: the program's terms, commission
  floors 500 / 1,000, escrow 0.1 SOL above rent. `unavailable` was empty.
- **`GET /v1/launches/<mint>/buybacks`** answered from the program: the term, the escrow, the schedule.

The `rLOC` examples in [docs/pages/launch.md](../pages/launch.md) are these responses.

A re-check at 12:14 IST, on the resumed ledger:

- **`register` on `rLOC`**, which was already registered: every check passed, and it sent nothing. It brought the
  record up to date and printed "Already registered: start epoch 1, the term ends after epoch 10."
- **The API, the same way:**
  - `rREH` answered with `source: "registry"`, `registeredOnChain: false` and the program's PDAs;
  - `rOPR` answered with `source: "program"`, its escrow at 0 SOL;
  - `/buybacks` for `rREH` answered "No validator has registered this mint as a revenue token.";
  - `/buybacks` by symbol answered `400 BAD_REQUEST`.

## 10. Round 2: the whole loop through the program (5 Oct 2026)

5 Oct 2026, 22:45–22:52 IST, on a fresh stand-in. A first run (22:24–22:35 IST) gave the same amounts to the lamport
and found the API fixes below; this is the second run, on the fixed code.

- **The chain.** `solana-test-validator` with 64-slot epochs, Meteora's mainnet DBC, DAMM v2 and Metaplex binaries,
  and `programs/epoch` from the round-2 branch. The program was built with `cargo build-sbf` in a copy with a throwaway
  `declare_id!` (`8iavauBSyvtsM9iaNbtqmaU62jWP8U1wAr1SQGftHhfQ`, 950,296 bytes) and loaded at genesis.
- **The code.** Only code in this repo: the SDK's builders, the launch CLI, the API's `/quote` and `/build` (signed
  by three test wallets), `rehearse migrate`, and the crank jobs from `cranks_app/dist` (`BuybackJob`, `SweepJob`,
  `LaunchFeeClaimJob`).
- **The API's feed.** The realtime feed ran on the RPC websocket (`LAUNCH_REALTIME=auto` with a devnet launch
  cluster), with `LAUNCH_TRADES_POLL_SECONDS=5` and `LAUNCH_TRADES_BACKSTOP_SECONDS=30`.
- **The check.** A checker read the chain: the program's events from the transaction logs, the mint supply, the vault,
  the escrow, the `RevenueToken` and the token accounts. It compared them with every Launch endpoint, the activity
  feed and the recorded WS frames, to the lamport and the token unit. **46 of 46 checks passed.**
- **The record.** Every check, signature and amount is in
  [meteora-e2e-2026-10-05.json](meteora-e2e-2026-10-05.json).

### The program and the launch

| Step | Signature | Result |
| --- | --- | --- |
| `initialize_pool` | `4hNRaZBhh87E6RB82Xh1HSYTzunQa5GTdYTCWWxST5w5HR4D15XVcyDYV2HuxTLtmTSWsrbyPDYyfXobcJkvNqh7` | Pool `CrSBeKMoSBEsjFHf98Aq6ioascraPai3DqsVvnhq3rvd`, treasury PDA `CNZNCChW34nbLnrJy5YfQbZNytnkBNUFg3HvN7DPdXsA`, vault `Ex3NPZMnL5rbhwxCD7Tv4VAVYhjcY9xoknf68hweJPc2` |
| Vote account `9EBKeKgZma5jJhkPBuXULmx2yjjepMruhyBfhoU53V84` (withdrawer: its operator), vote floor funded | `3JsYGANvPUYCG6zACK1WoX81iRxUkNE94cfZzHRnMBftoXBboRGmgF6AKWE25376wfurS3HCrDG4gmrGMxxc9RYF` | |
| `onboard_with_bond` | `5YyHXJ5H3wPaNpNKjgwpgQLEvk14383Fackz2ccReLUm22xvMNpnEvh7DSc6XhfKkPBkJWZ53pTFh5DD2c6AqBvh` | position `3fDmeEEHLmA7WZ7bY5yeHJeNBKiHEZiAo28bmuZyqpcp` Active, operator `2DPfWMML11Ya1rmUyTnUQucm111sBxVMfwrau5uQWuCC` |
| `createConfig` | `4sysN4PT9fknigvTCdN5yz9Q87BJhaYNBTJ2mqZhqjK7wuSjDLLGqauXrnVynZk83fipjd41iCENS5nwKZuevyA4` | Fee claimer and leftover receiver: the treasury PDA |
| `createPool` with the first buy (0.02 SOL) | `5XDRkGDWv5xtH4JmMNFFGvAFiPGNMFG6R6rWHfHwQYiy72eGgGA9j3QGj1nojxmvsxvK65PNXvzuqDxjcAWP5zr3` | `rR2E`, mint `9rgrjLnvaztGut7iGaGnx3peJ2vyHccpkaCStmA54GLL`, DBC pool `9KiWryqrEszzWLDNnr3hn4x7ezQAYiYFd4yXkoyu5hAF` |
| `transferPoolCreator` | `36ejBtpdZL4AznT1MZ4oizgU38SBgckVPbzyHZdUAdTdgk7Ku75FoWgtmsRDydKcTev6ZFkPtnxQov1F4gkVdZEU` | The pool creator is the validator's operator |
| `register_revenue_token(500, 100)`, signed by the operator | `3PG2UFQbFX8SNkWtkmPX5rS2oQi4meD3vEBCYMbCyhvgYXmYq8HbWD6GXEYv4hF4xxjj38qj8SLq38p9iua7HxZF` | `RevenueToken` `BKnweefs2va1DBqSRzEEYLefHePUkzFvnmaySZHPeDaj`, escrow `8ARgYb8yEmkzR51gYPAqTBhkMh2ZNPLjiTuAATzN6Ebo`, term epochs 1–100 |
| `configure_revenue_token` (pool admin) | `2pvte9fJwZvHVcVPMP4hJdmxuirmqL17d1Hwc5fFnN7sbRDwGXGfRFSxD7oRXMnZ9NgYiz5XUryoEc8YpTC2i5mh` | 4 slices in a 48-slot window, to fit 64-slot epochs; impact cap 1,000 bps |

### Trades through the API, and graduation

Each trade was quoted (`POST /quote`), built (`POST /build`), then signed and sent by a test wallet. **Every fill
equalled its quote** to the base unit, in and out.

| IST | Venue | Side | In | Out | Signature |
| --- | --- | --- | --- | --- | --- |
| 22:46:01 | dbc | buy (first buy, in `createPool`) | 0.02 SOL | 3,446.558893 | `5XDRkG…5zr3` |
| 22:46:50 | dbc | buy | 0.15 SOL | 23,781.498065 | `MygKiDsPPoC1FJSarecyKFeKz1h8RKV3ZuWu2H3T219xiXtmthva9kVmJvDzWVLxTL9CLXkyxxJhCTVbRP35NCV` |
| 22:46:55 | dbc | buy | 0.12 SOL | 16,737.343094 | `5aeUkNWy8WDXQHzXzAQZZT5ttLWFGdurN8VjtATuhNoBXG4D9BP3YSPb6vG1QN8KfaS8U4hC2xGBXLR1jXtJHQJ9` |
| 22:47:00 | dbc | sell | 20,000 | 0.139089343 SOL | `2LAHEasDZD3k1rb9pc8baGTFnrjQL8GK8T8vpLM4ASkdt1AaX79AUkudZX23qYcKgAkRos7JFpbYFn5CJcnsJjqK` |
| 22:47:04 | dbc | buy | 0.3 SOL | 39,498.25135 | `3uZA7KorKhDgt5fqbtQ17cesFqbDtyqdGPEWerNxJioMXuH2QTiGqtjPA45u5bSkJaEP3RgBpMPVaEnV51QKX8kV` |
| 22:47:09 | dbc | buy | 0.056965304 SOL (0.1 asked: the quote caps a buy at what completes the raise) | 6,411.909041; `EvtCurveComplete` | `qCwKbkYcLi9VQeTHJGoRmkxUazu3rztXLgocPKEapQWMAXnS3rXTpPCa4rq4unjR1QRmM76scMtppqbBbBJmBc6` |
| 22:47:24 | — | `migrateToDammV2` | | DAMM v2 pool `67RY3gT3ipjqhpyRAbR5ZeCxBZDgYgWuJ5MvKMbtYXZ1` | `4ov8xQvpAhxjWLF3sCvREX5tF3wXBGky1ZVdxbQgoYMAGTdXSA1RJPQiChPLcXXnN2Mj9uwEiy512UFX4SHjMo5a` |
| 22:47:35 | damm-v2 | buy | 0.05 SOL | 4,131.482324 | `33khehdnANYh9meLGTAZvVYsSJUqfrkhkJREeHSDo9VhhinbRJV3zkT5WJ5Zr4T6cjeQpAW3z3FPvtSN3igpvHyz` |
| 22:47:40 | damm-v2 | sell | 5,000 | 0.056248724 SOL | `oyh6KYtnaVTnQ2mR18hMBMxJxW3c2SM5oRUq9wUxWSFrVLP9QGhrp1gTa9bF4mAqHiQ1YxBVSstxjWeu3uWm12W` |

### Sweep, buybacks and the treasury's claims

| Step | Signature | Result |
| --- | --- | --- |
| `BuybackJob` (graduated): `sync_revenue_token_pool` | `3Dfdo7Sn89ebnd9ntYkuiCmYzzUpJYjzvD1y5FNCAqgLB3Q6yYArHUE6GvTd4sNkeqhvU8qtob1NoLPxJDWi29xV` | Venue DAMM v2 |
| 2 SOL sent to the vote account (standing in for commission), then `SweepJob` | `uTP6YUYgvwuohzUaWwHQ6YuTfmAAtRKuZd5jzRmVtbkJNb86MmVzwWUUMDtyT1VQCwsmxxm5Xm8vPYhdLEHD9hW` | `RevenueShareSwept`: 0.1 SOL (5% of 2 SOL) into the escrow, epoch 8 |
| `BuybackJob`, slice 0 | `4dJmQfFFnomgU9Rug1uqkVFyd1btk2iNNprKDyFttKQGq5Ht9VMmv9Kpob5Q1m5QGsPuPFG2tZ8Es1gWNnB5Kefa` | 0.007113428 SOL → 824.312518 burned |
| slice 1 | `2t1kLupbXLkTzApGcQndK1tGHTmjLCUPXsku4HBNHgVA6MbAu1hYyQ8ijcVYrPisZzFgcowPdNYSE4eRYdts6jyf` | 0.007465172 SOL → 784.748357 burned |
| slice 2 | `2QWaeWx5g54GZJttZeNSzcAzjRTeLLGBba7RWFRMUE1EHXg8jBQPBwAjTRnEzPDingWhaet2iQiGSoeKvBRRHLdw` | 0.007833952 SOL → 747.806675 burned |
| slice 3 | `2BdabRK38zDarKV4Wvw5dFQKbMftDwUwbFqSwu1QRuTaPTEXNfgonrseraW9SwCTtFKDLrY3f9Zeno4mDddXWp7p` | 0.008220949 SOL → 712.603909 burned |
| `LaunchFeeClaimJob` through the program: `TreasuryClaimed` tradingFee | `22AjkDonzocqBobAzKzZLsL72Lff8comZtEbF9jXfdNuhF1FLpRS1JENse6CJtzs2wM5mJrE9cvzTAk6g9T5RoDX` | 0.006299679 SOL into the pool's vault |
| `TreasuryClaimed` leftover | `5nPQ3GxagAP79cnbWo7GkMF4TWtvYSCw79rtL4ZsLvT7QTfz3UkjjaPLrPExY8y5WXPzt4w8NEFx7kdEKFxwLZL6` | 913,465.000155 tokens (the supply the curve never sold) burned |
| `TreasuryClaimed` lpFee | `4CtG69qArF9peL8GUjTRqEHbAMxH6ix8uWQXkdPJbVC9PTANXRb3LpVjWEM2XL7PtyksPNdyb3R39AmHBbAviYSo` | 0.001235109 SOL into the pool's vault |
| creatorMigrationFee | not sent (dry run) | 0.350000954 SOL: the validator's own claim; its key was not loaded |

### What the API showed (each checked against the chain)

- **`/fees`.** `toLenders.claimedSol` 0.007534788 equals `/buybacks` `treasury.totals.toLendersSol`, which equals the
  sum of the claims' `lamportsToPool` (7,534,788 lamports). Its `holder` is the vault, which grew by exactly that:
  890,880 → 8,425,668 lamports. `leftover.burned` is `true`, with `burnedTokens` 913,465.000155. The supply fell by
  exactly 913,465,000,155 raw units: 996,930,528,541 → 83,465,528,386.
- **`/buybacks`.** Four rows, one per `BuybackExecuted`. Totals: spent 0.030633501 SOL, burned 3,069.471459,
  escrowed 0.1. The escrow is 0.069366499 SOL above rent, the same in `/page` and `/v1/launches/:mint`. Venue
  `damm-v2`. `schedule.nextSlice.waitsForSweep` is `true`: the next epoch's share is not swept yet.
- **`/v1/launches/:mint`.** `token.burned` is 916,534.471614: every burn, buybacks and the leftover.
- **`/trades`.** 12 rows: 6 on the curve (the first buy included), 2 on DAMM v2, and the 4 slices, whose `trader` is
  the escrow and whose SOL equals each slice's `lamportsIn`.
- **`/candles`.** Volume equals the trades' SOL (0.922937).
- **`/market`.** `damm-v2`, `migrated`.
- **`/holders`.** All 6 token accounts with a balance, to the raw unit, summing to the supply. The treasury holds
  nothing.
- **Activity.** 10 `buyback` rows with the same amounts: registered, graduated, the share, the 4 slices and the 3
  treasury claims. Also one `sweep` row and one `advance` (onboarded).
- **WS `launch:<mint>`.** Each of the 12 trades once, a `market` frame after each, and `fee` frames for
  `curveComplete`, `dammPoolCreated`, `partnerTradingFee`, `leftover` and `lpFee`.
- **`ingest`.** `mode: "websocket"`, `pollSeconds` 30. `lagSeconds` was null after the first start's backfill, 0.9 s
  after the curve trades and 1.1 s after the claims.

### Found and fixed in the API

1. **A trimmed ledger stopped the trade feed for good.** With `--limit-ledger-size 200000` the stand-in drops
   transactions after about 14 minutes. From then on, `getSignaturesForAddress(until: <cursor>)` answered
   "Transaction … not found" on every poll. A node with limited history does the same. The ingester now reads back
   to the cursor's slot.
2. **`/holders` kept its list for 2 minutes, whatever happened.** After the trades it still showed the 2 holders from
   before them (flagged `stale`). It is now read again after a trade or claim, at most every 5 s.
3. **`ingest.lagSeconds` counted the first start's backfill** (77 s in the first run). It no longer does.

The program behaved as specified throughout: no program bug was found.

## 11. Round 3: the hardened program, a whole term, and Meteora's studio (6 Oct 2026)

6 Oct 2026, 01:21–01:45 IST, on a fresh stand-in (same setup as round 2), with `programs/epoch` from `feat/r3-meteora`.
That build includes the revenue-tokens review: `execute_buyback` takes the pool, `redeem` drops the venue accounts,
`close_revenue_token` takes the pool and vault, and `register_revenue_token` is stricter. It was 957,464 bytes, at the
same throwaway id. The record is [meteora-e2e-2026-10-06.json](meteora-e2e-2026-10-06.json): **58 of 58 API checks**,
plus the harness's pause, redeem and close checks. The studio side is in
[STUDIO-CROSSCHECK.md](../meteora/STUDIO-CROSSCHECK.md).

| Step | Signature | Result |
| --- | --- | --- |
| Launch `rR3E` (share 50%, 10 epochs, 0.5 SOL raise, 1%/1% fees) | `createConfig` `5N9FGcS4…`, `createPool` `2a3jyWED…`, `transferCreator` `48RNx5CF…` | Preflight: "Meteora config validation PASS", "Leftover receiver PASS", "Registration checks PASS: check_launch_config passes: fee floor 100 bps, so a buyback slice may move the price at most 200 bps" |
| `register_revenue_token`, `configure_revenue_token` (impact cap 200 bps, the new bound) | `2fGs5f2v…`, `66y93XXz…` | Term epochs 2–11 |
| 6 curve trades, the last completing the raise | `5b8Q1icA…` … `53DFzdnM…` | |
| **Graduation by `LaunchMigrationJob`** (`launch-claims --once`) | `3HLHFqn3…` | DAMM v2 `CaCNoooU…`; seed 149,701,658 lamports = `dammSeedLamports(500,005,536)` (30% less the 0.2% protocol fee) |
| 2 DAMM v2 trades, `sync_revenue_token_pool` | `4pBokLCi…`, `2JGFH91x…`, `51Rv3Qfg…` | |
| Epoch 10: 0.2 SOL commission, sweep, 4 slices | `KPnkr5tu…`; `3eDu7ooW…`, `C77d3LmM…`, `4SnDcd49…`, `3DhoRtYc…` | Share 0.1 SOL; slices 1,400,644–1,442,603 lamports, each held to the 200 bps impact bound |
| **Pause** (epoch 38, after the term): `set_paused(true)`, BuybackJob ×3 | `4J61GJMU…` | No slice; see the crank note below |
| **Close** (epoch 42 = term end + 30): BuybackJob | `4vmBKCyY…` | `RevenueTokenClosed`: 0.094313791 SOL unredeemed → the vault (pool income); rent 0.00732192 SOL → the operator; position freed |
| The validator registers a **studio-built** pool (`rSTU`), redemption allowed in term | `5m3dNKcd…`, `58x6f9hc…` | Term 63–72 |
| **Pause, unpause** (epoch 69–70) | `3HMp89FB…`, `4rajRYAi…`; share `3Faqeg12…`; slice `4nYzWv4p…` | No slice while paused; after unpausing, 0.02084212 SOL bought and burned 2,937.278663 |
| **Redeem in term** (`FLAG_REDEEM_DURING_TERM`) | `inJN9ie7…` | 2,298.65638 rSTU → 182,492 lamports = ⌊79,157,880 × 2,298,656,380 ÷ 997,062,721,337⌋; supply, escrow and totals moved by exactly that |
| **Pause after the sweep** (epoch 74) | `4kdFuUd3…`, `VdRU9pgV…`, slice `qWRmYpi5…` | Refused while paused; the same epoch's slice ran once unpaused |
| Treasury claims through the program | rR3E `iEW31Ypk…`, `4MFgx8tN…`, `2gu1sWN2…`; rSTU `2TVQjX3S…`, `4HrtHcBU…` | 0.00743505 + 0.004040452 SOL to the pool; 917,983.00023 + 917,983.000231 tokens burned |

What the API showed after the close: `/buybacks` for `rR3E` keeps its history (the term, the 4 slices, totals from
`RevenueTokenClosed`, `closed.unclaimedToPoolSol` 0.094313791). `/page` says the vote now has another mint. The
detail's escrow is 0, since the shared `["buyback", vote]` escrow is `rSTU`'s now.

### Found and fixed

1. After the close and the re-registration, `/buybacks` answered "No validator has registered this mint" with zero
   totals, and `/v1/launches/:mint` showed the next token's escrow as this token's. Both are fixed (`closedFeed`; the
   detail checks which mint the `RevenueToken` names). `/page`'s note for a closed token now says it closed.
2. The rest of round 3's fixes are in [SKILL-AUDIT.md](../meteora/SKILL-AUDIT.md): the 0.2% seed, the migration crank,
   the leftover receiver, the preflight's SDK and program checks, the trade compute budget, slippage ≥ 1 and progress
   precision.

### Found, not fixed here

- **Crank error decoding (`@epoch/solana`).** With no fallback RPC, `ConnectionManager.withFailover` drops the
  `SendTransactionError` logs. While the pool was paused, BuybackJob therefore logged "RPC call failed", spent its 3
  attempts and gave up the slice for the epoch, instead of waiting (`Paused` is a "not yet" error). See SKILL-AUDIT.md.
- **The stand-in's ledger** (`--limit-ledger-size 600000`) drops transactions after about 20 minutes, so the checker
  read the program's events from the API's event store, and the transactions still on the ledger from the chain.

## Costs (payer, SOL)

| Item                                         | Rehearsal     | Mainnet note                                                  |
| -------------------------------------------- | ------------- | ------------------------------------------------------------- |
| Launch without a first buy                   | ≈ 0.0327      | + priority fees (the CLI defaults to 100,000 µlamports/CU)    |
| First buy                                    | 0.02 + 0.00203928 token account | the raise's first trade                       |
| Migration to DAMM v2                         | 0.02262108    | normally paid by Meteora's migrator                           |
| Each claim                                   | 0.000005      | + 0.00203928 once for the treasury's token account            |
| `register_revenue_token` (the operator)      | 0.00732192 rent + 0.000005 | rent returned by `close_revenue_token` after the term |

## Surprises

1. **The devnet faucet refused all airdrops** (`429`, daily limit or dry). The local stand-in with mainnet binaries
   worked well and tested the code against what mainnet runs; devnet's DBC and DAMM v2 are different builds.
2. **Graduation needs SOL in DBC's pool authority.** `migrateToDammV2` failed with "Transfer: insufficient lamports 0,
   need 2770080": the DBC pool authority fronts the DAMM v2 pool's rent (flash rent) and is refunded in the same
   transaction. On mainnet it holds 68.8 SOL and on devnet 99.2 SOL, so only a fresh local validator hits this; the
   launch CLI's pre-flight now checks the balance.
3. **DBC emits every swap twice:** `swap2` (and the first buy) emit the legacy `EvtSwap` and `EvtSwap2`. The decoder
   counts one trade per instruction (tested on the fixtures).
4. **PartialFill on the completing buy:** a 0.6 SOL buy used 0.464385772 SOL; the rest stayed with the buyer. The quote
   and the trade feed show the amount actually used.
5. **One lamport of surplus.** The completing buy overshot the threshold by 1 lamport; 80% of a 1-lamport surplus
   rounds to 0 for partner and creator, so only the protocol's share exists. The fees endpoint reports it as 0.
6. **Protocol migration fee in tokens.** 139 tokens (0.0139%) stay in the curve vault for the protocol after the
   leftover withdrawal; the holders list shows them under "Meteora curve vault".
7. **A tiny DAMM v2 pool moves a lot.** 30% of a 0.75 SOL raise seeds 0.22 SOL of liquidity: a 0.1 SOL buy moved the
   price 44%. With the 2–5 SOL raise planned for mainnet the pool is 0.6–1.5 SOL; buyback slices must stay small.
8. **Ledger retention.** `--limit-ledger-size 200000` keeps about ten minutes of transactions on a busy local
   validator: fixtures must be recorded right after each step (`rehearse record`).
9. **Public mainnet RPC limits for the revenue read.** `getLeaderSchedule` only answers for recent epochs (null for
   1038–1039), and `getBlockProduction` over a past range is refused (403): block revenue is sampled per epoch from the
   leader schedule and `getBlock` rewards, and left out (null) where the schedule is gone. Rate limits (429 "too many
   requests for a specific RPC call") are retried with backoff (5 s, 10 s, 20 s …).
10. **Revenue basis.** The curve was priced at 6.82 SOL an epoch including block revenue; the API's live estimate (the
    validator table: inflation + MEV) is 1.99. Block revenue only reaches the buyback if the validator's block revenue
    collector points at Epoch's escrow (SIMD-0232); otherwise launch with `--block-samples 0`. The market block shows
    both (`pricedAtShareRevenuePerEpochSol` and `shareRevenuePerEpochSol`).
11. **After the restart** the local validator's block times lagged the wall clock by about 14 hours (a cluster's
    clock may only drift a bounded amount from its slot-based estimate, so a resumed test validator catches up slowly),
    and the board's `graduatedEpoch` estimate went negative. Neither
    happens on a live cluster. The restart also showed the feed status missed a DAMM v2 pool learned before the
    restart; fixed (the curve names its DAMM v2 pool).

## Fixtures

`packages/meteora/src/__fixtures__/rehearsal/` (about 44 KB): the raw `getTransaction` answers (trimmed) of the first
buy, a curve buy and sell, the completing buy, the migration, a DAMM v2 buy and sell, and the four claims; the DBC pool
and config, DAMM v2 pool, LP position, mint and metadata accounts after the claims (base64); the launch record. Tests
that use them: `events.test.ts`, `claims.test.ts`, `tokenMetadata.test.ts` (meteora) and the API's
`LaunchTradeIngester.test.ts`, `LaunchPageService.test.ts`, `LaunchPageRouters.test.ts` (through
`src/__fixtures__/LaunchFixtures.ts`).

## Re-run it

```bash
S=<scratch>/agent-mlaunch
$S/start-validator.sh --reset                       # fresh ledger (or no flag to resume)
solana -u http://127.0.0.1:38899 airdrop 5 FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM   # DBC pool authority
solana -u http://127.0.0.1:38899 airdrop 5 HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC   # DAMM v2 pool authority
# fund the payer, treasury, validator and traders the same way, then:
pnpm --filter @epoch/meteora launch -- --config … --rpc http://127.0.0.1:38899 --allow-unknown-genesis --execute --yes
node packages/api_app/dist/index.js                 # LAUNCHES_PATH, LAUNCH_RPC_URL, DATABASE_URL
pnpm --filter @epoch/meteora rehearse -- trade --registry … --symbol rREH --rpc … --api http://127.0.0.1:4000 \
  --wallet <trader keypair> --side buy --amount 0.2
pnpm --filter @epoch/meteora rehearse -- migrate --registry … --symbol rREH --rpc … --payer <keypair> --wait 30
LAUNCH_CLAIMS_ENABLED=true TREASURY_KEYPAIR_PATH=… node packages/cranks_app/dist/launch-claims.js --once
pnpm --filter @epoch/meteora rehearse -- record --registry … --symbol rREH --rpc … --out <dir> --signatures a,b,c
$S/stop-validator.sh
```

Part 2 also needs the Epoch program on the validator and a validator onboarded with it:

```bash
cargo build-sbf                                     # programs/epoch, in a copy with a throwaway declare_id!
solana -u http://127.0.0.1:38899 program deploy target/deploy/epoch.so --program-id <throwaway program keypair>
# initialize_pool, a vote account whose withdrawer is the operator, onboard_with_bond: the SDK's builders
EPOCH_PROGRAM_ID=<program id> LAUNCH_OPERATOR_KEYPAIR_PATH=<operator keypair> pnpm --filter @epoch/meteora launch -- …
EPOCH_PROGRAM_ID=<program id> LAUNCH_OPERATOR_KEYPAIR_PATH=<operator keypair> pnpm --filter @epoch/meteora register -- \
  --symbol <SYM> --rpc http://127.0.0.1:38899 --allow-unknown-genesis --execute
```

On the public devnet (when the faucet gives SOL), drop `--rpc` and `--allow-unknown-genesis`; Meteora's migrator
graduates the curve, so `rehearse migrate --wait 300` usually finds it already migrated.
