import { z } from '@epoch/common/pkg/zod';

import { computeUnitPrice } from './Cranks.config';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const CLAIM_KINDS = [
  'partnerTradingFee',
  'partnerSurplus',
  'partnerMigrationFee',
  'lpFee',
  'creatorMigrationFee',
  'creatorSurplus',
  'creatorTradingFee',
  'leftover',
] as const;

/**
 * Every claim kind. The leftover (supply the curve did not sell) is burned when Epoch's treasury PDA receives it (ADR
 * 0006, amendment of 4 Oct 2026); for any other receiver it is withdrawn to that receiver.
 */
export const DEFAULT_LAUNCH_CLAIM_KINDS = [...CLAIM_KINDS];

const commaList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

/**
 * cranks_app's launch fee claims (plan F13, ADR 0006): for every launch in the registry, claim the DBC partner trading
 * fees, the partner's surplus and migration fee, the leftover and the locked DAMM v2 LP position's fees owed to Epoch's
 * treasury, and the creator's migration fee and surplus for creators whose keys are configured. Epoch's launches name
 * the treasury PDA as fee claimer, so the crank sends those claims through the Epoch program (CRANK_KEYPAIR_PATH pays
 * the fees) when LAUNCH_CLUSTER is the program's EPOCH_CLUSTER. A signer whose key is not configured is simulated and
 * logged (dry run). Off unless LAUNCH_CLAIMS_ENABLED=true.
 */
export const LaunchClaimsConfigSchema = z
  .object({
    LAUNCH_CLAIMS_ENABLED: flag('false'),
    /** The launch registry (the launch script writes it). Required when claims are enabled. */
    LAUNCHES_PATH: z.string().min(1).optional(),
    /** Only registry entries on this cluster are claimed. */
    LAUNCH_CLUSTER: z.enum(['devnet', 'mainnet']).default('devnet'),
    /** RPC for the pools. Defaults to EPOCH_RPC_URL. */
    LAUNCH_RPC_URL: z.string().url().optional(),
    LAUNCH_RPC_FALLBACK_URL: z.string().url().optional(),
    EPOCH_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
    /**
     * A fee claimer that is a plain wallet (a devnet rehearsal): signs its partner claims and LP fee claim. Not needed for
     * Epoch's treasury PDA, whose claims go through the program. Unset: such claims are simulated (dry run).
     */
    TREASURY_KEYPAIR_PATH: z.string().min(1).optional(),
    /** Pool creators' keypairs, comma-separated (a validator that lets Epoch claim its 70%, or a devnet rehearsal). */
    LAUNCH_CREATOR_KEYPAIR_PATHS: commaList,
    /** Which claims to make (comma list of kinds). Default: all of them. */
    LAUNCH_CLAIM_KINDS: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (!value) return [...DEFAULT_LAUNCH_CLAIM_KINDS];
        const kinds = value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        const unknown = kinds.filter((kind) => !(CLAIM_KINDS as readonly string[]).includes(kind));
        if (unknown.length > 0) {
          ctx.addIssue({ code: 'custom', message: `unknown claim kinds: ${unknown.join(', ')}` });
        }
        return kinds as (typeof CLAIM_KINDS)[number][];
      }),
    /** Trading and LP fees below this are left to accumulate (a claim costs a fee and, the first time, an account). */
    LAUNCH_CLAIM_MIN_SOL: z.coerce.number().min(0).max(100).default(0.001),
    LAUNCH_CLAIM_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
    /** Simulate every claim and log the result; send nothing, even with keys. */
    LAUNCH_CLAIMS_DRY_RUN: flag('false'),
    LAUNCH_CLAIM_CU_PRICE_MICROLAMPORTS: computeUnitPrice,
  })
  .superRefine((value, ctx) => {
    if (value.LAUNCH_CLAIMS_ENABLED && !value.LAUNCHES_PATH) {
      ctx.addIssue({ code: 'custom', path: ['LAUNCHES_PATH'], message: 'required when LAUNCH_CLAIMS_ENABLED=true' });
    }
  })
  .transform(({ EPOCH_RPC_URL, LAUNCH_RPC_URL, ...rest }) => ({
    ...rest,
    LAUNCH_RPC_URL: LAUNCH_RPC_URL ?? EPOCH_RPC_URL,
  }));

export type LaunchClaimsConfig = z.infer<typeof LaunchClaimsConfigSchema>;
export type LaunchClaimKind = (typeof CLAIM_KINDS)[number];
