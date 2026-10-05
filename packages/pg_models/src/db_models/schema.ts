import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
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

// ── Solami Live: the Fee Index computed live from mainnet (indexer_app → api_app /v1/live) ──────────

/**
 * Stake per leader identity for one mainnet epoch, read from getVoteAccounts while that epoch runs: the weights of the
 * epoch's stake-weighted median. Lamports, summed over the identity's vote accounts.
 */
export const epochStakes = pgTable(
  'epoch_stakes',
  {
    epoch: integer('epoch').notNull(),
    identity: text('identity').notNull(),
    stakeLamports: lamports('stake_lamports').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.epoch, t.identity] })],
);

/**
 * Recent blocks with per-slot detail for the Live page (block time, quartiles, what was left out). `slot_fees` stays the
 * index input that the publisher hashes; this table is display data, pruned to the newest LIVE_SLOTS_KEEP rows.
 * Prices are µL/CU over priced, non-leader-paid transactions; null when the block had none.
 */
export const liveSlots = pgTable(
  'live_slots',
  {
    slot: bigint('slot', { mode: 'number' }).primaryKey(),
    epoch: integer('epoch').notNull(),
    leader: text('leader').notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }),
    medianCuPrice: bigint('median_cu_price', { mode: 'number' }),
    p25CuPrice: bigint('p25_cu_price', { mode: 'number' }),
    p75CuPrice: bigint('p75_cu_price', { mode: 'number' }),
    p90CuPrice: bigint('p90_cu_price', { mode: 'number' }),
    pricedTxs: integer('priced_txs').notNull(),
    unpricedTxs: integer('unpriced_txs').notNull(),
    leaderPaidTxs: integer('leader_paid_txs').notNull(),
    failedTxs: integer('failed_txs').notNull(),
    /** grpc | hybrid | rpc | gap-fill */
    source: text('source').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('live_slots_epoch_idx').on(t.epoch)],
);

/**
 * The running Fee Index estimate of a mainnet epoch in progress and the indexer's stream health, refreshed every few
 * seconds by indexer_app. Never posted on-chain: only finished, complete epochs go to `epoch_index`.
 */
export const feeIndexLive = pgTable('fee_index_live', {
  epoch: integer('epoch').primaryKey(),
  /** µL/CU; null before the first priced slot with a staked leader. */
  estimate: bigint('estimate', { mode: 'number' }),
  leaders: integer('leaders').notNull(),
  slotsWithFees: integer('slots_with_fees').notNull(),
  pricedTxs: bigint('priced_txs', { mode: 'number' }).notNull(),
  /** First slot of this epoch the estimate covers without gaps (later than the epoch start when the run began later). */
  firstSlot: bigint('first_slot', { mode: 'number' }),
  /** Newest slot processed from the live source. */
  processedSlot: bigint('processed_slot', { mode: 'number' }),
  /** Every slot up to here is processed (gap fill catches up to it). */
  watermarkSlot: bigint('watermark_slot', { mode: 'number' }),
  tipSlot: bigint('tip_slot', { mode: 'number' }),
  /** Which epoch's stake snapshot weights the estimate. */
  stakeEpoch: integer('stake_epoch'),
  /** grpc | hybrid | rpc */
  source: text('source').notNull(),
  /** solami | rpc-fast | the RPC host */
  endpoint: text('endpoint'),
  /** streaming | connecting | reconnecting | catching-up | polling | stopped */
  status: text('status').notNull(),
  /** 1 = every slot; N = rpc mode sampling one slot in N (never a final value). */
  stride: integer('stride').notNull().default(1),
  lastSlotAt: timestamp('last_slot_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Panta: real-money Fee Index markets (side track; decision of 3 Oct 2026) ─

/** USDC in base units (6 decimals); exact as a JS number up to 9 billion USDC. */
const usdcBase = (name: string) => bigint(name, { mode: 'number' });

/**
 * A Fee Index market panta_bot_app creates on Panta (USDC, Solana mainnet): "Will the Solana Fee Index for epoch N close
 * above X?". One row per (epoch, threshold), written before anything is sent, so a restart never creates twice.
 * status: planned → quoted → signed (signature and signed transaction stored BEFORE broadcast) → confirmed (fee paid)
 * → registered (listed on Panta); `unregistered` = paid but Panta's registration window passed (needs a person),
 * `failed` = gave up after repeated failures. `epoch` is a MAINNET epoch.
 */
export const pantaMarkets = pgTable(
  'panta_markets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    epoch: integer('epoch').notNull(),
    /** µL/CU: YES when the final value is strictly greater. */
    threshold: bigint('threshold', { mode: 'number' }).notNull(),
    /** Panta derives the market's address from the creator wallet and this exact text. */
    question: text('question').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    resolutionRule: text('resolution_rule').notNull(),
    sourcesOfTruth: jsonb('sources_of_truth').$type<string[]>().notNull(),
    imageUrl: text('image_url'),
    status: text('status').notNull(),
    startTime: timestamp('start_time', { withTimezone: true }),
    endTime: timestamp('end_time', { withTimezone: true }),
    resolutionTime: timestamp('resolution_time', { withTimezone: true }),
    createId: text('create_id'),
    createExpiresAt: timestamp('create_expires_at', { withTimezone: true }),
    expectedEventPda: text('expected_event_pda'),
    /** Panta's market id (the event address) once registered. */
    marketId: text('market_id'),
    createSignature: text('create_signature'),
    /** The signed create transaction (base64): public once sent; kept to re-broadcast after a crash. */
    signedTx: text('signed_tx'),
    lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'number' }),
    /** The quote: total fee, the part that seeds liquidity, Panta's part. */
    quotedUsdcBase: usdcBase('quoted_usdc_base'),
    liquidityUsdcBase: usdcBase('liquidity_usdc_base'),
    platformUsdcBase: usdcBase('platform_usdc_base'),
    /** Set once the create transaction confirmed. */
    paidUsdcBase: usdcBase('paid_usdc_base'),
    creatorFeesClaimedUsdcBase: usdcBase('creator_fees_claimed_usdc_base').default(0).notNull(),
    lastCreatorFeeSignature: text('last_creator_fee_signature'),
    creatorFeesCheckedAt: timestamp('creator_fees_checked_at', { withTimezone: true }),
    attempts: integer('attempts').default(0).notNull(),
    error: text('error'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    registeredAt: timestamp('registered_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('panta_markets_epoch_threshold_idx').on(t.epoch, t.threshold),
    uniqueIndex('panta_markets_market_id_idx').on(t.marketId),
    index('panta_markets_status_idx').on(t.status),
  ],
);

/**
 * A trade made through Epoch on Panta: a primary buy or a win claim. The consent record (what the wallet agreed to and
 * when), the transaction we built (message hash), its signature and Panta's attribution (POST /trades/). Traction
 * evidence: every row with report_status `processed` is volume Panta credits to Epoch.
 * status: built → submitted → confirmed | failed | expired. report_status: pending → processed | failed.
 */
export const pantaTrades = pgTable(
  'panta_trades',
  {
    /** `ptr_…`: the handle the app polls. */
    id: text('id').primaryKey(),
    /** buy | claim */
    kind: text('kind').notNull(),
    wallet: text('wallet').notNull(),
    marketId: text('market_id').notNull(),
    /** yes | no (a claim: the winning side). */
    side: text('side'),
    /** As Panta quoted it: decimal USDC for a buy ("20.00"), winning shares for a claim. */
    amountUsdc: text('amount_usdc'),
    amountUsdcBase: usdcBase('amount_usdc_base'),
    feeUsdc: text('fee_usdc'),
    expectedShares: text('expected_shares'),
    quoteId: text('quote_id'),
    orderId: text('order_id'),
    /** sha256 of the message we built: a signed transaction must carry exactly this message. */
    messageHash: text('message_hash').notNull(),
    lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'number' }),
    signature: text('signature'),
    status: text('status').notNull(),
    reportStatus: text('report_status').default('pending').notNull(),
    reportError: text('report_error'),
    reportAttempts: integer('report_attempts').default(0).notNull(),
    /** The human-readable summary shown before signing: the consent record. */
    summary: text('summary').notNull(),
    consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
    /** The signed-in (SIWS) wallet that asked. */
    sessionAddress: text('session_address'),
    /** From the trusted proxy's geo header, when there is one. */
    country: text('country'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('panta_trades_signature_idx').on(t.signature),
    index('panta_trades_wallet_idx').on(t.wallet),
    index('panta_trades_status_idx').on(t.status, t.reportStatus),
    index('panta_trades_market_idx').on(t.marketId),
  ],
);

/**
 * Revenue-token trades decoded from the launch pools' swap events (DBC `EvtSwap2`, DAMM v2 `EvtSwap2`): the Launch
 * page's trade feed and candles (plan F13). One row per swap event; amounts in base units (token amounts as numeric:
 * u64 does not fit a signed bigint).
 */
export const launchTrades = pgTable(
  'launch_trades',
  {
    signature: text('signature').notNull(),
    /** The event's position among the transaction's Meteora events. */
    ix: integer('ix').notNull(),
    mint: text('mint').notNull(),
    pool: text('pool').notNull(),
    /** dbc | damm-v2 */
    venue: text('venue').notNull(),
    /** buy | sell */
    side: text('side').notNull(),
    trader: text('trader'),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    /** SOL paid (buy, fees included) or received (sell, after fees). */
    solLamports: lamports('sol_lamports').notNull(),
    tokenAmount: numeric('token_amount', { precision: 20, scale: 0 }).notNull(),
    feeAmount: numeric('fee_amount', { precision: 20, scale: 0 }).notNull(),
    feeInToken: boolean('fee_in_token').notNull(),
    /** Execution price before fees, SOL per token. */
    priceSol: doublePrecision('price_sol').notNull(),
    /** The pool's price after the trade. */
    postPriceSol: doublePrecision('post_price_sol').notNull(),
    quoteReserveLamports: lamports('quote_reserve_lamports'),
  },
  (t) => [
    primaryKey({ columns: [t.signature, t.ix] }),
    index('launch_trades_mint_time_idx').on(t.mint, t.blockTime),
    index('launch_trades_mint_slot_idx').on(t.mint, t.slot),
  ],
);

/** Fee claims, withdrawals and graduation events of the launch pools (partner, creator, LP, leftover). */
export const launchFeeEvents = pgTable(
  'launch_fee_events',
  {
    signature: text('signature').notNull(),
    ix: integer('ix').notNull(),
    mint: text('mint').notNull(),
    pool: text('pool').notNull(),
    /** partnerTradingFee | creatorMigrationFee | lpFee | leftover | curveComplete | dammPoolCreated … */
    kind: text('kind').notNull(),
    owner: text('owner'),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    solLamports: lamports('sol_lamports').notNull(),
    tokenAmount: numeric('token_amount', { precision: 20, scale: 0 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.signature, t.ix] }),
    index('launch_fee_events_mint_time_idx').on(t.mint, t.blockTime),
  ],
);

// ── Solami usage: what each component uses of Solami (GET /v1/live/solami) ─────────────────────────────────────

/**
 * One row per component (indexer, publisher, cranks): its Solami counters as `@epoch/solana` SolamiUsage reports them
 * (gRPC stream status and bytes, RPC calls by method with p50/p95 latency and errors, Beam sends, landings and tips,
 * the last error), rewritten every few seconds. Keys never appear: endpoints are kept by host.
 */
export const solamiUsageReports = pgTable('solami_usage', {
  component: text('component').primaryKey(),
  report: jsonb('report').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
