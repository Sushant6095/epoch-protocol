// Meteora side track: the Launch pages. Sources: docs/pages/launch.md, docs/adr/0006-revenue-tokens-on-meteora.md,
// docs/runbooks/meteora-devnet-rehearsal.md and meteora-e2e-2026-10-05.json, docs/security/revenue-tokens-review.md,
// docs/GO_LIVE_SIDE_TRACKS.md §4 (verified runs).
import type { Integration } from "./types";

export const meteora: Integration = {
  id: "meteora",
  sponsor: "Meteora",
  track: "Meteora: best use of Dynamic Bonding Curve",
  prize: "20,000 USDC",
  judgedOn: ["Depth of Meteora integration", "Technical execution", "Originality and taste", "Impact: a new class of assets", "Traction and volume on mainnet"],
  page: { href: "/launch", label: "Launch" },
  headline: "Validator revenue as a token on Meteora’s bonding curve",
  oneLiner:
    "A validator sells a fixed share of its revenue for a fixed term as a token on a Meteora DBC curve with Epoch as the partner; it graduates to DAMM v2, and every epoch the Epoch program buys the token back out of that revenue and burns it.",
  products: [
    {
      product: "Dynamic Bonding Curve: the launch",
      use: "One custom curve per launch, priced from the validator's revenue: 60% → 95% of the share's value per token, a small raise, a 70% migration fee to the validator as upfront SOL, 100% of the graduated liquidity locked. Epoch's treasury PDA is the partner (fee claimer) and the leftover receiver, checked by the program at registration.",
      calls: ["buildCurveWithCustomSqrtPrices", "createConfig · createPool (first buy)", "transferPoolCreator"],
      files: [
        { label: "curve.ts (revenue-anchored curve)", path: "packages/meteora/src/curve.ts" },
        { label: "launch.ts (launch CLI)", path: "packages/meteora/src/launch.ts" },
        { label: "register.rs (program checks)", path: "programs/epoch/src/instructions/revenue/register.rs" },
      ],
    },
    {
      product: "DBC and DAMM v2: trading",
      use: "The page's ticket quotes and builds on whichever venue is live: the curve before graduation, the DAMM v2 pool after it. The API picks the venue, the wallet signs, and the switch at graduation is handled (raise complete → graduating → DAMM v2).",
      calls: ["DBC swapQuote2 · swap2", "DAMM v2 getQuote2 · swap", "migrateToDammV2"],
      files: [
        { label: "trade.ts", path: "packages/meteora/src/trade.ts" },
        { label: "migration.ts", path: "packages/meteora/src/migration.ts" },
        { label: "LaunchPageRouters.ts", path: "packages/api_app/src/Routes/LaunchPageRouters.ts" },
      ],
    },
    {
      product: "Buybacks at source (Epoch program → Meteora)",
      use: "Each sweep takes the share off the top of the validator's revenue into an escrow. execute_buyback spends it in 12 slices across the first hour of each epoch, by CPI into DBC swap2 on the curve or DAMM v2 swap2 after graduation, with a price-impact cap and a min-out, and burns what it buys in the same instruction.",
      calls: ["execute_buyback(slice, min_out)", "sync_revenue_token_pool", "redeem (fallback after the term)"],
      files: [
        { label: "execute_buyback.rs", path: "programs/epoch/src/instructions/revenue/execute_buyback.rs" },
        { label: "buyback.ts (exact quote mirrors)", path: "packages/meteora/src/buyback.ts" },
        { label: "BuybackJob.ts (crank)", path: "packages/cranks_app/src/Jobs/BuybackJob.ts" },
      ],
    },
    {
      product: "Partner fees, LP fees and the unsold supply",
      use: "Five permissionless program instructions claim what Epoch earns as partner: DBC trading fees, surplus, migration fee, the locked DAMM v2 position's fees, and the curve's unsold supply. SOL goes to the lending pool as income; every token among them is burned.",
      calls: ["claim_partner_trading_fee", "claim_partner_surplus · claim_partner_migration_fee", "claim_treasury_lp_fee", "burn_leftover"],
      files: [
        { label: "claim_trading_fee.rs", path: "programs/epoch/src/instructions/treasury/claim_trading_fee.rs" },
        { label: "burn_leftover.rs", path: "programs/epoch/src/instructions/treasury/burn_leftover.rs" },
        { label: "LaunchFeeClaimJob.ts (crank)", path: "packages/cranks_app/src/Jobs/LaunchFeeClaimJob.ts" },
      ],
    },
    {
      product: "Meteora's events: the live feed",
      use: "Every pool transaction is pushed as it confirms (Solami gRPC on mainnet, the RPC websocket elsewhere, polling as the backstop) and decoded from Meteora's own CPI events into the trade feed, candles, holders and the fee history, then streamed on WS launch:<mint>.",
      calls: ["DBC EvtSwap2 · EvtCurveComplete", "DAMM v2 EvtSwap2 · EvtInitializePool", "claim events"],
      files: [
        { label: "events.ts (decoder)", path: "packages/meteora/src/events.ts" },
        { label: "LaunchTradeIngester.ts", path: "packages/api_app/src/Services/Launch/LaunchTradeIngester.ts" },
        { label: "LaunchRealtime.ts", path: "packages/api_app/src/Services/Launch/LaunchRealtime.ts" },
      ],
    },
  ],
  flows: [
    {
      title: "The money: revenue in, tokens burned",
      nodes: [
        { title: "Validator revenue", detail: "inflation + block revenue commission", kind: "chain" },
        { title: "Sweep", detail: "the share comes off the top", kind: "ours" },
        { title: "Buyback escrow", detail: "[\"buyback\", vote]", kind: "ours" },
        { title: "DBC curve / DAMM v2", detail: "12 slices an epoch · impact cap", kind: "sponsor" },
        { title: "Burn", detail: "supply only goes down", kind: "chain" },
      ],
      edges: ["every epoch", "share × gross", "execute_buyback", "same instruction"],
    },
    {
      title: "The fees: Meteora to Epoch's lenders",
      nodes: [
        { title: "Meteora fees", detail: "curve trading fee · LP fees · leftover", kind: "sponsor" },
        { title: "Treasury PDA", detail: "[\"treasury\", pool]: the DBC partner", kind: "ours" },
        { title: "Lending pool", detail: "income: senior coupon first", kind: "chain" },
      ],
      edges: ["permissionless claims", "SOL in · tokens burned"],
    },
    {
      title: "The data: from the pools to this page",
      nodes: [
        { title: "Meteora pools", detail: "DBC + DAMM v2 transactions", kind: "sponsor" },
        { title: "api_app", detail: "decode events · /v1/launches/:mint/*", kind: "ours" },
        { title: "WS launch:<mint>", detail: "snapshot · trade · market · fee", kind: "ours" },
        { title: "Launch page", detail: "chart · ticket · buybacks", kind: "page" },
      ],
      edges: ["push ≈ 1 s", "frames", "live"],
    },
  ],
  why: {
    problem:
      "A validator's revenue is a real, on-chain cashflow, but there is no venue where it trades. Selling part of it today means trusting the validator to pay later.",
    unlocks: [
      "Price discovery and a graduation path without writing an AMM: DBC finds the price, DAMM v2 keeps a pool with liquidity locked forever, so holders always have an exit.",
      "Backing that is enforced, not promised: the program holds the validator's withdraw authority, takes the share at source and buys back and burns every epoch; the validator cannot leave or cut its commission before the term ends.",
      "Meteora volume every epoch from the buybacks themselves, and Epoch's partner fees feeding the lenders who fund validator credit.",
    ],
  },
  runs: [
    {
      title: "Program lifecycle on Meteora's mainnet programs",
      when: "5 Oct 2026 (after the security review)",
      result: "70 / 70 checks",
      detail: "A local validator loaded with Meteora's mainnet DBC, DAMM v2 and Metaplex binaries: launch, sweep, buyback on the curve, graduation, buybacks on DAMM v2, redeem and the end of term; every treasury claim with exact amounts.",
      link: { label: "Security review", path: "docs/security/revenue-tokens-review.md" },
    },
    {
      title: "The whole loop through the Launch API",
      when: "5 Oct 2026, 22:45–22:52 IST",
      result: "46 / 46 checks",
      detail: "rR2E: trades through /quote and /build (every fill equalled its quote), graduation, a sweep, four buyback slices and three treasury claims; every endpoint, the activity feed and the WS frames compared with the chain to the lamport.",
      link: { label: "meteora-e2e-2026-10-05.json", path: "docs/runbooks/meteora-e2e-2026-10-05.json" },
    },
    {
      title: "Mainnet-day commands",
      when: "5 Oct 2026",
      result: "16 / 16",
      detail: "init-pool, roles, pause, offline onboarding, collectors and register, each a dry run until --send.",
      link: { label: "GO_LIVE_SIDE_TRACKS.md §4", path: "docs/GO_LIVE_SIDE_TRACKS.md" },
    },
  ],
  next: "The mainnet launch with a design-partner validator follows the runbook; the list and token pages read it the moment it is in the registry.",
  docs: [
    { label: "Page contract (launch.md)", path: "docs/pages/launch.md" },
    { label: "ADR 0006: revenue tokens on Meteora", path: "docs/adr/0006-revenue-tokens-on-meteora.md" },
    { label: "Rehearsal runbook", path: "docs/runbooks/meteora-devnet-rehearsal.md" },
    { label: "Mainnet launch runbook", path: "docs/runbooks/meteora-mainnet-launch.md" },
  ],
};
