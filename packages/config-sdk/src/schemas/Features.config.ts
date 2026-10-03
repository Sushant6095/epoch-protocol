import { z } from '@epoch/common/pkg/zod';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

/** Alert preferences and the sender job (request #15). Channels without credentials are skipped. */
export const AlertsConfigSchema = z.object({
  ALERTS_ENABLED: flag('true'),
  /** How often the job checks (offline is "delinquent for more than 10 minutes"). */
  ALERTS_CHECK_MINUTES: z.coerce.number().int().min(1).max(1_440).default(5),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** The bot's @username, for the t.me link that connects a chat. */
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  /** smtp(s)://user:pass@host:port — email alerts are off when unset. */
  SMTP_URL: z.string().optional(),
  ALERTS_EMAIL_FROM: z.string().default('Epoch alerts <alerts@epoch.local>'),
  /** Links in alerts point here (the app's URL). */
  APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
});

/** Predict in points mode (request #11, decisions 2 and 3). */
export const PredictConfigSchema = z.object({
  /** Real-SOL Predict through Panta stays off until there is legal advice. Must be false. */
  PREDICT_REAL_SOL: flag('false'),
  PREDICT_POINTS_PER_EPOCH: z.coerce.number().int().min(10).max(10_000).default(100),
  PREDICT_LEADERBOARD_EPOCHS: z.coerce.number().int().min(1).max(365).default(30),
  /** Markets are opened for this many epochs ahead of the current one. */
  PREDICT_MARKETS_AHEAD: z.coerce.number().int().min(1).max(5).default(2),
  /** Resolve from the indexer's computed value (epoch_index) when the program has no final value. Demo only. */
  PREDICT_RESOLVE_FROM_DB: flag('false'),
  PREDICT_REGIONS: z.string().default('where allowed'),
});

/** WS /v1/stream (request #4). */
export const StreamConfigSchema = z.object({
  /** How often the `slot` channel polls getEpochInfo while someone is subscribed. */
  STREAM_SLOT_INTERVAL_MS: z.coerce.number().int().min(400).max(60_000).default(2_000),
});

export type AlertsConfig = z.infer<typeof AlertsConfigSchema>;
export type PredictConfig = z.infer<typeof PredictConfigSchema>;
export type StreamConfig = z.infer<typeof StreamConfigSchema>;
