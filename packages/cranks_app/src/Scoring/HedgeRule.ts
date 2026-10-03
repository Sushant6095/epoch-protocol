import {
  bpsOfCeil,
  findQuotePda,
  type SwapPositionAccount,
  trailingRevenue,
  type ValidatorPositionAccount,
} from '@epoch/epoch-sdk';
import { type PublicKey } from '@solana/web3.js';

/**
 * The hedged rule (plan F7, decision 21, request #21): a validator is hedged while its operator holds Receive-fixed
 * swaps on EACH of the next `epochsAhead` program epochs, each epoch's notional at least `minNotionalShareBps` of the
 * position's average revenue per epoch. Only swaps against Epoch's own market maker count (decision 21: takers trade
 * only against the seeded maker; `post_quote` is open to any key, so a validator could otherwise hedge against its
 * own 1-bps quote for almost nothing).
 */
export const HEDGE_RULE = { epochsAhead: 5, minNotionalShareBps: 5_000 } as const;

export interface HedgeStatus {
  hedged: boolean;
  /** Lamports of Receive-fixed notional needed on each epoch. */
  requiredNotional: bigint;
  /** Receive-fixed notional held against the maker's quote, per epoch. */
  coverage: { epoch: bigint; notional: bigint }[];
  /** Why the validator is not hedged, for logs. */
  reason?: string;
}

/** Trailing revenue ÷ epochs of history (`revenue_count`); 0 with no history. */
export function averageRevenuePerEpoch(position: ValidatorPositionAccount): bigint {
  if (position.revenueCount === 0) return 0n;
  return trailingRevenue(position) / BigInt(Math.min(position.revenueCount, position.revenue.length));
}

export function hedgeStatus(input: {
  programId: PublicKey;
  position: ValidatorPositionAccount;
  /** The program cluster's current epoch: the hedge must cover current+1 … current+epochsAhead. */
  currentEpoch: bigint;
  /** Open swaps whose taker is the position's operator. */
  swaps: readonly SwapPositionAccount[];
  /** Epoch's market maker(s) (EPOCH_MARKET_MAKER). Empty: nobody counts as hedged. */
  makers: readonly PublicKey[];
}): HedgeStatus {
  const { programId, position, currentEpoch, swaps, makers } = input;
  const average = averageRevenuePerEpoch(position);
  // "At least half": rounded up, and never zero, so an empty history cannot be hedged with dust.
  const required = bpsOfCeil(average, HEDGE_RULE.minNotionalShareBps);
  const requiredNotional = required > 0n ? required : 1n;

  const coverage: HedgeStatus['coverage'] = [];
  for (let i = 1; i <= HEDGE_RULE.epochsAhead; i++) {
    const epoch = currentEpoch + BigInt(i);
    const makerQuotes = new Set(makers.map((maker) => findQuotePda(programId, maker, epoch)[0].toBase58()));
    const notional = swaps
      .filter(
        (s) =>
          !s.settled &&
          s.side === 'receiveFixed' &&
          s.epoch === epoch &&
          s.taker.equals(position.operator) &&
          makerQuotes.has(s.quote.toBase58()),
      )
      .reduce((sum, s) => sum + s.notional, 0n);
    coverage.push({ epoch, notional });
  }

  let reason: string | undefined;
  if (makers.length === 0) reason = 'EPOCH_MARKET_MAKER is not set, so no swap counts as a hedge';
  else {
    const short = coverage.find((c) => c.notional < requiredNotional);
    if (short) reason = `epoch ${short.epoch} holds ${short.notional} of ${requiredNotional} lamports Receive-fixed`;
  }
  return { hedged: reason === undefined, requiredNotional, coverage, reason };
}
