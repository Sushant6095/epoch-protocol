# Architecture

**Core insight:** since 8 Sep 2026 (SIMD-0232), inflation commission, block fees and Jito MEV
commission can all land in a validator's vote account. A program holding that account's
withdraw authority controls 100% of the validator's revenue.

## Components

| Component | Trust | Notes |
| --- | --- | --- |
| Epoch program (Anchor) | Trusted code; upgrade key in Squads multisig | Holds all funds in PDAs; capped and pausable |
| Vote accounts | Native; our PDA is withdrawer | Collector set to the vote account |
| Cranks | Permissionless | Anyone can run; idempotent per epoch |
| Index publisher | Trusted in v1 | Bounded move per epoch, dispute window, Switchboard mirror |
| Indexer + API | Read-only | Solami gRPC primary, RPC Fast failover |
| App | Untrusted UI | Wallet signs every transaction |

## Epoch boundary (every ~432,000 slots)

1. Revenue lands in vote accounts (wait for reward distribution to finish)
2. `claim_mev` claims Jito commission to the vote account
3. `post_index` posts the finalized fee index; mirrored to Switchboard
4. `update_score` records revenue = balance now − balance after last sweep
5. `sweep` keeps rent + 1.6 SOL admission reserve; waterfall senior → junior → fee; rest to identity
6. `settle_epoch` pays swaps: pay-fixed gets notional × (index − fixed) ÷ fixed
7. Pool accrues: senior share price rises by target; junior takes the residual
8. Panta market N resolves; N+1 opens

## Credit limit (v1)

limit = min(a × revenue over last 10 epochs, 2 × bond, per-validator cap);
a = 25% unhedged, 40% hedged; fee 2% flat; 50% of revenue swept per epoch.

## Advance states

Onboarded → Active → Closed → Released; Active → Late → Defaulted (after 3 epochs) → Closed.
Withdraw authority can only be released from Onboarded or Closed.
