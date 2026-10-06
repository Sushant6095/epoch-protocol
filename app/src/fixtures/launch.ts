// Sample data for the Launch pages (sample mode only). Three revenue tokens from the docs, all recorded on a local
// stand-in running Meteora's mainnet DBC, DAMM v2 and Metaplex binaries (the API answered `devnet` there):
//   - rR2E: the round-2 run of 5 Oct 2026 (docs/runbooks/meteora-e2e-2026-10-05.json, 46 of 46 checks): launch,
//     trades through /quote and /build, graduation to DAMM v2, a sweep, four buyback slices and three treasury claims.
//     Amounts, signatures, holders, totals and the schedule are the record's; per-trade prices are SOL ÷ tokens of
//     each fill (fees included), the candles are bucketed from those trades, and the curve band (rLOC's preset over
//     a 100-epoch term, so ten times rLOC's band) and the DAMM v2 pool's liquidity are estimates.
//   - rLOC: on the curve, registered with the program (docs/pages/launch.md "First paint"): 1 buyer, 3.96% raised.
//   - rREH: the devnet rehearsal of 3–4 Oct (docs/runbooks/meteora-devnet-rehearsal.md and the rREH examples in
//     docs/pages/launch.md), graduated, not registered (its fee claimer was a plain wallet). The market block, holders,
//     revenue-token terms, claims and the trades whose amounts the runbook gives are the record's; trade times are to
//     the minute where the runbook gives no second, slots are estimates, and two buys whose token amounts the runbook
//     does not give (the launch's first buy and the buy that completed the raise) are left out of the feed.
// Explorer links use the local stand-in's custom cluster (rREH: devnet, as the docs print them); they only open while
// that validator runs.

import type {
  LaunchBuybackFeed,
  LaunchCandle,
  LaunchCandleInterval,
  LaunchCandles,
  LaunchFees,
  LaunchHolders,
  LaunchList,
  LaunchMarket,
  LaunchPage,
  LaunchSummary,
  LaunchTrade,
} from "@/lib/data/types";

const LOCAL = `?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:38899")}`;
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}${LOCAL}`;
const addr = (a: string) => `https://explorer.solana.com/address/${a}${LOCAL}`;

// ── rR2E (round 2, 5 Oct 2026) ─────────────────────────────────────────────────────────────────────────
const R2E = {
  mint: "9rgrjLnvaztGut7iGaGnx3peJ2vyHccpkaCStmA54GLL",
  dbcPool: "9KiWryqrEszzWLDNnr3hn4x7ezQAYiYFd4yXkoyu5hAF",
  dammPool: "67RY3gT3ipjqhpyRAbR5ZeCxBZDgYgWuJ5MvKMbtYXZ1",
  treasury: "CNZNCChW34nbLnrJy5YfQbZNytnkBNUFg3HvN7DPdXsA",
  vault: "Ex3NPZMnL5rbhwxCD7Tv4VAVYhjcY9xoknf68hweJPc2",
  revenueToken: "BKnweefs2va1DBqSRzEEYLefHePUkzFvnmaySZHPeDaj",
  escrow: "8ARgYb8yEmkzR51gYPAqTBhkMh2ZNPLjiTuAATzN6Ebo",
  vote: "9EBKeKgZma5jJhkPBuXULmx2yjjepMruhyBfhoU53V84",
  operator: "2DPfWMML11Ya1rmUyTnUQucm111sBxVMfwrau5uQWuCC",
};

type RawTrade = [t: string, slot: number, sig: string, venue: "dbc" | "damm-v2", side: "buy" | "sell", sol: number, tokens: number, trader: string];
const r2eRaw: RawTrade[] = [
  ["2026-10-05T22:46:01+05:30", 44, "5XDRkGDWv5xtH4JmMNFFGvAFiPGNMFG6R6rWHfHwQYiy72eGgGA9j3QGj1nojxmvsxvK65PNXvzuqDxjcAWP5zr3", "dbc", "buy", 0.02, 3446.558893, "8pAZsL1VyssU1eAZqCgxmZPFGg2bLC5o6yys1ViJDrf5"],
  ["2026-10-05T22:46:50+05:30", 235, "MygKiDsPPoC1FJSarecyKFeKz1h8RKV3ZuWu2H3T219xiXtmthva9kVmJvDzWVLxTL9CLXkyxxJhCTVbRP35NCV", "dbc", "buy", 0.15, 23781.498065, "CJ8YPaCqzvfHBNuxts3QaTLGYr2RB59cAkXceXcfsYWd"],
  ["2026-10-05T22:46:55+05:30", 254, "5aeUkNWy8WDXQHzXzAQZZT5ttLWFGdurN8VjtATuhNoBXG4D9BP3YSPb6vG1QN8KfaS8U4hC2xGBXLR1jXtJHQJ9", "dbc", "buy", 0.12, 16737.343094, "Ev4XG6dsDw3sC9MZHwBYjdCGujJtY9V1APuDbyzHYEHD"],
  ["2026-10-05T22:47:00+05:30", 276, "2LAHEasDZD3k1rb9pc8baGTFnrjQL8GK8T8vpLM4ASkdt1AaX79AUkudZX23qYcKgAkRos7JFpbYFn5CJcnsJjqK", "dbc", "sell", 0.139089343, 20000, "CJ8YPaCqzvfHBNuxts3QaTLGYr2RB59cAkXceXcfsYWd"],
  ["2026-10-05T22:47:04+05:30", 294, "3uZA7KorKhDgt5fqbtQ17cesFqbDtyqdGPEWerNxJioMXuH2QTiGqtjPA45u5bSkJaEP3RgBpMPVaEnV51QKX8kV", "dbc", "buy", 0.3, 39498.25135, "LARMe5ZxjmuT8RjsLtBvAngkNYj7d8nJXxdDcaerD7E"],
  ["2026-10-05T22:47:09+05:30", 313, "qCwKbkYcLi9VQeTHJGoRmkxUazu3rztXLgocPKEapQWMAXnS3rXTpPCa4rq4unjR1QRmM76scMtppqbBbBJmBc6", "dbc", "buy", 0.056965304, 6411.909041, "Ev4XG6dsDw3sC9MZHwBYjdCGujJtY9V1APuDbyzHYEHD"],
  ["2026-10-05T22:47:35+05:30", 419, "33khehdnANYh9meLGTAZvVYsSJUqfrkhkJREeHSDo9VhhinbRJV3zkT5WJ5Zr4T6cjeQpAW3z3FPvtSN3igpvHyz", "damm-v2", "buy", 0.05, 4131.482324, "Ev4XG6dsDw3sC9MZHwBYjdCGujJtY9V1APuDbyzHYEHD"],
  ["2026-10-05T22:47:40+05:30", 439, "oyh6KYtnaVTnQ2mR18hMBMxJxW3c2SM5oRUq9wUxWSFrVLP9QGhrp1gTa9bF4mAqHiQ1YxBVSstxjWeu3uWm12W", "damm-v2", "sell", 0.056248724, 5000, "LARMe5ZxjmuT8RjsLtBvAngkNYj7d8nJXxdDcaerD7E"],
  ["2026-10-05T22:47:59+05:30", 515, "4dJmQfFFnomgU9Rug1uqkVFyd1btk2iNNprKDyFttKQGq5Ht9VMmv9Kpob5Q1m5QGsPuPFG2tZ8Es1gWNnB5Kefa", "damm-v2", "buy", 0.007113428, 824.312518, R2E.escrow],
  ["2026-10-05T22:48:03+05:30", 533, "2t1kLupbXLkTzApGcQndK1tGHTmjLCUPXsku4HBNHgVA6MbAu1hYyQ8ijcVYrPisZzFgcowPdNYSE4eRYdts6jyf", "damm-v2", "buy", 0.007465172, 784.748357, R2E.escrow],
  ["2026-10-05T22:48:05+05:30", 542, "2QWaeWx5g54GZJttZeNSzcAzjRTeLLGBba7RWFRMUE1EHXg8jBQPBwAjTRnEzPDingWhaet2iQiGSoeKvBRRHLdw", "damm-v2", "buy", 0.007833952, 747.806675, R2E.escrow],
  ["2026-10-05T22:48:08+05:30", 552, "2BdabRK38zDarKV4Wvw5dFQKbMftDwUwbFqSwu1QRuTaPTEXNfgonrseraW9SwCTtFKDLrY3f9Zeno4mDddXWp7p", "damm-v2", "buy", 0.008220949, 712.603909, R2E.escrow],
];

/**
 * Rows from raw fills. `fees: "included"` prices a fill at SOL ÷ tokens (rR2E); `"1%"` prices it before a 1% fee, as
 * the API does (buy: (SOL − 1%) ÷ tokens; sell: (SOL ÷ 0.99) ÷ tokens), which reproduces rREH's documented candles.
 */
function toTrades(raw: RawTrade[], fees: "included" | "1%" = "included"): LaunchTrade[] {
  const price = (side: "buy" | "sell", sol: number, tokens: number) =>
    fees === "included" ? sol / tokens : side === "buy" ? (sol * 0.99) / tokens : sol / 0.99 / tokens;
  const rows = raw.map(([t, slot, signature, venue, side, solAmount, tokenAmount, trader], i): LaunchTrade => {
    const priceSol = price(side, solAmount, tokenAmount);
    const next = raw[i + 1];
    return {
      id: `${signature}:0`,
      signature,
      t,
      slot,
      venue,
      side,
      trader,
      solAmount,
      tokenAmount,
      priceSol,
      postPriceSol: next ? price(next[4], next[5], next[6]) : priceSol,
      feeSol: fees === "included" || side === "buy" ? solAmount * 0.01 : solAmount / 0.99 - solAmount,
      explorerUrl: tx(signature),
    };
  });
  return rows.reverse(); // newest first
}

const r2eTrades = toTrades(r2eRaw);
const r2ePrice = r2eTrades[0].priceSol;
const R2E_SUPPLY_NOW = 83465.528386;

/** OHLC buckets from trades, oldest first; empty buckets after the first trade stay flat at the previous close. */
export function candlesFromTrades(trades: LaunchTrade[], interval: LaunchCandleInterval): LaunchCandle[] {
  const seconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 }[interval];
  const sorted = [...trades].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (!sorted.length) return [];
  const buckets = new Map<number, LaunchCandle>();
  for (const tr of sorted) {
    const time = Math.floor(Date.parse(tr.t) / 1000 / seconds) * seconds;
    const c = buckets.get(time);
    if (!c) {
      buckets.set(time, { t: new Date(time * 1000).toISOString(), time, open: tr.priceSol, high: tr.priceSol, low: tr.priceSol, close: tr.priceSol, volumeSol: tr.solAmount, trades: 1 });
    } else {
      c.high = Math.max(c.high, tr.priceSol);
      c.low = Math.min(c.low, tr.priceSol);
      c.close = tr.priceSol;
      c.volumeSol += tr.solAmount;
      c.trades += 1;
    }
  }
  const times = [...buckets.keys()].sort((a, b) => a - b);
  const out: LaunchCandle[] = [];
  for (let t = times[0]; t <= times[times.length - 1]; t += seconds) {
    const c = buckets.get(t);
    if (c) out.push({ ...c, volumeSol: Math.round(c.volumeSol * 1e9) / 1e9 });
    else {
      const prev = out[out.length - 1];
      out.push({ t: new Date(t * 1000).toISOString(), time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volumeSol: 0, trades: 0 });
    }
  }
  return out;
}

const r2eSummary: LaunchSummary = {
  mint: R2E.mint,
  symbol: "rR2E",
  name: "Epoch round-2 revenue token",
  validator: { name: "Round-2 test validator", vote: R2E.vote },
  shareBps: 500,
  termEpochs: 100,
  startEpoch: 1,
  endEpoch: 100,
  status: "graduated",
  opensAtEpoch: null,
  raise: { targetSol: 0.5, raisedSol: 0.5, progressPct: 100, buyers: 4 },
  priceSol: r2ePrice,
  bandLowSol: 5.68669e-6,
  bandHighSol: 9.00393e-6,
  marketCapSol: r2ePrice * R2E_SUPPLY_NOW,
  shareRevenuePerEpochSol: 0.1,
  impliedYieldPctPerEpoch: (0.1 / (r2ePrice * R2E_SUPPLY_NOW)) * 100,
  backingRatio: null,
};

const r2eMarket: LaunchMarket = {
  status: "graduated",
  venue: "damm-v2",
  priceSol: r2ePrice,
  priceUsd: null,
  solUsd: null,
  marketCapSol: r2ePrice * R2E_SUPPLY_NOW,
  marketCapUsd: null,
  raise: { targetSol: 0.5, raisedSol: 0.5, progressPct: 100, complete: true },
  liquiditySol: 0.181,
  shareRevenuePerEpochSol: 0.1,
  pricedAtShareRevenuePerEpochSol: null,
  impliedYieldPctPerEpoch: (0.1 / (r2ePrice * R2E_SUPPLY_NOW)) * 100,
  graduation: {
    state: "migrated",
    dammPool: R2E.dammPool,
    dammPoolUrl: addr(R2E.dammPool),
    meteoraUrl: null,
    graduatedEpoch: 6,
    curveCompletedAt: "2026-10-05T22:47:09+05:30",
  },
  day: { volumeSol: 0.922937, trades: 12, buys: 10, sells: 2, priceChangePct: ((r2ePrice - 0.02 / 3446.558893) / (0.02 / 3446.558893)) * 100 },
  freshness: { asOf: "2026-10-05T22:51:41+05:30", ageSeconds: 4, stale: false },
};

const r2eHolders: Omit<LaunchHolders, "schemaVersion" | "kind" | "asOf" | "source" | "note" | "network" | "mint"> = {
  count: { all: 6, buyers: 4 },
  top: [
    { owner: "LARMe5ZxjmuT8RjsLtBvAngkNYj7d8nJXxdDcaerD7E", tokenAccount: "2Ch1mWZMydezAzCFQ3nmJ5QQ1GkTrw89BTtKnsrFF7Lh", amount: 34498.25135, sharePct: 41.3322, label: null },
    { owner: "Ev4XG6dsDw3sC9MZHwBYjdCGujJtY9V1APuDbyzHYEHD", tokenAccount: "ADHb9ypWibS6AbazYe1P4UpHhpv96ut5KrQACyCjS9eF", amount: 27280.734459, sharePct: 32.6849, label: null },
    { owner: null, tokenAccount: "DkmGaE7yjFENAiubSsDuaP8qVKHHs4PDEyAGm8ep29vX", amount: 14425.166832, sharePct: 17.2828, label: "Meteora DAMM v2 pool" },
    { owner: "CJ8YPaCqzvfHBNuxts3QaTLGYr2RB59cAkXceXcfsYWd", tokenAccount: "9VFxe8qkLkGmBVvfUZshfscuoVdfC9G6MftWrTLVQJ8W", amount: 3781.498065, sharePct: 4.5306, label: null },
    { owner: "8pAZsL1VyssU1eAZqCgxmZPFGg2bLC5o6yys1ViJDrf5", tokenAccount: "BLDb4vrdp9wMgrvQbJqw1aWJa6xgxXhak8sxBjjrfj5s", amount: 3446.558893, sharePct: 4.1293, label: null },
    { owner: null, tokenAccount: "9mhsYmJiPTVj8cg3maZWGFaz7dnwfkJkeEe71kNzHiLu", amount: 33.318787, sharePct: 0.0399, label: "Meteora curve vault" },
  ],
  freshness: { asOf: "2026-10-05T22:51:41+05:30", ageSeconds: 4, stale: false },
};

const r2eFees: Omit<LaunchFees, "schemaVersion" | "kind" | "asOf" | "source" | "note" | "network" | "mint"> = {
  partner: {
    address: R2E.treasury,
    tradingFeesSol: { accrued: 0.006299679, claimed: 0.006299679, unclaimed: 0 },
    surplusSol: 0,
    surplusWithdrawn: false,
    migrationFeeSol: 0,
    migrationFeeWithdrawn: false,
  },
  creator: {
    address: R2E.operator,
    migrationFeeSol: 0.350000954,
    migrationFeeWithdrawn: false,
    surplusSol: 0,
    surplusWithdrawn: false,
    tradingFeesSol: { accrued: 0, claimed: 0, unclaimed: 0 },
  },
  lp: {
    positions: [
      { position: R2E.dammPool, owner: R2E.treasury, role: "partner", lockedPct: 100, claimedSol: 0.001235109, unclaimedSol: 0, claimedTokens: 0, unclaimedTokens: 0 },
    ],
    claimedSol: 0.001235109,
    unclaimedSol: 0,
  },
  leftover: { receiver: R2E.treasury, tokens: 0, withdrawn: true, burned: true, burnedTokens: 913465.000155 },
  toLenders: {
    claimedSol: 0.007534788,
    pendingSol: 0,
    holder: R2E.vault,
    note: "Epoch's partner fees (trading fees, surplus, migration fee, LP fees) are claimed into the Epoch lending pool as income; tokens burned, as is the supply the curve never sold.",
  },
  history: [
    { id: "4CtG69:0", signature: "4CtG69qArF9peL8GUjTRqEHbAMxH6ix8uWQXkdPJbVC9PTANXRb3LpVjWEM2XL7PtyksPNdyb3R39AmHBbAviYSo", t: "2026-10-05T22:49:12+05:30", kind: "lpFee", owner: R2E.treasury, solAmount: 0.001235109, tokenAmount: 0, explorerUrl: tx("4CtG69qArF9peL8GUjTRqEHbAMxH6ix8uWQXkdPJbVC9PTANXRb3LpVjWEM2XL7PtyksPNdyb3R39AmHBbAviYSo") },
    { id: "5nPQ3G:0", signature: "5nPQ3GxagAP79cnbWo7GkMF4TWtvYSCw79rtL4ZsLvT7QTfz3UkjjaPLrPExY8y5WXPzt4w8NEFx7kdEKFxwLZL6", t: "2026-10-05T22:49:11+05:30", kind: "leftover", owner: R2E.treasury, solAmount: 0, tokenAmount: 913465.000155, explorerUrl: tx("5nPQ3GxagAP79cnbWo7GkMF4TWtvYSCw79rtL4ZsLvT7QTfz3UkjjaPLrPExY8y5WXPzt4w8NEFx7kdEKFxwLZL6") },
    { id: "22AjkD:0", signature: "22AjkDonzocqBobAzKzZLsL72Lff8comZtEbF9jXfdNuhF1FLpRS1JENse6CJtzs2wM5mJrE9cvzTAk6g9T5RoDX", t: "2026-10-05T22:49:10+05:30", kind: "partnerTradingFee", owner: R2E.treasury, solAmount: 0.006299679, tokenAmount: 0, explorerUrl: tx("22AjkDonzocqBobAzKzZLsL72Lff8comZtEbF9jXfdNuhF1FLpRS1JENse6CJtzs2wM5mJrE9cvzTAk6g9T5RoDX") },
    { id: "4ov8xQ:1", signature: "4ov8xQvpAhxjWLF3sCvREX5tF3wXBGky1ZVdxbQgoYMAGTdXSA1RJPQiChPLcXXnN2Mj9uwEiy512UFX4SHjMo5a", t: "2026-10-05T22:47:24+05:30", kind: "dammPoolCreated", owner: null, solAmount: 0.15, tokenAmount: 0, explorerUrl: tx("4ov8xQvpAhxjWLF3sCvREX5tF3wXBGky1ZVdxbQgoYMAGTdXSA1RJPQiChPLcXXnN2Mj9uwEiy512UFX4SHjMo5a") },
    { id: "qCwKbk:1", signature: "qCwKbkYcLi9VQeTHJGoRmkxUazu3rztXLgocPKEapQWMAXnS3rXTpPCa4rq4unjR1QRmM76scMtppqbBbBJmBc6", t: "2026-10-05T22:47:09+05:30", kind: "curveComplete", owner: null, solAmount: 0.5, tokenAmount: 0, explorerUrl: tx("qCwKbkYcLi9VQeTHJGoRmkxUazu3rztXLgocPKEapQWMAXnS3rXTpPCa4rq4unjR1QRmM76scMtppqbBbBJmBc6") },
  ],
  freshness: { asOf: "2026-10-05T22:51:41+05:30", ageSeconds: 4, stale: false },
};

const r2eBuybacks: LaunchBuybackFeed = {
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-05T22:51:41+05:30",
  source: "Epoch program (local stand-in)",
  network: "localnet",
  mint: R2E.mint,
  revenueToken: R2E.revenueToken,
  vote: R2E.vote,
  venue: "damm-v2",
  term: { shareBps: 500, termEpochs: 100, startEpoch: 1, endEpoch: 100 },
  escrow: { address: R2E.escrow, balanceSol: 0.069366499, mode: "buyback" },
  schedule: { slicesPerEpoch: 4, windowSlots: 48, slicesDoneThisEpoch: 4, paused: false, nextSlice: { epoch: 23, slice: 0, inSlots: 14, etaSeconds: 6, waitsForSweep: true } },
  totals: { escrowedSol: 0.1, spentSol: 0.030633501, burned: 3069.471459, redeemed: 0, redeemedSol: 0, buybacks: 4 },
  buybacks: [
    { epoch: 8, slice: 3, slices: 4, solIn: 0.008220949, tokensBurned: 712.603909, priceSol: 0.008220949 / 712.603909, venue: "damm-v2", signature: "2BdabRK38zDarKV4Wvw5dFQKbMftDwUwbFqSwu1QRuTaPTEXNfgonrseraW9SwCTtFKDLrY3f9Zeno4mDddXWp7p" },
    { epoch: 8, slice: 2, slices: 4, solIn: 0.007833952, tokensBurned: 747.806675, priceSol: 0.007833952 / 747.806675, venue: "damm-v2", signature: "2QWaeWx5g54GZJttZeNSzcAzjRTeLLGBba7RWFRMUE1EHXg8jBQPBwAjTRnEzPDingWhaet2iQiGSoeKvBRRHLdw" },
    { epoch: 8, slice: 1, slices: 4, solIn: 0.007465172, tokensBurned: 784.748357, priceSol: 0.007465172 / 784.748357, venue: "damm-v2", signature: "2t1kLupbXLkTzApGcQndK1tGHTmjLCUPXsku4HBNHgVA6MbAu1hYyQ8ijcVYrPisZzFgcowPdNYSE4eRYdts6jyf" },
    { epoch: 8, slice: 0, slices: 4, solIn: 0.007113428, tokensBurned: 824.312518, priceSol: 0.007113428 / 824.312518, venue: "damm-v2", signature: "4dJmQfFFnomgU9Rug1uqkVFyd1btk2iNNprKDyFttKQGq5Ht9VMmv9Kpob5Q1m5QGsPuPFG2tZ8Es1gWNnB5Kefa" },
  ],
  treasury: {
    address: R2E.treasury,
    totals: { toLendersSol: 0.007534788, tokensBurned: 913465.000155, claims: 3 },
    byKind: {
      tradingFee: { toLendersSol: 0.006299679, tokensBurned: 0, claims: 1 },
      surplus: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      migrationFee: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      leftover: { toLendersSol: 0, tokensBurned: 913465.000155, claims: 1 },
      lpFee: { toLendersSol: 0.001235109, tokensBurned: 0, claims: 1 },
    },
    claims: [
      { kind: "lpFee", epoch: 9, source: R2E.dammPool, position: R2E.dammPool, toLendersSol: 0.001235109, tokensBurned: 0, signature: "4CtG69qArF9peL8GUjTRqEHbAMxH6ix8uWQXkdPJbVC9PTANXRb3LpVjWEM2XL7PtyksPNdyb3R39AmHBbAviYSo" },
      { kind: "leftover", epoch: 9, source: R2E.dbcPool, position: null, toLendersSol: 0, tokensBurned: 913465.000155, signature: "5nPQ3GxagAP79cnbWo7GkMF4TWtvYSCw79rtL4ZsLvT7QTfz3UkjjaPLrPExY8y5WXPzt4w8NEFx7kdEKFxwLZL6" },
      { kind: "tradingFee", epoch: 9, source: R2E.dbcPool, position: null, toLendersSol: 0.006299679, tokensBurned: 0, signature: "22AjkDonzocqBobAzKzZLsL72Lff8comZtEbF9jXfdNuhF1FLpRS1JENse6CJtzs2wM5mJrE9cvzTAk6g9T5RoDX" },
    ],
    claimable: `/v1/launches/${R2E.mint}/fees`,
  },
};

const r2ePage = (): LaunchPage => ({
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-05T22:51:41+05:30",
  source: "Meteora DBC and DAMM v2 pools on a local stand-in (Meteora's mainnet binaries), the launch registry, the Epoch program",
  note: "Recorded on the local stand-in of 5 Oct 2026 (round 2). The API ran with LAUNCH_CLUSTER=devnet against the local RPC.",
  network: "devnet",
  launch: r2eSummary,
  detail: {
    token: { supply: 1_000_000, burned: 916534.471614, holders: 6, decimals: 6, mintAuthority: null, metadataImmutable: true },
    curve: {
      dbcPool: R2E.dbcPool,
      config: null,
      bandLowSol: 5.68669e-6,
      bandHighSol: 9.00393e-6,
      valuePerTokenSol: 9.47782e-6,
      migrationThresholdSol: 0.5,
      creatorMigrationFeePct: 70,
      lockedLiquidityPct: 100,
      dammPool: R2E.dammPool,
      graduatedEpoch: 6,
    },
    escrow: { address: R2E.escrow, balanceSol: 0.069366499, slicesPerEpoch: 4, mode: "buyback" },
    partnerFeesToSeniorSol: 0.006299679,
    upfrontToValidatorSol: 0.350000954,
    buybacks: [],
    risks: riskLines("Round-2 test validator", 100),
    priceSeries: [],
  },
  market: r2eMarket,
  revenueToken: {
    source: "program",
    address: R2E.revenueToken,
    buybackEscrow: R2E.escrow,
    treasury: R2E.treasury,
    registeredOnChain: true,
    shareBps: 500,
    termEpochs: 100,
    startEpoch: 1,
    endEpoch: 100,
    registeredEpoch: 0,
    status: "graduated",
    dammPool: R2E.dammPool,
    operator: R2E.operator,
    commissionFloorBps: null,
    escrow: { balanceSol: 0.069366499, asOf: "2026-10-05T22:51:41+05:30" },
    buybacks: { slicesPerEpoch: 4, windowSlots: 48, maxSlippageBps: 300, maxImpactBps: 1000, paused: false, redeemOpen: false },
    totals: { escrowedSol: 0.1, spentSol: 0.030633501, boughtTokens: 3069.471459, burnedTokens: 3069.471459, redeemedTokens: 0, redeemedSol: 0, buybacks: 4 },
    note: null,
  },
  trades: r2eTrades,
  candles: { interval: "1m", basis: "trades", candles: candlesFromTrades(r2eTrades, "1m") },
  holders: r2eHolders,
  fees: r2eFees,
  ingest: { running: true, lastPollAt: "2026-10-05T22:51:20+05:30", stale: false, pools: [{ address: R2E.dbcPool, venue: "dbc" }, { address: R2E.dammPool, venue: "damm-v2" }], mode: "websocket", lagSeconds: 1.1, pollSeconds: 30 },
  stream: { channel: `launch:${R2E.mint}` },
  links: linksFor(R2E.mint),
  unavailable: [],
});

// ── rLOC (on the curve, registered; docs/pages/launch.md) ─────────────────────────────────────────────
const LOC = {
  mint: "G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq",
  dbcPool: "AYr4ALrNGSqnxCFuv52NKBfhtXFeQi197bktKEH9NsVp",
  config: "7gs7DvMjnzPxGEFGLbHrtCqSGbvV4R6Resb68C2npsWf",
  escrow: "9wjpf4Uw2w1BQ3SC3mygBz7tUDNi7Fwpu4WRSAL9PHva",
  treasury: "CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP",
  creator: "3Wg6vJYo9jz881tVExLZdBh9x72ZPSUZTwmf5wWANCVJ",
  revenueToken: "3mbboR1eVR4EdUtt64sMMpT4NGe9a466cRdgRZDyLeTd",
  vote: "F8bkJtsc9HhPj9spAQXzGaVYUCtdUMwZVevSvR68d3jB",
};

const locSummary: LaunchSummary = {
  mint: LOC.mint,
  symbol: "rLOC",
  name: "Epoch local revenue token",
  validator: { name: "Local test validator", vote: LOC.vote },
  shareBps: 500,
  termEpochs: 10,
  startEpoch: 1,
  endEpoch: 10,
  status: "curve",
  opensAtEpoch: null,
  raise: { targetSol: 0.5, raisedSol: 0.0198, progressPct: 3.96, buyers: 1 },
  priceSol: 5.80362e-7,
  bandLowSol: 5.68669e-7,
  bandHighSol: 9.00393e-7,
  marketCapSol: 0.5804,
  shareRevenuePerEpochSol: 0,
  impliedYieldPctPerEpoch: null,
  backingRatio: null,
};

const locPage = (): LaunchPage => ({
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-04T11:49:37+05:30",
  source: "Meteora DBC and DAMM v2 pools on devnet, the launch registry (LAUNCHES_PATH), the mainnet validator table; the Launch page's live reads (pools, launch_trades, holders, fees)",
  note: "rLOC: share revenue is 0 until it is known (its vote account is not a mainnet validator with stake).",
  network: "devnet",
  launch: locSummary,
  detail: {
    token: { supply: 1_000_000, burned: 0, holders: 2, decimals: 6, mintAuthority: null, metadataImmutable: true },
    curve: {
      dbcPool: LOC.dbcPool,
      config: LOC.config,
      bandLowSol: 5.68669e-7,
      bandHighSol: 9.00393e-7,
      valuePerTokenSol: 9.47782e-7,
      migrationThresholdSol: 0.5,
      creatorMigrationFeePct: 70,
      lockedLiquidityPct: 100,
      dammPool: null,
      graduatedEpoch: null,
    },
    escrow: { address: LOC.escrow, balanceSol: 0.1, slicesPerEpoch: 12, mode: "buyback" },
    partnerFeesToSeniorSol: 0.00016,
    upfrontToValidatorSol: null,
    buybacks: [],
    risks: riskLines("Local test validator", 10),
    priceSeries: [{ t: "2026-10-04T11:49:37+05:30", epoch: 0, priceSol: 5.80362e-7 }],
  },
  market: {
    status: "curve",
    venue: "dbc",
    priceSol: 5.80362e-7,
    priceUsd: null,
    solUsd: null,
    marketCapSol: 0.5804,
    marketCapUsd: null,
    raise: { targetSol: 0.5, raisedSol: 0.0198, progressPct: 3.96, complete: false },
    liquiditySol: 0.0198,
    shareRevenuePerEpochSol: 0,
    pricedAtShareRevenuePerEpochSol: null,
    impliedYieldPctPerEpoch: null,
    graduation: { state: "curve", dammPool: null, dammPoolUrl: null, meteoraUrl: null, graduatedEpoch: null, curveCompletedAt: null },
    day: { volumeSol: 0, trades: 0, buys: 0, sells: 0, priceChangePct: null },
    freshness: { asOf: "2026-10-04T11:49:45+05:30", ageSeconds: 8, stale: false },
  },
  revenueToken: {
    source: "program",
    address: LOC.revenueToken,
    buybackEscrow: LOC.escrow,
    treasury: LOC.treasury,
    registeredOnChain: true,
    shareBps: 500,
    termEpochs: 10,
    startEpoch: 1,
    endEpoch: 10,
    registeredEpoch: 0,
    status: "curve",
    dammPool: null,
    operator: LOC.creator,
    commissionFloorBps: { inflation: 500, blockRevenue: 1000 },
    escrow: { balanceSol: 0.1, asOf: "2026-10-04T11:49:45+05:30" },
    buybacks: { slicesPerEpoch: 12, windowSlots: 9000, maxSlippageBps: 300, maxImpactBps: 100, paused: false, redeemOpen: false },
    totals: { escrowedSol: 0, spentSol: 0, boughtTokens: 0, burnedTokens: 0, redeemedTokens: 0, redeemedSol: 0, buybacks: 0 },
    note: null,
  },
  trades: [],
  candles: { interval: "15m", basis: "samples", candles: [] },
  holders: {
    count: { all: 2, buyers: 1 },
    top: [],
    freshness: { asOf: "2026-10-04T11:49:45+05:30", ageSeconds: 8, stale: false },
  },
  fees: {
    partner: { address: LOC.treasury, tradingFeesSol: { accrued: 0.00016, claimed: 0, unclaimed: 0.00016 }, surplusSol: 0, surplusWithdrawn: false, migrationFeeSol: 0, migrationFeeWithdrawn: false },
    creator: { address: LOC.creator, migrationFeeSol: 0.350000144, migrationFeeWithdrawn: false, surplusSol: 0, surplusWithdrawn: false, tradingFeesSol: { accrued: 0, claimed: 0, unclaimed: 0 } },
    lp: { positions: [], claimedSol: 0, unclaimedSol: 0 },
    leftover: { receiver: LOC.treasury, tokens: 0, withdrawn: false, burned: false, burnedTokens: 0 },
    toLenders: {
      claimedSol: 0,
      pendingSol: 0.00016,
      holder: null,
      note: "Epoch's partner fees (trading fees, surplus, migration fee, LP fees) are claimed into the Epoch lending pool as income; tokens burned, as is the supply the curve never sold.",
    },
    history: [],
    freshness: { asOf: "2026-10-04T11:49:45+05:30", ageSeconds: 8, stale: false },
  },
  ingest: { running: true, lastPollAt: "2026-10-04T11:49:53+05:30", stale: false, pools: [{ address: LOC.dbcPool, venue: "dbc" }], mode: "websocket", lagSeconds: 0.7, pollSeconds: 30 },
  stream: { channel: `launch:${LOC.mint}` },
  links: linksFor(LOC.mint),
  unavailable: [],
});

const locBuybacks: LaunchBuybackFeed = {
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-04T11:49:53+05:30",
  source: "Epoch program (localnet)",
  network: "localnet",
  mint: LOC.mint,
  revenueToken: LOC.revenueToken,
  vote: LOC.vote,
  venue: "dbc",
  term: { shareBps: 500, termEpochs: 10, startEpoch: 1, endEpoch: 10 },
  escrow: { address: LOC.escrow, balanceSol: 0.1, mode: "buyback" },
  schedule: { slicesPerEpoch: 12, windowSlots: 9000, slicesDoneThisEpoch: 0, paused: false, nextSlice: { epoch: 1, slice: 0, inSlots: 0, etaSeconds: 0, waitsForSweep: true } },
  totals: { escrowedSol: 0, spentSol: 0, burned: 0, redeemed: 0, redeemedSol: 0, buybacks: 0 },
  buybacks: [],
  treasury: {
    address: LOC.treasury,
    totals: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
    byKind: {
      tradingFee: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      surplus: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      migrationFee: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      leftover: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      lpFee: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
    },
    claims: [],
    claimable: `/v1/launches/${LOC.mint}/fees`,
  },
};

// ── rREH (devnet rehearsal of 3–4 Oct, graduated, not registered) ───────────────────────────────────────
const REH = {
  mint: "2gg2Sun6S8EoJq2E9QjrjPf9bENzrveDGCvP9CHM7Tby",
  dbcPool: "FHoX5HBgmWG9x4z95zjmidM9jGVWUjbQ5poaMHZ9HfE1",
  config: "3kZTyWpdohzCLo14rbqDGBWTh3CFcRvkQswxyJFUvWBJ",
  dammPool: "849LsiGbYgC9vRSMiMi3SKrT7C3D3dYPCYX1HD1cGokj",
  position: "Aw6zrpyw47WSTHZ5xBKqdKP2Qy8faJEX2bH4uQSUjNzY",
  treasuryWallet: "AQ3gcCLTPwTHsBhNBTFz94L2kxKevZuywYWobx9H9Mf8",
  validatorWallet: "GjMZo48qTs7nuowtcPYj7K6vtsMiXJbRUePgmK6RF1c1",
  vote: "FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk",
  trader1: "6MTBgCMiLQLbXrMXmWa172Hv2hE2q1wANkfPZD2QMTA5",
};
const devTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const devAddr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

const rehSummary: LaunchSummary = {
  mint: REH.mint,
  symbol: "rREH",
  name: "Epoch rehearsal revenue token",
  validator: { name: "Rehearsal validator", vote: REH.vote },
  shareBps: 500,
  termEpochs: 10,
  startEpoch: 1,
  endEpoch: 10,
  status: "graduated",
  opensAtEpoch: null,
  raise: { targetSol: 0.75, raisedSol: 0.75, progressPct: 100, buyers: 4 },
  priceSol: 0.00000278106,
  bandLowSol: 0.00000204621,
  bandHighSol: 0.00000323984,
  marketCapSol: 2.7811,
  shareRevenuePerEpochSol: 0.099794,
  impliedYieldPctPerEpoch: 3.588,
  backingRatio: null,
};

// [t, slot (estimate except 3818), signature, venue, side, sol, tokens, trader]
const rehRaw: RawTrade[] = [
  ["2026-10-03T19:07:00+05:30", 3410, "P2r3JR57VBGMCntNMaGpGYo5gCiG915M12yNf9C3bq78ByEF6vSaAhAsFEwXZommPWPyYJvxEAgkX947QxHdu9n", "dbc", "buy", 0.2, 89402.418317, REH.trader1],
  ["2026-10-03T19:08:00+05:30", 3540, "4eNgFtUFvSWc63PqCXBaKEr1EbtQSrD6qqq6mUhJfYzYKUxiCrCafyJzjgQX8fPnhgNHvR8n2LxWXmkqJrDYzpZF", "dbc", "buy", 0.15, 59946.428903, ""],
  ["2026-10-03T19:08:20+05:30", 3590, "22sfkw6Bqv8hBTnYRwX4kctFZw3WdhtwVEpaZDMPr5j2f8h9u2hYkRgqg39FMGWMNSFfY16prA48mZEAVUT2k3EA", "dbc", "sell", 0.075281111, 30000, REH.trader1],
  ["2026-10-03T19:10:30+05:30", 3775, "2BbeEkGz5TGgU8J2vczBaqW31v1HmEsM3GCfRGsjfUxzbj3JzMyhfpjHEqy6wKteQS4Z4GsWr4j74harqdThYExX", "damm-v2", "buy", 0.1, 21207.205771, ""],
  ["2026-10-03T19:10:45+05:30", 3790, "5peHujVnzefbTM11oDXgiGbp2jCRGje3KeWdZ7CikXg2cFy1TP3FaM6scqavtdzxxbvaQbRYr6doFxajueWRSfbo", "damm-v2", "sell", 0.162926566, 50000, ""],
  ["2026-10-03T19:10:58+05:30", 3818, "5XoMzRAivewoMTAJRebgspoH8CRhnYGKNx95qkQDeukxe9P2GStqxz3VdyxvSt9DvjCtwMFQT7JT2fcy5rXDyifc", "damm-v2", "buy", 0.05, 23294.177937, REH.trader1],
];
const rehTrades: LaunchTrade[] = toTrades(rehRaw, "1%").map((t) => ({
  ...t,
  trader: t.trader || null,
  explorerUrl: devTx(t.signature),
  // The documented row (docs/pages/launch.md "The feed"): exact price, post-trade price and fee.
  ...(t.signature.startsWith("5XoM") ? { priceSol: 0.0000021207, postPriceSol: 0.00000278106, feeSol: 0.000599946 } : {}),
}));

const rehMarket: LaunchMarket = {
  status: "graduated",
  venue: "damm-v2",
  priceSol: 0.00000278106,
  priceUsd: 0.00033538,
  solUsd: 120.59,
  marketCapSol: 2.7811,
  marketCapUsd: 335.38,
  raise: { targetSol: 0.75, raisedSol: 0.75, progressPct: 100, complete: true },
  liquiditySol: 0.208761,
  shareRevenuePerEpochSol: 0.099794,
  pricedAtShareRevenuePerEpochSol: 0.341036,
  impliedYieldPctPerEpoch: 3.588,
  graduation: {
    state: "migrated",
    dammPool: REH.dammPool,
    dammPoolUrl: devAddr(REH.dammPool),
    meteoraUrl: null,
    graduatedEpoch: 2,
    curveCompletedAt: "2026-10-03T19:08:39+05:30",
  },
  day: { volumeSol: 1.222593, trades: 8, buys: 6, sells: 2, priceChangePct: 2.94 },
  freshness: { asOf: "2026-10-04T09:40:24+05:30", ageSeconds: 5, stale: false },
};

const rehPage = (): LaunchPage => ({
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-04T09:40:29+05:30",
  source: "Meteora DBC and DAMM v2 pools on the devnet rehearsal (local stand-in), the launch registry, the mainnet validator table",
  note: "Recorded in the devnet rehearsal of 3–4 Oct 2026. rREH is not registered with the program: its fee claimer is a plain wallet, not Epoch's treasury PDA.",
  network: "devnet",
  launch: rehSummary,
  detail: {
    token: { supply: 1_000_000, burned: 0, holders: 7, decimals: 6, mintAuthority: null, metadataImmutable: true },
    curve: {
      dbcPool: REH.dbcPool,
      config: REH.config,
      bandLowSol: 0.00000204621,
      bandHighSol: 0.00000323984,
      valuePerTokenSol: 0.00000341036,
      migrationThresholdSol: 0.75,
      creatorMigrationFeePct: 70,
      lockedLiquidityPct: 100,
      dammPool: REH.dammPool,
      graduatedEpoch: 2,
    },
    escrow: { address: null, balanceSol: 0, slicesPerEpoch: 12, mode: "buyback" },
    partnerFeesToSeniorSol: 0,
    upfrontToValidatorSol: 0.52500027,
    buybacks: [],
    risks: riskLines("Rehearsal validator", 10),
    priceSeries: [],
  },
  market: rehMarket,
  revenueToken: {
    source: "registry",
    address: "7aetwDmDhhbJVndMXuvRW2rYfdibF32HkcA4nqYFztjh",
    buybackEscrow: "JgrRFypWwn9XtDjfCiXBmuTK4hMB6MaHFJhP5a4MFiF",
    treasury: "CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP",
    registeredOnChain: false,
    shareBps: 500,
    termEpochs: 10,
    startEpoch: 1,
    endEpoch: 10,
    registeredEpoch: null,
    status: null,
    dammPool: null,
    operator: null,
    commissionFloorBps: null,
    escrow: null,
    buybacks: null,
    totals: null,
    note: "Not registered with the program yet: the terms are the launch record's.",
  },
  trades: rehTrades,
  candles: { interval: "1m", basis: "trades", candles: candlesFromTrades(rehTrades, "1m") },
  holders: {
    count: { all: 7, buyers: 4 },
    top: [
      { owner: REH.treasuryWallet, tokenAccount: "AdrJmJmmjTS2qW1sQveNA1Rfqpzn83v9DxnNsdknxuYe", amount: 639263.000567, sharePct: 63.9263, label: "Epoch's treasury" },
      { owner: "CuioAkwCMnBr7gb4wCSqFi9baBEkpv6uj4VuyHwhqaWu", tokenAccount: "EGA2T4D71udPCGe8cHB65Jp3WmxrYhAgFjnozfHTvD1g", amount: 112329.360287, sharePct: 11.2329, label: null },
      { owner: "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC", tokenAccount: "BADjSsMk5dARWTSu5vMa2ACYrW4VJdsDM6KPaWjVbFGQ", amount: 74807.645655, sharePct: 7.4808, label: "Meteora DAMM v2 pool" },
      { owner: "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", tokenAccount: "6bRDSFxaXs3BVy9j9jL3r4QcJ1gcboLK5WeFf48aXHU1", amount: 138.895778, sharePct: 0.0139, label: "Meteora curve vault" },
    ],
    freshness: { asOf: "2026-10-04T09:40:29+05:30", ageSeconds: 0, stale: false },
  },
  fees: {
    partner: { address: REH.treasuryWallet, tradingFeesSol: { accrued: 0.00728342, claimed: 0.00728342, unclaimed: 0 }, surplusSol: 0, surplusWithdrawn: false, migrationFeeSol: 0, migrationFeeWithdrawn: false },
    creator: { address: REH.validatorWallet, migrationFeeSol: 0.52500027, migrationFeeWithdrawn: true, surplusSol: 0, surplusWithdrawn: false, tradingFeesSol: { accrued: 0, claimed: 0, unclaimed: 0 } },
    lp: {
      positions: [{ position: REH.position, owner: REH.treasuryWallet, role: "partner", lockedPct: 100, claimedSol: 0.003613643, unclaimedSol: 0, claimedTokens: 0, unclaimedTokens: 0 }],
      claimedSol: 0.003613643,
      unclaimedSol: 0,
    },
    leftover: { receiver: REH.treasuryWallet, tokens: 0, withdrawn: true, burned: false, burnedTokens: 0 },
    toLenders: {
      claimedSol: 0.010897063,
      pendingSol: 0,
      holder: REH.treasuryWallet,
      note: "rREH's fee claimer is a plain wallet (the rehearsal ran before the program's treasury PDA): claimed SOL is what that wallet claimed, and the leftover it withdrew was not burned.",
    },
    history: [
      { id: "5VHNHc:0", signature: "5VHNHcgvx5rrXLNYtK5AWHxYsNGTqFvbMUURG3A2ruWr8wkVcGxfQYCPhVZxGeXotj8U4pzuiZw15ZKkXPynoHB7", t: "2026-10-03T19:46:49+05:30", kind: "lpFee", owner: REH.treasuryWallet, solAmount: 0.000750739, tokenAmount: 0, explorerUrl: devTx("5VHNHcgvx5rrXLNYtK5AWHxYsNGTqFvbMUURG3A2ruWr8wkVcGxfQYCPhVZxGeXotj8U4pzuiZw15ZKkXPynoHB7") },
      { id: "3jwxeM:0", signature: "3jwxeMW7MEBSffjn4kUeqwxbm4RFxrA1R3jYHZGq6rADcw8tgb1xYcihJpiggwgfPc68bmqphae632SD1bkdyyND", t: "2026-10-03T19:11:50+05:30", kind: "lpFee", owner: REH.treasuryWallet, solAmount: 0.002862904, tokenAmount: 0, explorerUrl: devTx("3jwxeMW7MEBSffjn4kUeqwxbm4RFxrA1R3jYHZGq6rADcw8tgb1xYcihJpiggwgfPc68bmqphae632SD1bkdyyND") },
      { id: "4e5Kfe:0", signature: "4e5Kfe54otZhsmSCTnTGNYRH9ggRUjahr8UAzBfKGUv6L1dTPGLKiqSmJXjQ1v8KivifRnv5j1g74xn6PkSwJcxy", t: "2026-10-03T19:11:47+05:30", kind: "leftover", owner: REH.treasuryWallet, solAmount: 0, tokenAmount: 639263.000567, explorerUrl: devTx("4e5Kfe54otZhsmSCTnTGNYRH9ggRUjahr8UAzBfKGUv6L1dTPGLKiqSmJXjQ1v8KivifRnv5j1g74xn6PkSwJcxy") },
      { id: "3f35E7:0", signature: "3f35E7FznPXTAyickGWua4xJpicDkcnuXBJdCsonET1yuooMMAWztC9Yiks5ravjKf8m169og2gYTdrtYhYpNPuK", t: "2026-10-03T19:11:43+05:30", kind: "creatorMigrationFee", owner: REH.validatorWallet, solAmount: 0.52500027, tokenAmount: 0, explorerUrl: devTx("3f35E7FznPXTAyickGWua4xJpicDkcnuXBJdCsonET1yuooMMAWztC9Yiks5ravjKf8m169og2gYTdrtYhYpNPuK") },
      { id: "4SoGHp:0", signature: "4SoGHp34nQGc7hyYpBAqhm9awJ8ShcEU45uK2ALWgrsbUnL23Rg9GRYzT2uKQqWFBazDpjCXuToBp8HEimb92HV8", t: "2026-10-03T19:11:40+05:30", kind: "partnerTradingFee", owner: REH.treasuryWallet, solAmount: 0.00728342, tokenAmount: 0, explorerUrl: devTx("4SoGHp34nQGc7hyYpBAqhm9awJ8ShcEU45uK2ALWgrsbUnL23Rg9GRYzT2uKQqWFBazDpjCXuToBp8HEimb92HV8") },
      { id: "3StAiD:0", signature: "3StAiDQNbSBo9SWy4MPPDYzn27UR3G3g4jUvAqdEGYubif3oWZ1iVZwKDGDtSoo8qLZYQkS5HG4B5xpjE8qFCcri", t: "2026-10-03T19:10:00+05:30", kind: "dammPoolCreated", owner: null, solAmount: 0.224550116, tokenAmount: 69309.029363, explorerUrl: devTx("3StAiDQNbSBo9SWy4MPPDYzn27UR3G3g4jUvAqdEGYubif3oWZ1iVZwKDGDtSoo8qLZYQkS5HG4B5xpjE8qFCcri") },
      { id: "3Qnwy:2", signature: "3QnwyUkzdN8fq6z4ttDSsJXPyveMCrCSdH3iPH6V9Z66ke4CkmbLjKVjaRTdBacSjZnCY4RuhvUPSJiUQx1FGyav", t: "2026-10-03T19:08:39+05:30", kind: "curveComplete", owner: null, solAmount: 0.750000387, tokenAmount: 708710.925708, explorerUrl: devTx("3QnwyUkzdN8fq6z4ttDSsJXPyveMCrCSdH3iPH6V9Z66ke4CkmbLjKVjaRTdBacSjZnCY4RuhvUPSJiUQx1FGyav") },
    ],
    freshness: { asOf: "2026-10-04T09:47:00+05:30", ageSeconds: 6, stale: false },
  },
  ingest: { running: true, lastPollAt: "2026-10-04T09:41:55+05:30", stale: false, pools: [{ address: REH.dbcPool, venue: "dbc" }, { address: REH.dammPool, venue: "damm-v2" }], mode: "websocket", lagSeconds: 0.7, pollSeconds: 30 },
  stream: { channel: `launch:${REH.mint}` },
  links: linksFor(REH.mint),
  unavailable: [],
});

const rehBuybacks: LaunchBuybackFeed = {
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-04T12:14:00+05:30",
  source: "Epoch program (devnet rehearsal)",
  note: "No validator has registered this mint as a revenue token.",
  network: "devnet",
  mint: REH.mint,
  revenueToken: null,
  vote: null,
  venue: null,
  term: null,
  escrow: { address: null, balanceSol: 0, mode: "buyback" },
  schedule: null,
  totals: { escrowedSol: 0, spentSol: 0, burned: 0, redeemed: 0, redeemedSol: 0, buybacks: 0 },
  buybacks: [],
  treasury: {
    address: "CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP",
    totals: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
    byKind: {
      tradingFee: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      surplus: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      migrationFee: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      leftover: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      lpFee: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
    },
    claims: [],
    claimable: `/v1/launches/${REH.mint}/fees`,
  },
};

export const launchesSample = (): LaunchList => ({
  schemaVersion: 1,
  kind: "real",
  asOf: "2026-10-05T22:51:41+05:30",
  source: "the launch registry and the Meteora pools (recorded on the local stand-in and the 3 Oct rehearsal)",
  network: "devnet",
  launches: [locSummary, r2eSummary, rehSummary],
});

/** The first-paint bundle by mint or symbol (case-insensitive), or null for an unknown token. */
export function launchPageSample(key: string): LaunchPage | null {
  const k = key.toLowerCase();
  if (k === "rr2e" || k === R2E.mint.toLowerCase()) return r2ePage();
  if (k === "rloc" || k === LOC.mint.toLowerCase()) return locPage();
  if (k === "rreh" || k === REH.mint.toLowerCase()) return rehPage();
  return null;
}

export function launchBuybacksSample(mint: string): LaunchBuybackFeed | null {
  if (mint === R2E.mint) return r2eBuybacks;
  if (mint === LOC.mint) return locBuybacks;
  if (mint === REH.mint) return rehBuybacks;
  return null;
}

export function launchCandlesSample(mint: string, interval: LaunchCandleInterval): LaunchCandles {
  const page = launchPageSample(mint);
  const trades = page?.trades ?? [];
  const candles = candlesFromTrades(trades, interval);
  return {
    schemaVersion: 1,
    kind: "real",
    asOf: page?.asOf ?? new Date(0).toISOString(),
    source: "launch_trades",
    network: "devnet",
    mint,
    interval,
    candles,
    basis: candles.length ? "trades" : "none",
  };
}

function linksFor(mint: string) {
  return {
    buybacks: `/v1/launches/${mint}/buybacks`,
    trades: `/v1/launches/${mint}/trades`,
    candles: `/v1/launches/${mint}/candles`,
    holders: `/v1/launches/${mint}/holders`,
    fees: `/v1/launches/${mint}/fees`,
  };
}

function riskLines(validator: string, endEpoch: number): string[] {
  return [
    `The backing is ${validator}'s revenue: if it earns less, the buybacks are smaller.`,
    `The share is bought back only until epoch ${endEpoch}; after that the escrow's rest is bought back or redeemed and nothing new comes in.`,
    "The price on Meteora can move a lot in a small pool; buybacks run in slices with a price-impact cap.",
    "Devnet demo. A revenue token can be a security in many countries; nothing here is an offer.",
  ];
}
