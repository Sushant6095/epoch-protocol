import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

const lamports = (name: string) => bigint(name, { mode: 'bigint' });

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

/** Decoded Epoch program events (onboarded, advance opened, swept, settled...). */
export const programEvents = pgTable(
  'program_events',
  {
    signature: text('signature').notNull(),
    ix: integer('ix').notNull(),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
  },
  (t) => [primaryKey({ columns: [t.signature, t.ix] }), index('program_events_slot_idx').on(t.slot)],
);

/** Resume points for long-running streams. */
export const indexerCursors = pgTable('indexer_cursors', {
  name: text('name').primaryKey(),
  slot: bigint('slot', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
