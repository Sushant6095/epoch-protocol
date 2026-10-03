import { z } from '@epoch/common/pkg/zod';

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

/**
 * Public mainnet data behind /v1/network, /v1/validators and /v1/delegators. The Epoch program can run
 * on devnet while these always read mainnet, so the RPC here is separate from `RPC_URL`.
 */
export const MarketDataConfigSchema = z.object({
  /** Mainnet RPC for reads. The public endpoint works but is rate-limited; use a paid one in production. */
  DATA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  DATA_RPC_FALLBACK_URL: z.string().url().optional(),
  STAKEWIZ_API_URL: z.string().url().default('https://api.stakewiz.com'),
  JITO_KOBE_API_URL: z.string().url().default('https://kobe.mainnet.jito.network'),
  /** Jupiter Price API v3. */
  PRICE_API_URL: z.string().url().default('https://lite-api.jup.ag/price/v3'),
  /** Jupiter token search, used to name liquid-staking pools by their token symbol. */
  TOKEN_API_URL: z.string().url().default('https://lite-api.jup.ag/tokens/v2/search'),
  /** USD → INR for the INR toggle. Any endpoint that returns `{ rates: { INR } }` works. */
  FX_API_URL: z.string().url().default('https://open.er-api.com/v6/latest/USD'),

  /** The delegator scan reads every delegated stake account, one validator at a time. */
  DELEGATOR_SCAN_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  DELEGATOR_SCAN_INTERVAL_HOURS: z.coerce.number().positive().default(12),
  DELEGATOR_SCAN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** Development only: scan just the N largest validators. 0 = all. */
  DELEGATOR_SCAN_VOTE_LIMIT: z.coerce.number().int().min(0).default(0),
  /** Optional JSON file: `[{ "address", "name", "kind", "entity"? }]` naming known delegator wallets. */
  DELEGATOR_LABELS_PATH: z.string().optional(),
  /** Stake and withdraw authorities used by the Solana Foundation; drives the Foundation share per validator. */
  FOUNDATION_AUTHORITIES: csv,
  /** SPL stake-pool programs whose pools are named as liquid staking. */
  STAKE_POOL_PROGRAM_IDS: z
    .string()
    .default(
      'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy,SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY,SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn',
    )
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
});

export type MarketDataConfig = z.infer<typeof MarketDataConfigSchema>;
