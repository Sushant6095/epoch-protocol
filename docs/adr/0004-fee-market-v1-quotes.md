# ADR 0004: Fee Market v1 uses quotes, not an order book

**Status:** accepted · 27 Sep 2026

**Context.** A matching engine plus margining is too much for the remaining days, and a new market would have no second side anyway.

**Decision.** v1 swaps trade against a seeded market-maker vault at a posted fixed rate per epoch (`FeeQuote`). Quotes close before the epoch starts. Settlement uses the posted index with a bounded move and a dispute window.

**Consequences.** Simpler program and a reliable demo; we disclose that we seed the other side. A price-time order book replaces quotes in v2.
