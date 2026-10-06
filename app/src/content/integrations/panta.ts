// Panta side track: the Predict page. Sources: docs/pages/predict.md, packages/panta/README.md,
// packages/api_app/README.md ("Real-money Predict through Panta"), docs/FEE_INDEX_METHODOLOGY.md (verified run).
import type { Integration } from "./types";

export const panta: Integration = {
  id: "panta",
  sponsor: "Panta",
  track: "Panta API side track",
  prize: "5,000 USDG",
  judgedOn: ["Panta API integration depth", "Execution", "Product and UX", "Originality", "Impact", "Traction"],
  page: { href: "/predict", label: "Predict" },
  headline: "Real-USDC markets on the Solana Fee Index, through Panta",
  oneLiner:
    "Every epoch Epoch's bot opens real-USDC markets on Panta on Epoch's own number, the Solana Fee Index; people trade them and Panta's catalog from this page, every trade attributed to Epoch, and each market resolves from Epoch's on-chain index.",
  products: [
    {
      product: "Market creation (Panta API)",
      use: "panta_bot_app opens a strike ladder each epoch: \"Will the Solana Fee Index for epoch N close above X µL/CU?\", with trading closing before epoch N starts, the resolution rule and Epoch's endpoint as the source of truth.",
      calls: ["POST /markets/create/quote/", "POST /markets/create/build/", "POST /markets/register/", "POST /claim/creator-fees/build/"],
      files: [
        { label: "MarketLifecycle.ts (bot)", path: "packages/panta_bot_app/src/MarketLifecycle.ts" },
        { label: "Thresholds.ts (strike ladder)", path: "packages/panta_bot_app/src/Markets/Thresholds.ts" },
        { label: "MarketText.ts (rule and sources)", path: "packages/panta_bot_app/src/Markets/MarketText.ts" },
      ],
    },
    {
      product: "Markets, prices and positions",
      use: "The API reads Panta's catalog, each of Epoch's markets with live prices and its public tape, categories and a wallet's positions, caches them 15 s, and pushes Epoch's prices on WS predict:panta. Payloads carry asOf and stale so nothing cached is shown as live.",
      calls: ["GET /markets/", "GET /markets/{id}/", "GET /markets/{id}/trades/", "GET /categories/", "GET /positions/"],
      files: [
        { label: "PantaService.ts", path: "packages/api_app/src/Services/Panta/PantaService.ts" },
        { label: "PantaStreamPoller.ts", path: "packages/api_app/src/Services/Panta/PantaStreamPoller.ts" },
        { label: "client.ts (typed Panta client)", path: "packages/panta/src/client.ts" },
      ],
    },
    {
      product: "Trading and claims",
      use: "Quote, then build after the user ticks consent: Panta's instructions are compiled into one unsigned transaction with the wallet as the only signer; the wallet signs it unchanged, Epoch checks the message hash and broadcasts, Panta is told, and status follows the signature. Claims use the same path.",
      calls: ["POST /primaryorderquote/", "POST /primaryorderbuild/", "POST /primaryordersubmit/", "POST /primaryorderverify/", "POST /claim/build/"],
      files: [
        { label: "PantaRouters.ts", path: "packages/api_app/src/Routes/PantaRouters.ts" },
        { label: "transactions.ts (compile, hash)", path: "packages/panta/src/transactions.ts" },
      ],
    },
    {
      product: "Attribution and traction",
      use: "Every confirmed trade through Epoch is reported to Panta until Panta answers processed; the traction strip on this page joins Panta's account endpoints with Epoch's own records.",
      calls: ["POST /trades/", "GET /trades/{signature}/", "GET /account/dashboard/", "GET /account/metrics/", "GET /account/creates/", "GET /account/trades/"],
      files: [
        { label: "PantaStores.ts", path: "packages/api_app/src/Services/Panta/PantaStores.ts" },
        { label: "budget.ts (rate budget)", path: "packages/panta/src/budget.ts" },
      ],
    },
    {
      product: "Crowd forecast",
      use: "The YES prices across one epoch's strikes are fitted (monotonic, then lognormal) into the crowd's forecast of that epoch's Fee Index, shown next to the index Solami streams live.",
      calls: ["GET /v1/predict/panta/forecast", "GET /v1/index/forecast"],
      files: [{ label: "CrowdForecast.ts", path: "packages/api_app/src/Services/Panta/CrowdForecast.ts" }],
    },
  ],
  flows: [
    {
      title: "A trade, from this page to Panta",
      nodes: [
        { title: "Predict page", detail: "quote · consent · wallet signs", kind: "page" },
        { title: "api_app", detail: "/v1/predict/panta: quote, build, submit, status", kind: "ours" },
        { title: "Panta API", detail: "primary order quote, build, submit, verify", kind: "sponsor" },
        { title: "Solana mainnet", detail: "USDC trade · attributed to Epoch", kind: "chain" },
      ],
      edges: ["session cookie", "API key (server only)", "signed tx"],
    },
    {
      title: "A market, from the index to its resolution",
      nodes: [
        { title: "Solana Fee Index", detail: "computed live from mainnet (Live page)", kind: "ours" },
        { title: "panta_bot_app", detail: "strike ladder for epoch N", kind: "ours" },
        { title: "Panta", detail: "real-USDC YES/NO market", kind: "sponsor" },
        { title: "/v1/index/epochs/N", detail: "final value · resolution source", kind: "chain" },
      ],
      edges: ["recent finals", "create · register", "resolves from"],
    },
  ],
  why: {
    problem:
      "Prediction markets need questions people care about and an answer anyone can verify. Block-space prices matter to every validator, searcher and app on Solana, but there was no public number to settle on.",
    unlocks: [
      "A new market every epoch on a number Epoch publishes on chain, with trading closed before the epoch starts so nobody trades while watching its fees.",
      "A crowd forecast of next epoch's fees, read from the strike ladder's prices: a signal validators and lenders can use before the epoch begins.",
      "Panta's whole catalog inside Epoch, with consent before every transaction, the key kept on the server and every trade attributed.",
    ],
  },
  runs: [
    {
      title: "Index to final, end to end",
      when: "5 Oct 2026, 20:28 IST",
      result: "13 / 13 checks",
      detail: "On a local validator with the program built from this repository: an epoch_index row → publisher_app posts it → the dispute window → finalize_index → GET /v1/index/epochs/{N} answers final with both signatures, and the bot's strike source reads it as final.",
      link: { label: "FEE_INDEX_METHODOLOGY.md · Verified end to end", path: "docs/FEE_INDEX_METHODOLOGY.md" },
    },
    {
      title: "Client reconciled with the live API",
      when: "5 Oct 2026",
      result: "docs vs live shapes",
      detail: "Every request body and answer was compared with Panta's official playground (written against the live API); the client reads both formats where they differ.",
      link: { label: "packages/panta README", path: "packages/panta/README.md" },
    },
  ],
  next: "Real-money trading switches on with Epoch's Panta key on the server; until then the Real tab says so and the traction strip shows only what Panta reports.",
  docs: [
    { label: "Page contract (predict.md)", path: "docs/pages/predict.md" },
    { label: "API: real-money Predict through Panta", path: "packages/api_app/README.md" },
    { label: "Fee Index methodology (resolution)", path: "docs/FEE_INDEX_METHODOLOGY.md" },
  ],
};
