// Sample data for the Live page (sample mode only: the API is unreachable or sample mode is forced). Built from the
// example responses in docs/pages/live.md, recorded on 3 Oct 2026 (mainnet epoch 1048, RPC sampling mode on public
// RPC) and 5 Oct 2026 (the Solami usage report of a run without a key). Where the doc trims a list ("…"), the rest is
// filled in a way that matches the documented totals:
//   - slots: the two documented blocks, then 58 more drawn (seeded, so every build is identical) from the documented
//     epoch-1048 distribution of slot medians, with the documented leaders;
//   - distribution: the documented buckets, the elided middle buckets filled so the total is the documented 113 slots;
//   - leaders: the two documented rows, the documented index setter and one more documented leader.
// Every block rendered from this file carries the Sample badge and is never animated or called live.

import type { FeeDistribution, LiveLeaders, LiveSlot, LiveSlots, LiveSummary, SolamiUsageResponse } from "@/lib/data/types";

export const liveSummarySample: LiveSummary = {
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-03T19:19:02+05:30",
  source: "indexer_app via Postgres (fee_index_live, epoch_index)",
  live: true,
  dataSource: "RPC polling (api.mainnet-beta.solana.com)",
  stream: {
    source: "rpc",
    endpoint: "api.mainnet-beta.solana.com",
    status: "polling",
    lastSlotAt: "2026-10-03T19:18:58+05:30",
    secondsSinceLastSlot: 4,
    indexerSeenAt: "2026-10-03T19:19:02+05:30",
    gapSlots: 0,
    catchingUp: false,
  },
  tipSlot: 452951614,
  processedSlot: 452951600,
  lagSlots: 14,
  lagSeconds: 5.6,
  epoch: { number: 1048, firstSlot: 452736000, slotIndex: 215609, slotsInEpoch: 432000, progressPct: 49.91 },
  estimate: {
    epoch: 1048,
    value: 12092,
    leaders: 79,
    slotsWithFees: 112,
    pricedTxs: 29646,
    coverageFromSlot: 452950900,
    coveragePct: 0.3,
    stakeEpoch: 1048,
    sampled: true,
  },
  lastFinal: null,
  unit: "µL/CU",
};

const HELIUS = "HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU";
const FIGMENT = "Fd7btgySsrjuo25CJCj7oE7VPMyezDhnx7pZkj2v69Nk";
const LEDGER = "C8Bey3LKVJHVqN6xPTeW8WJfUgFQAeGNBpT4Rp99JP1k";
const SETTER = "5pPRHniefFjkiaArbGX3Y8NUysJmQ9tMZg3FrFGwHzSm";

const documentedSlots: LiveSlot[] = [
  {
    slot: 452951600,
    epoch: 1048,
    leader: HELIUS,
    leaderName: "Helius",
    medianCuPrice: 40091,
    p25CuPrice: 1000,
    p75CuPrice: 185089,
    p90CuPrice: 690740,
    pricedTxs: 482,
    unpricedTxs: 118,
    leaderPaidTxs: 1,
    failedTxs: 270,
    time: "2026-10-03T19:18:57+05:30",
    source: "rpc",
  },
  {
    slot: 452951590,
    epoch: 1048,
    leader: LEDGER,
    leaderName: "Ledger by Figment",
    medianCuPrice: 13697,
    p25CuPrice: 1000,
    p75CuPrice: 100001,
    p90CuPrice: 500136,
    pricedTxs: 319,
    unpricedTxs: 113,
    leaderPaidTxs: 0,
    failedTxs: 185,
    time: "2026-10-03T19:18:54+05:30",
    source: "rpc",
  },
];

/** The documented distribution, middle buckets filled to the documented total of 113 slots. */
const buckets: FeeDistribution["buckets"] = [
  { fromCuPrice: 3162, toCuPrice: 5623, slots: 7 },
  { fromCuPrice: 5623, toCuPrice: 10000, slots: 34 },
  { fromCuPrice: 10000, toCuPrice: 17783, slots: 39 },
  { fromCuPrice: 17783, toCuPrice: 31623, slots: 17 },
  { fromCuPrice: 31623, toCuPrice: 56234, slots: 6 },
  { fromCuPrice: 56234, toCuPrice: 100000, slots: 4 },
  { fromCuPrice: 100000, toCuPrice: 177828, slots: 3 },
  { fromCuPrice: 177828, toCuPrice: 316228, slots: 2 },
  { fromCuPrice: 316228, toCuPrice: 562341, slots: 0 },
  { fromCuPrice: 562341, toCuPrice: 1000000, slots: 1 },
];

/** mulberry32: a tiny seeded PRNG so the sample is the same on every build. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleSlots(): LiveSlot[] {
  const rand = prng(1048);
  const weights = buckets.map((b) => b.slots);
  const total = weights.reduce((a, b) => a + b, 0);
  const pickMedian = () => {
    let r = rand() * total;
    for (const b of buckets) {
      if (r < b.slots) return Math.round(Math.exp(Math.log(b.fromCuPrice) + rand() * (Math.log(b.toCuPrice) - Math.log(b.fromCuPrice))));
      r -= b.slots;
    }
    return 12092;
  };
  const leaders = [
    { leader: FIGMENT, leaderName: "Figment" },
    { leader: SETTER, leaderName: null },
    { leader: HELIUS, leaderName: "Helius" },
    { leader: LEDGER, leaderName: "Ledger by Figment" },
  ];
  const out: LiveSlot[] = [];
  let slot = 452951589;
  const startMs = Date.parse("2026-10-03T19:18:54+05:30");
  for (let i = 0; i < 58; i++) {
    // Leaders hold four consecutive slots; an occasional slot has no block (skipped).
    if (rand() < 0.06) slot--;
    const who = leaders[Math.floor((452951589 - slot) / 4) % leaders.length];
    const noPriced = rand() < 0.04;
    const median = noPriced ? null : pickMedian();
    const priced = noPriced ? 0 : 180 + Math.floor(rand() * 420);
    out.push({
      slot,
      epoch: 1048,
      leader: who.leader,
      leaderName: who.leaderName,
      medianCuPrice: median,
      p25CuPrice: median === null ? null : Math.max(1000, Math.round(median * (0.05 + rand() * 0.25))),
      p75CuPrice: median === null ? null : Math.round(median * (3 + rand() * 4)),
      p90CuPrice: median === null ? null : Math.round(median * (14 + rand() * 20)),
      pricedTxs: priced,
      unpricedTxs: 60 + Math.floor(rand() * 140),
      leaderPaidTxs: rand() < 0.45 ? 1 : 0,
      failedTxs: Math.floor(priced * (0.3 + rand() * 0.3)),
      time: new Date(startMs - (452951590 - slot) * 400).toISOString().replace("Z", "+00:00"),
      source: "rpc",
    });
    slot--;
  }
  return out;
}

export const liveSlotsSample = (): LiveSlots => ({
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-03T19:19:02+05:30",
  source: "indexer_app via Postgres (live_slots)",
  live: true,
  slots: [...documentedSlots, ...sampleSlots()],
});

export const liveLeadersSample: LiveLeaders = {
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-03T19:19:02+05:30",
  source: "indexer_app via Postgres (slot_fees, epoch_stakes)",
  live: true,
  epoch: 1048,
  final: false,
  value: 12092,
  setter: SETTER,
  stakeEpoch: 1048,
  totalStakeSol: 212850616,
  leaders: [
    { rank: 1, identity: FIGMENT, name: "Figment", slots: 5, medianCuPrice: 18750, pricedTxs: 1060, stakeSol: 17923954, weightPct: 8.421, setsIndex: false },
    { rank: 2, identity: HELIUS, name: "Helius", slots: 4, medianCuPrice: 12454, pricedTxs: 1245, stakeSol: 15898894, weightPct: 7.47, setsIndex: false },
    { rank: 9, identity: LEDGER, name: "Ledger by Figment", slots: 4, medianCuPrice: 13697, pricedTxs: 1188, stakeSol: 4207551, weightPct: 1.977, setsIndex: false },
    { rank: 21, identity: SETTER, name: null, slots: 4, medianCuPrice: 12092, pricedTxs: 1312, stakeSol: 2106012, weightPct: 0.989, setsIndex: true },
  ],
  leaderCount: 79,
  unit: "µL/CU",
};

export const liveDistributionSample: FeeDistribution = {
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-03T19:19:02+05:30",
  source: "indexer_app via Postgres (slot_fees)",
  live: true,
  epoch: 1048,
  final: false,
  slots: 113,
  buckets,
  percentiles: { p10: 6046, p25: 8001, p50: 10000, p75: 18750, p90: 40000 },
  indexValue: 12092,
  unit: "µL/CU",
};

/** The documented usage report of 5 Oct 2026, recorded without a Solami key (public RPC; method lists trimmed). */
export const solamiUsageSample: SolamiUsageResponse = {
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-05T19:24:12+05:30",
  source: "solami_usage (indexer_app, publisher_app, cranks_app) + api_app’s own counters",
  inUse: [],
  components: [
    { name: "indexer", updatedAt: "2026-10-05T19:24:03+05:30", stale: false, startedAt: "2026-10-05T19:20:26+05:30" },
    { name: "api", updatedAt: "2026-10-05T19:24:12+05:30", stale: false, startedAt: "2026-10-05T19:22:51+05:30" },
  ],
  grpc: [
    {
      component: "indexer",
      subscription: null,
      endpoint: null,
      status: "off",
      compression: null,
      bytes: 0,
      updates: 0,
      reconnects: 0,
      lastUpdateAt: null,
      lagSlots: null,
    },
  ],
  rpc: [
    {
      component: "indexer",
      host: "api.mainnet-beta.solana.com",
      solami: false,
      calls: 189,
      errors: 0,
      rateLimited: 0,
      p50Ms: 81,
      p95Ms: 371,
      methods: [
        { method: "getSlot", calls: 105, errors: 0, rateLimited: 0, p50Ms: 57, p95Ms: 89 },
        { method: "getBlock", calls: 80, errors: 0, rateLimited: 0, p50Ms: 289, p95Ms: 390 },
      ],
    },
    {
      component: "api",
      host: "api.mainnet-beta.solana.com",
      solami: false,
      calls: 74,
      errors: 6,
      rateLimited: 6,
      p50Ms: 413,
      p95Ms: 1459,
      methods: [
        { method: "getInflationReward", calls: 42, errors: 6, rateLimited: 6, p50Ms: 397, p95Ms: 813 },
        { method: "getBlock", calls: 12, errors: 0, rateLimited: 0, p50Ms: 526, p95Ms: 648 },
      ],
    },
  ],
  beam: [],
  beamTotals: { sends: 0, landed: 0, failed: 0, tipsSpentLamports: 0, tipsSpentSol: 0 },
  lastError: {
    component: "api",
    product: "rpc",
    message: "getInflationReward on api.mainnet-beta.solana.com: HTTP 429",
    at: "2026-10-05T19:23:59+05:30",
  },
};
