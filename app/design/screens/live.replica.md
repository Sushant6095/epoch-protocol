# Live · replica notes (round 3, 6 Oct 2026)

References: the kit's Terminal lock, Mercury Insights `18cf9c6a` (hero metric over one large chart, side cards, docked
tables) with the Kraken Pro strip and tables `69751349` (the KPI strip), as the brief asked for a pro data console. Read
from the blueprint and the Refero descriptions; reference images were not available (DECISIONS, 6 Oct).

| Region | Built as | Library |
| --- | --- | --- |
| Title row + KPI strip (Kraken Pro) | Title, Live/Stale badge, strip: epoch, tip slot, processed, lag, stream, leaders priced, priced txs | `KeyValue` |
| Main chart | Running index (NumberFlow only while live) over the slot strip: one box plot per block, log scale, index line | lightweight-charts |
| Side panels | Stream health; distribution of slot medians with the percentiles; Powered by Solami (gRPC, RPC, Beam counters) | Recharts via shadcn `chart` |
| Docked tables | Leaders · Recent blocks (`?tab=`) | TanStack Table v9 |

Difference: no Mercury sidebar (the sponsor build uses a header nav, DECISIONS 6 Oct).
