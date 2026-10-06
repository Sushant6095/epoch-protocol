# Source

Vendored, unmodified, from Meteora's agent skill:

- Repository: https://github.com/MeteoraAg/meteora-invent (`skills/meteora/`)
- Commit: `dd77ef3d5aede3f0ff21d566d052097200417f5e` (2026-09-21)
- License: MIT, Copyright (c) 2025 Meteora (`LICENSE.md`, copied from the repository root)

Epoch's notes on how we follow (or deliberately depart from) each rule live in
[`docs/meteora/SKILL-AUDIT.md`](../../../docs/meteora/SKILL-AUDIT.md); the skill pins DBC SDK 1.5.11 and cp-amm SDK 1.4.5,
Epoch runs 1.5.13 and 1.5.1 (the differences are listed there). To update: copy `skills/meteora/` from a newer commit
over this folder, keep `LICENSE.md` and this file, change the commit above and re-check the audit.
