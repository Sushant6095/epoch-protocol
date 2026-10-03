import { z } from '@epoch/common/pkg/zod';

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    );

/** Sign-In With Solana (request #7) and the session cookie. */
export const AuthConfigSchema = z.object({
  /** Hosts the SIWS message may name (`window.location.host`, decision 7): localhost:3000 and the Vercel host. */
  SIWS_ALLOWED_DOMAINS: csv('localhost:3000'),
  SIWS_STATEMENT: z.string().default('Sign in to Epoch. This request will not send a transaction or cost any SOL.'),
  SIWS_NONCE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24 * 7),
  SESSION_COOKIE_NAME: z.string().min(1).default('epoch_session'),
  /** Required (true) when the app and API are on different sites, with SameSite=None. */
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false', 'auto'])
    .default('auto')
    .transform((value) => (value === 'auto' ? process.env.NODE_ENV === 'production' : value === 'true')),
  /** `none` when the app (e.g. a Vercel URL) and the API are on different sites; needs SESSION_COOKIE_SECURE. */
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  /** Behind a proxy (Fly, nginx): trust X-Forwarded-* for req.ip and req.secure. */
  API_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
