# Predict · replica notes (round 3, 6 Oct 2026)

Reference: Stocktwits poll `50c3c89d`, with the Kraken Pro order form for the ticket, Reown's preview for the review and
Coinbase's gate. Reference images were not available (DECISIONS, 6 Oct).

| Region | Built as | Library |
| --- | --- | --- |
| Title + tabs | Real · USDC via Panta / Points (`?tab=`), Powered by Panta | shadcn `tabs` |
| Ticker | Live index (Solami), last final, open strikes with Yes prices | plain |
| Traction | Epoch on Panta: markets, volumes, traders, trades, creator fees | `KeyValue` |
| Poll card | The featured market: Yes/No bars, volume, closes, resolves, threshold, resolution source | plain |
| Forecast | Survival curve from the crowd's prices, band, median, implied dots, live index | Recharts |
| Ladder, intelligence, tape, resolution, catalog | Strike ladder by epoch; Panta intelligence; market tape; how it resolves; Panta's catalog with search | plain, `collapsible` |
| Ticket (sticky) | Yes/No, amount chips, quote rows, summary verbatim + consent, gate, stepper; positions and claims | `toggle-group`, ReUI stepper |
