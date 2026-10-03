import { z } from '@epoch/common/pkg/zod';

import { isPublicKey } from '../Lib/Keys';
import { SIWS_MAX_MESSAGE_LENGTH } from '../Lib/Siws';

const publicKey = (what: string) =>
  z.string().refine(isPublicKey, { message: `${what} must be a 32-byte base58 public key` });

/** Trims; an empty string means "no value" (null). */
const blankAsNull = (value: unknown): unknown =>
  typeof value === 'string' ? (value.trim() === '' ? null : value.trim()) : value;

// ── /v1/auth ────────────────────────────────────────────────────────────────────────────────────────
export const SiwsVerifyDto = z.object({
  /** The exact text the wallet signed (Wallet Standard `signedMessage` as UTF-8). */
  message: z.string().min(1).max(SIWS_MAX_MESSAGE_LENGTH),
  /** 64-byte ed25519 signature, base58 or base64. */
  signature: z.string().min(1).max(200),
  address: z.string().min(1).max(64).optional(),
});
export type SiwsVerifyBody = z.infer<typeof SiwsVerifyDto>;

// ── /v1/me ──────────────────────────────────────────────────────────────────────────────────────────
export const WatchlistPutDto = z.object({
  /** Vote accounts; duplicates are dropped, more than 200 distinct → 400 WATCHLIST_TOO_LONG. */
  votes: z.array(publicKey('each vote')).max(5_000),
});
export type WatchlistPutBody = z.infer<typeof WatchlistPutDto>;

export const AlertPrefsPutDto = z.object({
  rules: z.object({
    offline: z.boolean(),
    feeUp: z.boolean(),
    losingMoney: z.boolean(),
    rewardsLanded: z.boolean(),
  }),
  /** A channel left out keeps its value; null (or "") turns it off. */
  channels: z
    .object({
      email: z.preprocess(blankAsNull, z.email().max(254).nullable()).optional(),
      /** A Telegram chat id (the link flow sets it): digits, negative for groups. */
      telegram: z
        .preprocess(
          (value) => (typeof value === 'number' ? String(value) : blankAsNull(value)),
          z
            .string()
            .regex(/^-?\d{1,20}$/, 'telegram must be a chat id (digits)')
            .nullable(),
        )
        .optional(),
    })
    .optional(),
  /** Left out: kept as they are. At most 20; duplicates (same stake account and epoch) dropped. */
  reminders: z
    .array(
      z.object({
        kind: z.literal('move-step-2'),
        epoch: z.number().int().min(0).max(10_000_000),
        stakeAccount: publicKey('stakeAccount'),
      }),
    )
    .max(20)
    .transform((reminders) => {
      const seen = new Set<string>();
      return reminders.filter((reminder) => {
        const key = `${reminder.stakeAccount}:${reminder.epoch}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })
    .optional(),
});
export type AlertPrefsPutBody = z.infer<typeof AlertPrefsPutDto>;

// ── /v1/predict ─────────────────────────────────────────────────────────────────────────────────────
export const PredictCallDto = z.object({
  marketId: z.string().min(1).max(100),
  side: z.enum(['yes', 'no']),
  points: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]),
});
export type PredictCallBody = z.infer<typeof PredictCallDto>;

export const LeaderboardQueryDto = z.object({
  /** Default PREDICT_LEADERBOARD_EPOCHS (30). */
  epochs: z.coerce.number().int().min(1).max(365).optional(),
});
export type LeaderboardQuery = z.infer<typeof LeaderboardQueryDto>;
