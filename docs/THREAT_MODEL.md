# Threat model

| Threat | Mitigation |
| --- | --- |
| Validator redirects block fees | Collector change needs the withdrawer's signature (our PDA) |
| Validator cuts commission / closes vote account | Both need the withdrawer's signature (verify on testnet day 1) |
| Validator stops running | Late → default after 3 epochs; bond → junior → loss reserve |
| Program bug | Per-validator and pool caps; pause; Squads multisig upgrades with timelock; checked maths |
| First-depositor share inflation | Seed deposit; internal asset accounting; minimum deposit |
| Rounding drift | Round in pool's favour; invariant checks after every instruction; fuzz tests |
| Double sweep | `last_swept_epoch` check |
| Scoring before rewards finish | Wait for epoch reward distribution to complete |
| Index publisher compromised or gamed | Bounded moves; dispute window; leader-paid txs excluded; stake-weighted median |
| Trading on a known index | Orders for epoch N close before epoch N starts |
| Lender run | Withdrawal queue; junior lock-up |

## Invariants

- vault + outstanding principal ≥ senior assets + junior assets − recognised losses
- one open advance per validator; no release while open
- sweeps never go below rent + admission-fee reserve
- senior share price never falls while junior assets > 0
