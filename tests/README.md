# Tests

- `epoch.test.ts`: Anchor integration tests (pool, credit, fee market)
- LiteSVM tests that warp across epoch boundaries to test sweeps without waiting 2 days

Day 1 test (checkpoint CP1): on testnet, confirm a program PDA as vote-account withdrawer can
withdraw via CPI, update the commission collector, block commission changes and block closing.
