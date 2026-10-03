import {
  bigint,
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const lamports = (name: string) => bigint(name, { mode: 'bigint' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

/** Median priority fee per compute unit for each slot (leader-paid transactions excluded). */
export const slotFees = pgTable(
  'slot_fees',
  {
    slot: bigint('slot', { mode: 'number' }).primaryKey(),
    epoch: integer('epoch').notNull(),
    leader: text('leader').notNull(),
    medianCuPrice: bigint('median_cu_price', { mode: 'number' }).notNull(),
    txCount: integer('tx_count').notNull(),
  },
  (t) => [index('slot_fees_epoch_idx').on(t.epoch)],
);

/** Settled Solana Fee Index per epoch. */
export const epochIndex = pgTable('epoch_index', {
  epoch: integer('epoch').primaryKey(),
  value: bigint('value', { mode: 'number' }).notNull(),
  postedSignature: text('posted_signature'),
  computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
});

export const validators = pgTable('validators', {
  vote: text('vote').primaryKey(),
  identity: text('identity').notNull(),
  name: text('name'),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
});

/** Revenue, credits and commission per validator per epoch. */
export const validatorEpochs = pgTable(
  'validator_epochs',
  {
    vote: text('vote').notNull(),
    epoch: integer('epoch').notNull(),
    revenueLamports: lamports('revenue_lamports').notNull(),
    credits: bigint('credits', { mode: 'number' }).notNull(),
    commissionBps: integer('commission_bps').notNull(),
  },
  (t) => [primaryKey({ columns: [t.vote, t.epoch] })],
);

/**
 * Decoded Epoch program events (onboarded, advance opened, swept, settled...). `ix` is the event's position in its
 * transaction's logs; `payload` is epoch-sdk `eventToJson(event).data` (pubkeys base58, u64 as decimal strings).
 */
export const programEvents = pgTable(
  'program_events',
  {
    signature: text('signature').notNull(),
    ix: integer('ix').notNull(),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    /** Block time when known (backfill), else the time the live log arrived. */
    blockTime: timestamp('block_time', { withTimezone: true }),
    /** The program cluster's epoch of `slot`. */
    epoch: integer('epoch'),
  },
  (t) => [
    primaryKey({ columns: [t.signature, t.ix] }),
    index('program_events_slot_idx').on(t.slot),
    index('program_events_kind_slot_idx').on(t.kind, t.slot),
  ],
);

/** Resume points for long-running streams. `signature`: the newest transaction read (signature backfill). */
export const indexerCursors = pgTable('indexer_cursors', {
  name: text('name').primaryKey(),
  slot: bigint('slot', { mode: 'number' }).notNull(),
  signature: text('signature'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Sign-in (request #7) ────────────────────────────────────────────────────

/** One-time Sign-In With Solana nonces. */
export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ip: text('ip'),
  },
  (t) => [index('auth_nonces_expires_idx').on(t.expiresAt)],
);

/** Signed-in sessions. The cookie carries a random token; only its sha256 (hex) is stored, as `id`. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    address: text('address').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_address_idx').on(t.address)],
);

// ── Watchlist and alerts (requests #14, #15) ────────────────────────────────

/** Vote accounts a wallet watches (at most 200). */
export const watchlists = pgTable('watchlists', {
  address: text('address').primaryKey(),
  votes: jsonb('votes').$type<string[]>().notNull(),
  updatedAt: updatedAt(),
});

export interface AlertRules {
  offline: boolean;
  feeUp: boolean;
  losingMoney: boolean;
  rewardsLanded: boolean;
}

export interface AlertReminder {
  kind: 'move-step-2';
  epoch: number;
  stakeAccount: string;
}

/** A wallet's alert rules, channels and reminders; `state` is the sender job's memory (last commissions seen…). */
export const alertPrefs = pgTable('alert_prefs', {
  address: text('address').primaryKey(),
  rules: jsonb('rules').$type<AlertRules>().notNull(),
  email: text('email'),
  /** Telegram chat id, set by the bot link flow (or typed in). */
  telegram: text('telegram'),
  reminders: jsonb('reminders').$type<AlertReminder[]>().notNull(),
  state: jsonb('state').$type<Record<string, unknown>>().notNull(),
  updatedAt: updatedAt(),
});

/** Every alert sent (or failed), unique per wallet, dedupe key and channel so a rerun never sends twice. */
export const alertDeliveries = pgTable(
  'alert_deliveries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    address: text('address').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    kind: text('kind').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('alert_deliveries_dedupe_idx').on(t.address, t.dedupeKey, t.channel)],
);

/** One-time codes that connect a Telegram chat to a wallet (t.me/<bot>?start=<code>). */
export const telegramLinks = pgTable('telegram_links', {
  code: text('code').primaryKey(),
  address: text('address').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

// ── Predict, points mode (request #11) ──────────────────────────────────────

/** A Fee Index market: "Will epoch N's Fee Index close above X µL/CU?". Answered by the FINAL value of epoch N. */
export const predictMarkets = pgTable(
  'predict_markets',
  {
    id: text('id').primaryKey(),
    /** The epoch whose final Fee Index answers the market; calls close when this epoch starts. */
    epoch: integer('epoch').notNull(),
    kind: text('kind').notNull(),
    /** µL/CU */
    threshold: bigint('threshold', { mode: 'number' }).notNull(),
    question: text('question').notNull(),
    label: text('label').notNull(),
    /** open | settled (closed is derived from the current epoch). */
    status: text('status').notNull(),
    /** yes | no | refunded, once settled. */
    outcome: text('outcome'),
    resolvedValue: bigint('resolved_value', { mode: 'number' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('predict_markets_epoch_idx').on(t.epoch)],
);

/** One call: points on YES or NO. `epoch` is the epoch whose 100-point budget paid for it. */
export const predictCalls = pgTable(
  'predict_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    marketId: text('market_id').notNull(),
    address: text('address').notNull(),
    side: text('side').notNull(),
    points: integer('points').notNull(),
    epoch: integer('epoch').notNull(),
    /** Points returned at settlement (0 for a losing call); null until settled. */
    payoutPoints: integer('payout_points'),
    createdAt: createdAt(),
  },
  (t) => [
    index('predict_calls_market_idx').on(t.marketId),
    index('predict_calls_address_epoch_idx').on(t.address, t.epoch),
  ],
);

// ── Program history the chain doesn't keep ──────────────────────────────────

/** The Pool at each accrual (the Vault's share-price and lent-out series). */
export const poolSnapshots = pgTable('pool_snapshots', {
  epoch: integer('epoch').primaryKey(),
  seniorAssets: lamports('senior_assets').notNull(),
  seniorShares: lamports('senior_shares').notNull(),
  juniorAssets: lamports('junior_assets').notNull(),
  juniorShares: lamports('junior_shares').notNull(),
  outstandingPrincipal: lamports('outstanding_principal').notNull(),
  cash: lamports('cash').notNull(),
  seniorPriceE9: bigint('senior_price_e9', { mode: 'number' }).notNull(),
  juniorPriceE9: bigint('junior_price_e9', { mode: 'number' }).notNull(),
  utilizationBps: integer('utilization_bps').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Per-validator mainnet figures per epoch (commission history, stake history) recorded by api_app. */
export const validatorEpochStats = pgTable(
  'validator_epoch_stats',
  {
    vote: text('vote').notNull(),
    epoch: integer('epoch').notNull(),
    commissionBps: integer('commission_bps'),
    mevCommissionBps: integer('mev_commission_bps'),
    activeStakeLamports: lamports('active_stake_lamports'),
    credits: bigint('credits', { mode: 'number' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.vote, t.epoch] }), index('validator_epoch_stats_epoch_idx').on(t.epoch)],
);

/** Revenue-token prices sampled by api_app (the Launch page's price series, request #22). */
export const launchPriceSamples = pgTable(
  'launch_price_samples',
  {
    mint: text('mint').notNull(),
    t: timestamp('t', { withTimezone: true }).notNull(),
    epoch: integer('epoch').notNull(),
    priceSol: doublePrecision('price_sol').notNull(),
  },
  (t) => [primaryKey({ columns: [t.mint, t.t] })],
);
