// Sample data for the Predict page (sample mode only). Built from the example responses in docs/pages/predict.md and
// made consistent with each other at one moment (6 Oct 2026, 08:30 IST, mainnet epoch 1050 running):
//   - Epoch's markets are the documented strike ladder of epoch 1051 (1,100 · 1,300 · 1,500 µL/CU, from the
//     forecast example); their YES prices sit on the documented lognormal fit (μ 7.218438, σ 0.200808);
//   - the documented epoch-1049 market at 1,300 resolved NO (the documented final value is 1,250), which is why the
//     documented position on it is claimable;
//   - the catalog, the tape, the positions, the traction record and the quote are the documented examples.
// Nothing here can be traded: trading needs the live API. Every block carries the Sample badge.

import type {
  FeeIndexEpochView,
  PantaFeeIndexMarket,
  PantaForecastView,
  PantaMarketCard,
  PantaMarketDetail,
  PantaMarketsPage,
  PantaPositionsView,
  PantaStatsView,
  PredictLeaderboard,
  PredictSnapshot,
} from "@/lib/data/types";

const AS_OF = "2026-10-06T08:30:00+05:30";
const meta = {
  poweredBy: "Panta" as const,
  poweredByUrl: "https://panta.market" as const,
  asOf: AS_OF,
  ageSeconds: 3,
  stale: false,
};

const access: PantaMarketsPage["access"] = {
  tradingEnabled: true,
  geoBlocked: false,
  country: "IN",
  reason: null,
  minTradeUsdc: "1",
  maxTradeUsdc: "500",
  signInRequired: true,
  network: "solana-mainnet",
  currency: "USDC",
};

const RULE = (epoch: number, k: number) =>
  `Resolves YES if the final Solana Fee Index for Solana mainnet epoch ${epoch} is strictly greater than ${k.toLocaleString("en-US")} micro-lamports per compute unit, as published by Epoch at /v1/index/epochs/${epoch} once its status is final (posted on chain and past its dispute window). Equal resolves NO. If the value is vetoed, the corrected final value decides; if no final value is published within 48 hours of the resolution time, the market resolves NO.`;

function ourMarket(o: {
  id: string;
  epoch: number;
  k: number;
  yes: number;
  vol: string;
  endsAt: string;
  resolvesAt: string;
  model: number;
  above: number;
  phase?: string;
  resolved?: boolean;
}): PantaFeeIndexMarket {
  const resolved = o.resolved ?? false;
  const yes = resolved ? null : o.yes;
  return {
    marketId: o.id,
    title: `Solana Fee Index above ${o.k.toLocaleString("en-US")} µL/CU in epoch ${o.epoch}`,
    description:
      "Epoch publishes the Solana Fee Index every epoch: the stake-weighted median priority fee across slot leaders, computed from every mainnet block and posted on chain. This market asks whether one epoch's final value closes above the threshold.",
    category: "crypto",
    phase: o.phase ?? "primary",
    status: resolved ? "resolved" : "open",
    imageUrl: null,
    yesPrice: yes,
    noPrice: yes === null ? null : Math.round((1 - yes) * 100) / 100,
    volumeUsdc: o.vol,
    startsAt: "2026-10-05T19:40:00+05:30",
    endsAt: o.endsAt,
    resolvesAt: o.resolvesAt,
    resolved,
    ours: true,
    tradable: !resolved,
    epoch: o.epoch,
    thresholdMicroLamports: o.k,
    question: `Will the Solana Fee Index for epoch ${o.epoch} close above ${o.k.toLocaleString("en-US")} micro-lamports per CU?`,
    resolutionRule: RULE(o.epoch, o.k),
    sourcesOfTruth: [
      `https://api.epoch.example/v1/index/epochs/${o.epoch}`,
      "https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md",
    ],
    resolutionUrl: `https://api.epoch.example/v1/index/epochs/${o.epoch}`,
    pricesAsOf: resolved ? null : AS_OF,
    pricesStale: false,
    intelligence: {
      label: "informational",
      note: "Informational only, not advice. The model is the share of recent finished epochs whose Fee Index was strictly above the threshold; the implied probability is the market’s YES price. Past fees do not predict future fees.",
      impliedProbability: yes,
      modelProbability: o.model,
      model: { method: "empirical share of recent finished epochs above the threshold", lookbackEpochs: 30, above: o.above, sample: 30 },
      gapPct: yes === null ? null : Math.round((yes - o.model) * 100),
      index: {
        unit: "µL/CU",
        last: { epoch: 1049, value: 1250, status: "final" },
        running: { epoch: 1050, value: 1275, slots: 214000 },
      },
    },
  };
}

const CLOSES_1051 = "2026-10-07T03:42:00+05:30";
const RESOLVES_1051 = "2026-10-08T13:50:00+05:30";

export const ourMarketsSample: PantaFeeIndexMarket[] = [
  ourMarket({ id: "8xQdF1100E1051", epoch: 1051, k: 1100, yes: 0.85, vol: "300.00", endsAt: CLOSES_1051, resolvesAt: RESOLVES_1051, model: 0.8, above: 24 }),
  ourMarket({ id: "8xQdF1300E1051", epoch: 1051, k: 1300, yes: 0.6, vol: "1240.00", endsAt: CLOSES_1051, resolvesAt: RESOLVES_1051, model: 0.4, above: 12 }),
  ourMarket({ id: "8xQdF1500E1051", epoch: 1051, k: 1500, yes: 0.32, vol: "410.00", endsAt: CLOSES_1051, resolvesAt: RESOLVES_1051, model: 0.13, above: 4 }),
  ourMarket({ id: "8xQdF1300E1052", epoch: 1052, k: 1300, yes: 0.57, vol: "95.00", endsAt: "2026-10-08T11:46:00+05:30", resolvesAt: "2026-10-09T21:54:00+05:30", model: 0.4, above: 12 }),
  ourMarket({
    id: "8xQdFee1",
    epoch: 1049,
    k: 1300,
    yes: 0,
    vol: "1310.00",
    endsAt: "2026-10-04T11:59:55+05:30",
    resolvesAt: "2026-10-06T08:26:40+05:30",
    model: 0.4,
    above: 12,
    phase: "resolved",
    resolved: true,
  }),
];

const catalog: PantaMarketCard[] = [
  {
    marketId: "3pLkETH5",
    title: "ETH above 5k?",
    description: "Resolves from CoinGecko.",
    category: "crypto",
    phase: "primary",
    status: "open",
    imageUrl: null,
    yesPrice: null,
    noPrice: null,
    volumeUsdc: "1200.00",
    startsAt: "2026-01-01T05:30:00+05:30",
    endsAt: "2026-12-31T05:29:59+05:30",
    resolvesAt: "2026-12-31T06:29:59+05:30",
    resolved: false,
    ours: false,
    tradable: true,
  },
];

export const pantaMarketsSample = (): PantaMarketsPage => ({
  schemaVersion: 1,
  kind: "real",
  source: "Panta public API (live-api.panta.market) through Epoch",
  ...meta,
  access,
  ours: ourMarketsSample,
  discover: { items: catalog, nextCursor: null, category: null, q: null, searched: null },
});

export const pantaMarketDetailSample = (marketId: string): PantaMarketDetail | null => {
  const market = [...ourMarketsSample, ...catalog].find((m) => m.marketId === marketId);
  if (!market) return null;
  return {
    schemaVersion: 1,
    kind: "real",
    source: "Panta public API through Epoch",
    ...meta,
    access,
    market,
    trades: market.ours
      ? [
          { walletShort: "9aB1…x7Qe", side: "yes", yesShares: "10", noShares: "0", feeUsdc: "0.05", amountUsdc: "10.20", kind: "buy", isPrimary: true, at: "2026-10-06T08:12:02+05:30", signature: null },
          { walletShort: null, side: "no", yesShares: "0", noShares: "24.5", feeUsdc: null, amountUsdc: null, kind: "buy", isPrimary: true, at: "2026-10-06T07:51:40+05:30", signature: null },
        ]
      : [],
  };
};

export const pantaCategoriesSample = {
  schemaVersion: 1 as const,
  kind: "real" as const,
  source: "Panta public API",
  ...meta,
  categories: ["sports", "crypto", "politics", "entertainment", "finance", "science", "world", "other"],
};

export const pantaPositionsSample = (wallet: string): PantaPositionsView => ({
  schemaVersion: 1,
  kind: "real",
  source: "Panta positions through Epoch",
  ...meta,
  wallet,
  claimableCount: 1,
  positions: [
    { marketId: "3pLkETH5", title: "ETH above 5k?", ours: false, side: "yes", shares: "38.40", phase: "primary", claimable: false, claimed: false, outcome: null, price: 0.52, estValueUsdc: "19.97", state: "open" },
    { marketId: "8xQdFee1", title: "Solana Fee Index above 1,300 µL/CU in epoch 1049", ours: true, side: "no", shares: "10", phase: "resolved", claimable: true, claimed: false, outcome: "no", price: null, estValueUsdc: "10.00", state: "claimable" },
  ],
});

export const pantaStatsSample: PantaStatsView = {
  schemaVersion: 1,
  kind: "real",
  source: "Panta account endpoints and Epoch's panta_trades / panta_markets",
  ...meta,
  asOf: "2026-10-05T19:40:00+05:30",
  epoch: {
    trades: 233,
    buys: 201,
    claims: 32,
    uniqueWallets: 87,
    volumeUsdc: "4210.50",
    attributedTrades: 233,
    pendingAttribution: 0,
    marketsCreated: 12,
    marketsLive: 4,
    creationFeesPaidUsdc: "600.00",
    creatorFeesClaimedUsdc: "41.20",
    firstTradeAt: null,
    lastTradeAt: null,
  },
  panta: { attributedTrades: 233, attributedVolumeUsdc: "4210.50", byKind: { buy: 201, claim: 32 }, creates: { total: 13, byStatus: { registered: 12, pending: 1 } } },
  traction: {
    asOf: "2026-10-05T19:40:00+05:30",
    stale: false,
    account: { status: "active", canCreateMarkets: true },
    // Zeros on purpose: sample mode must never look like traction. The live API fills these from Panta.
    marketsCreated: 0,
    createsByStatus: { registered: 0, pending: 0 },
    attributedVolumeUsdc: "0.00",
    marketsVolumeUsdc: "0.00",
    traders: 0,
    tradersComplete: true,
    attributedTrades: 0,
    tradesByKind: { buy: 0, claim: 0 },
    creatorFeesClaimedUsdc: "0.00",
    creationFeesPaidUsdc: "0.00",
    estimatedProtocolFeesUsdc: "0.00",
    sources: { dashboard: true, metrics: true, creates: true, trades: true, catalog: true },
  },
};

export const pantaForecastSample = (epoch?: number | null): PantaForecastView => {
  const e = epoch ?? 1051;
  const strikes = ourMarketsSample.filter((m) => m.epoch === e && !m.resolved);
  const curve = (k: number) => {
    // P(index > k) under the documented lognormal fit.
    const z = (Math.log(k) - 7.218438) / 0.200808;
    return Math.round((1 - normalCdf(z)) * 10_000) / 10_000;
  };
  return {
    schemaVersion: 1,
    kind: "real",
    source: "Epoch's Fee Index markets on Panta (YES prices)",
    ...meta,
    label: "informational",
    disclaimer:
      "Informational only, not advice. The crowd forecast is read from the YES prices of Epoch's markets on this epoch; prices move and can be thin. Past fees do not predict future fees.",
    epoch: e,
    epochs: [1052, 1051],
    unit: "µL/CU",
    strikes: strikes.map((m) => ({
      strikeMicroLamports: m.thresholdMicroLamports,
      marketId: m.marketId,
      title: m.title,
      phase: m.phase,
      yesPrice: m.yesPrice,
      noPrice: m.noPrice,
      impliedProbability: m.yesPrice,
      fittedProbability: m.yesPrice,
      curveProbability: curve(m.thresholdMicroLamports),
      empiricalProbability: m.intelligence.modelProbability,
      volumeUsdc: m.volumeUsdc,
    })),
    fit: e === 1051 ? { method: "lognormal-fit", mu: 7.218438, sigma: 0.200808, strikesUsed: 3 } : { method: "lognormal-history-sigma", mu: 7.24, sigma: 0.2, strikesUsed: 1 },
    median: e === 1051 ? 1364 : 1394,
    expected: e === 1051 ? 1392 : 1422,
    band: e === 1051 ? { low: 1055, high: 1765, coverage: 0.8 } : { low: 1081, high: 1798, coverage: 0.8 },
    lastValue: { epoch: 1049, value: 1250 },
    reason: null,
  };
};

/** Abramowitz–Stegun 7.1.26: the standard normal CDF to about 1e-7. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export const feeIndexEpochSample = (epoch: number): FeeIndexEpochView => ({
  schemaVersion: 1,
  kind: "real",
  asOf: AS_OF,
  source: "Epoch FeeIndex account and epoch_index",
  epoch,
  value: epoch <= 1049 ? 1250 : null,
  status: epoch <= 1049 ? "final" : "pending",
  final: epoch <= 1049,
  unit: "µL/CU",
  computedValue: epoch <= 1049 ? 1250 : null,
  onChain: null,
  methodology: "https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md",
});

// ── Points tab (the free tier) ──────── from the kit's handover/fixtures/predict.sample.json, trimmed
export const pointsSnapshotSample: PredictSnapshot = {
  schemaVersion: 1,
  kind: "sample",
  asOf: AS_OF,
  source: "api_app Predict in points mode (sample)",
  rules: {
    mode: "points",
    pointsPerEpoch: 100,
    callSizesPoints: [10, 25, 50, 100],
    pointsLeftThisEpoch: null,
    feeBps: 0,
    leaderboardEpochs: 30,
    ageGate: "18+",
    regions: "where allowed",
  },
  payoutFormula: "payout = a * (P + a) / (s * P + a)",
  markets: [
    {
      id: "fee-index-1051-above-1300",
      question: "Will epoch 1051’s Fee Index close above 1,300 µL/CU?",
      yesShare: 0.62,
      poolPoints: 31800,
      players: 1204,
      closesAtEpoch: 1051,
      status: "open",
      nowNote: "Epoch 1050 is running; its index is posted when it ends",
      answerSource: "Epoch Fee Index, final value after its dispute window",
    },
    {
      id: "fee-index-1050-above-1250",
      question: "Will epoch 1050’s Fee Index close above 1,250 µL/CU?",
      yesShare: 0.48,
      poolPoints: 27350,
      players: 988,
      closesAtEpoch: 1050,
      status: "closed",
      nowNote: "Waiting for epoch 1050’s Fee Index",
      answerSource: "Epoch Fee Index, final value after its dispute window",
    },
  ],
  myCalls: [],
  leaderboard: [
    { rank: 1, walletShort: "7xKX…9aPq", netPoints: 1840, hitPct: 71, calls: 41 },
    { rank: 2, walletShort: "Bq3m…Lw2T", netPoints: 1325, hitPct: 66, calls: 38 },
    { rank: 3, walletShort: "9aB1…x7Qe", netPoints: 990, hitPct: 63, calls: 30 },
  ],
};

export const pointsLeaderboardSample: PredictLeaderboard = {
  schemaVersion: 1,
  kind: "sample",
  asOf: AS_OF,
  source: "api_app Predict in points mode (sample)",
  epochs: 30,
  rows: pointsSnapshotSample.leaderboard,
};
