# ADR 0002: Per-validator withdraw-authority PDA

**Status:** accepted · 27 Sep 2026

**Context.** Repayment at source requires the program to control each borrower's vote-account withdrawals. `solana-vote-interface` 7.1 confirms the withdraw authority must sign `Withdraw`, `UpdateCommissionCollector` and commission updates.

**Decision.** Each validator hands its withdraw authority to a PDA derived from `["vote_auth", vote]`. The program records the original withdrawer and returns authority only through `release` when no advance is open. Both commission collectors are set to the vote account at onboarding.

**Consequences.** One compromised position cannot affect another. Sweeps must respect rent, `pending_delegator_rewards` and the admission-fee reserve. Validators must trust the program: mitigated by caps, open source, a visible release path and a multisig upgrade authority.
