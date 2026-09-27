# ADR 0003: Share-based tranche accounting

**Status:** accepted · 27 Sep 2026

**Context.** Token-2022's interest-bearing extension only changes the displayed amount and can't express junior's residual returns or losses.

**Decision.** Standard SPL mints for senior and junior shares. Price = tracked assets / shares, with virtual shares and assets to block first-depositor inflation. Assets are tracked in `Pool`, never read from the vault balance.

**Consequences.** Share prices move only when real repayments or losses are recorded, which is also what the demo shows.
