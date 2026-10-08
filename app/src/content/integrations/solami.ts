// Solami side track: the Live page. Sources: packages/indexer_app/README.md ("Solami across the repo", "Beam"),
// docs/pages/live.md, docs/GO_LIVE_SIDE_TRACKS.md §2 (verified runs).
import type { Integration } from "./types";

export const solami: Integration = {
  id: "solami",
  sponsor: "Solami",
  track: "Solami side track",
  prize: "3,000 USDG",
  judgedOn: ["Solami usage: RPC, Yellowstone gRPC, Beam", "A working mainnet demo", "Build quality", "Usefulness", "Creativity"],
  page: { href: "/live", label: "Live" },
  headline: "The Solana Fee Index, streamed from mainnet through Solami",
  oneLiner:
    "The Solana Fee Index computed live from every mainnet block, streamed through Solami's Yellowstone gRPC, gap-filled over Solami RPC and posted on chain through Solami Beam.",
  products: [
    {
      product: "Yellowstone gRPC",
      use: "indexer_app subscribes to the mainnet firehose at confirmed: every non-vote transaction, block meta and slot, replayed from the last slot on reconnect. On a plan stream it runs hybrid: block meta over gRPC, each block over Solami RPC. api_app holds the second stream for the slot ticker and the Epoch program's mainnet transactions.",
      calls: ["Subscribe: transactions { vote: false } · blocksMeta · slots", "from_slot replay", "SubscribeReplayInfo · GetSlot"],
      files: [
        { label: "SlotRequest.ts", path: "packages/indexer_app/src/Streams/SlotRequest.ts" },
        { label: "GrpcBlockAssembler.ts", path: "packages/indexer_app/src/Blocks/GrpcBlockAssembler.ts" },
        { label: "GrpcStream.ts", path: "packages/solana/src/GrpcStream.ts" },
        { label: "SolamiStream.ts (API)", path: "packages/api_app/src/Sources/SolamiStream.ts" },
      ],
    },
    {
      product: "Solami RPC",
      use: "Fills every gap the stream missed, snapshots the leader schedule and each leader's stake (the index's weights), and serves blocks in hybrid and RPC mode. The API's mainnet reads use it too.",
      calls: ["getBlock", "getSlotLeaders", "getVoteAccounts", "getSlot · getEpochInfo"],
      files: [
        { label: "BlockFetcher.ts", path: "packages/indexer_app/src/Streams/BlockFetcher.ts" },
        { label: "LeaderSchedule.ts", path: "packages/indexer_app/src/Chain/LeaderSchedule.ts" },
        { label: "StakeSnapshots.ts", path: "packages/indexer_app/src/Chain/StakeSnapshots.ts" },
      ],
    },
    {
      product: "Beam",
      use: "Every mainnet transaction Epoch signs goes out through Beam: the publisher's post_index (the epoch's index on chain) and every crank send. Each is simulated first, tipped to a live tip address, then confirmed; landings and tips are counted.",
      calls: ["GET api.solami.dev/onchain/tip-addresses", "sendTransaction (tipped) via Beam", "GET api.solami.dev/swqos/tx/{signature}"],
      files: [
        { label: "Beam.ts", path: "packages/solana/src/Beam.ts" },
        { label: "TransactionSender.ts", path: "packages/solana/src/TransactionSender.ts" },
      ],
    },
    {
      product: "Usage report",
      use: "Each component counts what it used of Solami (stream bytes and lag, RPC calls by method with p50/p95, Beam sends, landings and tips) and the API serves it at GET /v1/live/solami: the panel on this page.",
      calls: ["GET /v1/live/solami"],
      files: [
        { label: "SolamiUsage.ts", path: "packages/solana/src/SolamiUsage.ts" },
        { label: "LiveService.ts", path: "packages/api_app/src/Services/Live/LiveService.ts" },
      ],
    },
  ],
  flows: [
    {
      title: "Read path: from a mainnet block to this page",
      nodes: [
        { title: "Solami Yellowstone gRPC", detail: "firehose or block meta · confirmed", kind: "sponsor" },
        { title: "indexer_app", detail: "slot median (leader-paid out) · running stake-weighted median", kind: "ours" },
        { title: "Postgres", detail: "slot_fees · live_slots · fee_index_live · NOTIFY", kind: "ours" },
        { title: "api_app", detail: "/v1/live · WS slots, index:live", kind: "ours" },
        { title: "Live page", detail: "one bar per block · the index every ≈ 2 s", kind: "page" },
      ],
      edges: ["≈ 1 s", "one transaction per block", "LISTEN", "WebSocket"],
    },
    {
      title: "Write path: the epoch's value on chain",
      nodes: [
        { title: "epoch_index", detail: "written once every slot of the epoch is accounted for", kind: "ours" },
        { title: "publisher_app", detail: "post_index with the inputs hash", kind: "ours" },
        { title: "Solami Beam", detail: "simulated, tipped, sent", kind: "sponsor" },
        { title: "Epoch program", detail: "FeeIndex account · dispute window → final", kind: "chain" },
      ],
      edges: ["epoch rolls up", "signed tx", "lands"],
    },
  ],
  why: {
    problem:
      "Validators earn priority fees, but nobody can price them: Solana has no reference rate for block space. A lender sizing an advance, a validator hedging its income or a market asking where fees go all need one number per epoch that anyone can check.",
    unlocks: [
      "The Solana Fee Index: the stake-weighted median priority fee across slot leaders, computed from every mainnet block, with leader-paid transactions left out so no leader can set its own number.",
      "Per-block data within about a second and the epoch's running value every 2 seconds, which only a streamed firehose makes cheap enough to run all the time.",
      "A value posted on chain each epoch: the Fee Market settles on it and Epoch's Panta markets resolve from it.",
    ],
  },
  runs: [
    {
      title: "Mainnet smoke run crossed an epoch boundary live",
      when: "5 Oct 2026, 19:30 IST",
      result: "Epoch 1049 → 1050",
      detail: "indexer_app and api_app on public mainnet RPC, without a Solami key: the run kept indexing as mainnet moved from epoch 1049 to 1050.",
      link: { label: "GO_LIVE_SIDE_TRACKS.md §2", path: "docs/GO_LIVE_SIDE_TRACKS.md" },
    },
    {
      title: "No lost slots",
      when: "4 Oct 2026, 09:09-09:12 IST",
      result: "68 blocks, none lost",
      detail: "Every block of the window was indexed in order on public mainnet RPC.",
      link: { label: "GO_LIVE_SIDE_TRACKS.md §2", path: "docs/GO_LIVE_SIDE_TRACKS.md" },
    },
    {
      title: "Solami endpoints checked",
      when: "5 Oct 2026",
      result: "gRPC zstd + gzip · tip list",
      detail: "pnpm solami:check: grpc.solami.dev answered GetVersion, SubscribeReplayInfo and GetSlot over zstd and gzip; the tip-address API listed 15 addresses.",
      link: { label: "indexer_app README · Verify", path: "packages/indexer_app/README.md" },
    },
  ],
  next: "Streaming with a paid Solami key and the first real Beam landings run once the key is set; the usage panel above shows them as they happen, never before.",
  docs: [
    { label: "Page contract (live.md)", path: "docs/pages/live.md" },
    { label: "indexer_app README: run it with your own key", path: "packages/indexer_app/README.md" },
    { label: "Fee Index methodology", path: "docs/FEE_INDEX_METHODOLOGY.md" },
  ],
};
