# Go live: the three side tracks

The code for the three side tracks (Solami, Panta, Meteora) is built and tested, pages included (6 Oct 2026). What is left needs keys, money or a person, and
this page lists it in order. Times are IST.

The page contracts for the frontend are in [docs/pages](pages/README.md). The track rules are in
[SIDE_TRACKS.md](SIDE_TRACKS.md).

## Deadlines and prizes

**Deadline:** the side tracks and the main Colosseum submission close on **13 Oct 2026, 12:29 IST**. Each track
needs its own Superteam Earn form, filled in by a person.

| Track | Prize | Our page | Judged on | Winners by |
| --- | --- | --- | --- | --- |
| Meteora: best use of DBC | 20,000 USDC (10k, 5k, 3k, 1.5k, 500) | Launch | Depth of Meteora integration, execution, originality, impact, **traction and volume on mainnet** | 31 Oct |
| Panta API | 5,000 USDG (2k, 1k, 1k, 1k) | Predict | Panta API integration, execution, product and UX, originality, impact, traction | 28 Oct |
| Solami | 3,000 USDG | Live | Solami usage, working mainnet demo, build quality, usefulness, creativity | — |

## 1. Shared foundation (do this first)

1. **Database.**
   - Run `pnpm db:migrate`. One new migration, `0002_side_tracks`, adds the tables for the Live, Predict and Launch
     pages.
2. **Public API.**
   - Deploy `api_app` over HTTPS and set `PUBLIC_API_URL`.
   - The frontend reads all three pages from it.
   - Panta markets resolve from `{PUBLIC_API_URL}/v1/index/epochs/{N}`, so it must stay up through 28 Oct.
3. **Index pipeline on mainnet.**
   - `indexer_app` (Solami) fills `epoch_index`. `publisher_app` posts it and the cranks finalize it.
   - A Panta market only resolves from an epoch whose status is `final`. If no final value exists 48 h after its
     resolution time, it resolves NO.
4. **Program on mainnet.** The Meteora entry needs it and the Panta resolution source references it.
   - `declare_id!` is still the placeholder. Create the program keypair outside the repo, then run
     `scripts/set-program-id.sh <ID>`; `scripts/check-program-id.sh` (also run by the tests) fails if any copy disagrees.
   - Pick the upgrade authority (a Squads multisig is safer than one key).
   - Deploy the build, about 957 KB, through a buffer. Program data locks about **6.7 SOL** of rent (about 8.4 SOL with
     room to grow). The buffer's rent is refunded.
   - Then `operator_cli init-pool`, `set-roles` and, per validator, `onboard-validator` (offline signing for the
     validator's keys). Every command is a dry run until `--send`. Step by step: [scripts/mainnet/go-live.md](../scripts/mainnet/go-live.md)
     and [REVENUE_TOKENS_MAINNET.md](REVENUE_TOKENS_MAINNET.md).
   - Ship the new SDK and apps before any later program upgrade. Old clients break against the new `sweep`,
     `release_validator` and `update_commission`.
5. **Paid RPCs.**
   - Use Solami RPC for `DATA_RPC_URL`.
   - Keep `DATA_RPC_FALLBACK_URL` on another provider such as RPC Fast. Solami caps `getProgramAccounts` per plan.
6. **Frontend.** The three pages are built in `app/` (`/live`, `/predict`, `/launch`, plus `/integrations`). Set
   `NEXT_PUBLIC_EPOCH_API_URL` and the RPC variables in `app/.env.example`, and add the frontend's host to the API's
   `API_CORS_ORIGINS` and `SIWS_ALLOWED_DOMAINS`.

## 2. Solami: the Live page

1. **Sign up.**
   - Go to https://solami.dev/signup?ref=st-earn-sep-26 and create a Standard key. Pro is free for 7 days.
   - Time the trial so it covers recording and judging, or plan a paid month.
   - gRPC pay-as-you-go is optional; we estimate it at about $21/day. It enables the full firehose. Without it, the
     indexer picks `hybrid` on its own: block meta over gRPC, blocks over Solami RPC.
2. **Set the env.** The key goes in `.env` only, never in chat or the repo.
   - Required: `SOLAMI_TOKEN`, `SOLAMI_RPC_URL`, `SLOT_SOURCE=auto`.
   - Optional: `INDEXER_BACKFILL_EPOCH=true` with `GAP_FILL_RPS=30`.
   - Beam for every mainnet transaction we sign (publisher, cranks, treasury claims): `SOLAMI_BEAM_URL`, set to your
     Solami RPC URL. Each send tips a Solami tip address (at least 0.0001 SOL), so keep SOL in those wallets.
   - gRPC: the Pro plan includes two streams, one for the indexer and one for the API.
   - Values and examples: [packages/indexer_app/README.md](../packages/indexer_app/README.md).
3. **Check the key.** Run `pnpm solami:check --compression zstd`. It streams slots, compares latency against RPC, checks
   the RPC, Beam and the tip addresses, and never prints the token.
4. **Run it.**
   - Start `indexer_app` and `api_app` (pm2: `pm2 start pm2.config.js --env mainnet`).
   - `GET /v1/live/summary` must show `live: true`, data source Solami, and a lag of a few slots.
   - `GET /v1/live/solami` is the usage report for judges: each Solami product in use, with health, latency and counts.
   - `pnpm demo:solami` prints live stream stats for the video; the indexer README has a 2–3 minute demo outline.
5. **Submit.**
   - The repo must be public, with the "run with your own key" README (done).
   - Record a 2–3 minute mainnet demo: the Live page streaming, the `solami:check` output and the README.

**Verified so far:** on public mainnet RPC without a key: 68 blocks with no lost slots (4 Oct, 09:09–09:12 IST); a
smoke run that crossed epoch 1049→1050 live (5 Oct, 19:30 IST); Solami's gRPC endpoint accepted zstd and gzip and its
tip-address API answered. Not yet tested: streaming with a real key, and real Beam sends.

## 3. Panta: the Predict page (real USDC)

1. **Account.**
   - Create the Panta account and a `pk_live_` key in Panta's dashboard. Agents can't create accounts.
   - Check that `canCreateMarkets` is `true`.
   - Set `PANTA_API_KEY` in the server env only, for both the API and the bot.
2. **Ask in Panta's Discord (#dev-chat):**
   - Will they resolve from `{PUBLIC_API_URL}/v1/index/epochs/{N}` with status `final`, plus
     [FEE_INDEX_METHODOLOGY.md](FEE_INDEX_METHODOLOGY.md)?
   - What is the real creation fee?
   - Do shared rate limits apply between the bot and the API?
   - Which countries must we block?
3. **Bot wallet.**
   - Keep the keypair file outside the repo, for example `~/.config/solana/epoch-panta-bot.json`.
   - Fund it on mainnet with USDC for at least one creation fee per market. The docs example is 50 USDC; our default
     cap is 100 USDC per 24 h. With a strike ladder (`PANTA_STRIKES_PER_EPOCH`, up to 5 markets per epoch, which also
     powers the crowd forecast), raise `PANTA_MAX_CREATE_USDC_PER_DAY` to match.
   - Add 0.1–0.2 SOL.
4. **Env:**
   - `PANTA_BOT_KEYPAIR_PATH`.
   - `PANTA_MARKET_IMAGE_URL`: leave unset to use the API's own image, `{PUBLIC_API_URL}/v1/predict/panta/market-image.png`.
   - `PUBLIC_API_URL`, `PANTA_RPC_URL`.
   - `PANTA_BLOCKED_COUNTRIES`, and `API_TRUST_PROXY` behind a proxy that sets the country header.
     `PANTA_GEO_FAIL_CLOSED=true` refuses trades when no trusted country header is present.
5. **Dry run.** Start the bot with `PANTA_DRY_RUN=true` and read the `DRY RUN: would create` lines.
6. **Go live.**
   - The log should show `creating market`, then `market registered on Panta`.
   - The `panta_markets` row should be `registered`.
   - `GET /v1/predict/panta/markets` should list the market.
   - Make one small test trade and check that it appears in Panta's attributed trades.
7. **Frontend rules (Panta's terms):**
   - Show "Powered by Panta" wherever Panta data appears.
   - Require explicit consent before every transaction.
   - Never show stale prices as live.

Don't go live until mainnet epochs reliably reach `final`. The path from computed to posted to final was proven on a
local chain (`scripts/e2e/index-to-final.mts`, 13 of 13 checks).

## 4. Meteora: the Launch page (real SOL)

1. **Program and pool on mainnet** (section 1).
2. **Design-partner validator.**
   - Set its commission first: the floors are recorded at registration.
   - Then onboard it. It hands its vote account's withdraw authority to the program, and `release` stays blocked until
     the revenue token's term ends.
3. **Token metadata.** Host the metadata JSON at a stable https URL. It is immutable after the launch.
4. **Launch.** Follow [runbooks/meteora-mainnet-launch.md](runbooks/meteora-mainnet-launch.md).
   - Do a dry run first and have a second person review it, then pass `--execute`.
   - The treasury is derived automatically as `["treasury", pool]` and is both fee claimer and leftover receiver.
   - The payer needs about 0.1 SOL: about 0.033 SOL for the launch, plus the first buy and fees.
   - The validator's operator signs `register_revenue_token`, either inside the launch (`LAUNCH_OPERATOR_KEYPAIR_PATH`)
     or later with `pnpm --filter @epoch/meteora register`. Its rent is 0.0073 SOL, returned at close.
5. **Cranks on mainnet.**
   - Set `BUYBACK_ENABLED=true`, `LAUNCH_CLAIMS_ENABLED=true` and `LAUNCHES_PATH`.
   - `LAUNCH_CLUSTER` must equal `EPOCH_CLUSTER=mainnet`.
   - The crank key pays only transaction fees: buybacks and treasury claims are permissionless.
6. **Traction.** This is what the judges score.
   - Real trades on the curve up to the raise target (2–5 SOL), then graduation to DAMM v2.
   - At least one epoch's buyback executed, with its burn visible on the Launch page.
7. **Legal.** A revenue-share token can be a security. Keep it a small demo with no public marketing, behind a
   geo-restricted front end ([ADR 0006](adr/0006-revenue-tokens-on-meteora.md)).

**Verified so far:** on a local validator running Meteora's real mainnet DBC, DAMM v2 and Metaplex binaries:
- the full lifecycle: launch, sweep, buyback on the curve, graduation, buybacks on DAMM v2, redeem and the end of term
  (70 of 70 checks after the security fixes);
- every treasury claim, with exact amounts;
- the whole loop through the API: every Launch page endpoint, the activity feed and the WS frames checked against the
  chain (46 of 46);
- the mainnet-day commands (`init-pool`, roles, pause, offline onboarding, collectors, register): 16 of 16.

The security review and its fixes are in [security/revenue-tokens-review.md](security/revenue-tokens-review.md).

Public devnet was not used because its faucet refused airdrops and it runs different Meteora builds.

## 5. Decisions only you can make

1. **Where the treasury's Meteora income goes.**
   - Today: claimed SOL becomes pool income, so `accrue` pays the 10% protocol fee, then the senior coupon, and junior
     gets the rest. On localnet, 3.6 SOL gave 0.024 SOL to senior and 3.2 SOL to junior.
   - The alternative is a senior-only income bucket. It changes the ledger identity that the SDK, API and cranks check.
   - Crediting senior assets directly would let anyone deposit just before a large claim and withdraw just after,
     because senior withdrawals have no lock.
2. **Panta geo rules.** Choose the blocked countries, and whether a request with no country header is refused. Today
   it is allowed.
3. **Meteora curve basis.**
   - Count block revenue only if it actually reaches the buyback; otherwise launch with `--block-samples 0`.
   - For the rehearsal validator this was 6.82 SOL/epoch with block revenue and 1.90 without.
4. **The design-partner validator** for the mainnet launch.
5. **Program upgrade authority:** one key or a Squads multisig.
6. **Solami plan** through judging: the trial, or paid.
7. **Unredeemed escrow.** Holders have 30 epochs after the term to redeem; after that, what they leave becomes pool
   income (as built). The alternatives are sending it to the validator or never closing the token.

## 6. Money needed (approximate)

| Item | Cost |
| --- | --- |
| Program deploy on mainnet | about 6.6 SOL of program-data rent (locked while deployed) plus fees |
| Meteora launch | about 0.1 SOL payer; 0.0073 SOL registration rent (returned) |
| Panta | one creation fee per market (example 50 USDC; capped at 100 USDC/day) plus 0.1–0.2 SOL |
| Solami | 7-day Pro trial; then a paid plan; optional gRPC pay-as-you-go (about $21/day) |
| RPC | a paid mainnet RPC as fallback (for example RPC Fast) |

## 7. Submission checklist

**Colosseum** (one project): the public repo, the demo video and the pitch.

**One Earn form per track:**

| Track | What the form needs |
| --- | --- |
| Meteora | Repo link, demo of a mainnet launch with trades, graduation and a buyback. The repo is public, so no `dannxbt` access is needed. |
| Panta | Working demo, what we built, and how the Panta API is integrated: markets, trading, positions, claims, attribution |
| Solami | 2–3 minute mainnet demo, public repo, README with setup, env vars and your own key |

Agents can't submit these forms; a team member has to.
