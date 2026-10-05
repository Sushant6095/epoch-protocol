/**
 * What a launch costs the payer, item by item, before anything is sent. Account sizes are the DBC program's (measured
 * on its mainnet build: a config is 1,048 bytes, a pool 424), rent is `(bytes + 128) × 6,960` lamports (the rent-exempt
 * minimum at 3,480 lamports per byte-year), and Metaplex charges a 0.01 SOL creation fee that stays in the metadata
 * account. The launch script compares this estimate with a simulation of the real transactions when the payer is funded.
 */
import { LAMPORTS_PER_SOL } from './constants';

/** Account sizes, bytes. */
export const LAUNCH_ACCOUNT_BYTES = {
  dbcConfig: 1_048,
  dbcPool: 424,
  mint: 82,
  tokenAccount: 165,
  /** Upper bound (Metaplex `MAX_METADATA_LEN`); the account is sized to the name, symbol and URI (607 bytes for a short one). */
  metadata: 679,
} as const;

/** Metaplex token-metadata creation fee, lamports (measured: the metadata account holds rent + 0.01 SOL). */
export const METAPLEX_CREATE_FEE_LAMPORTS = 10_000_000;
export const SIGNATURE_FEE_LAMPORTS = 5_000;

/** The rent-exempt minimum for an account of `bytes` (the formula `getMinimumBalanceForRentExemption` uses). */
export const rentExemptLamports = (bytes: number): number => (bytes + 128) * 6_960;

export interface LaunchCostItem {
  label: string;
  lamports: number;
  /** Refunded later (a temporary account), or spent on chain. */
  refundable?: boolean;
}

export interface LaunchCost {
  items: LaunchCostItem[];
  /** Everything the payer spends, the initial buy included. */
  totalLamports: number;
  totalSol: number;
}

export interface LaunchCostInput {
  /** A new DBC config is created (false when an existing one is reused). */
  newConfig: boolean;
  /** Transactions and their signature counts (fee = 5,000 lamports per signature). */
  signatures: number;
  /** Priority fee per transaction, lamports (compute units × micro-lamports ÷ 1e6). */
  priorityFeeLamports?: number;
  transactions?: number;
  /** SOL spent on the creator's first buy, lamports. */
  initialBuyLamports?: number;
  /** Rent for an account size; default the formula. */
  rent?: (bytes: number) => number;
}

/** The itemized launch cost (pure). */
export function estimateLaunchCost(input: LaunchCostInput): LaunchCost {
  const rent = input.rent ?? rentExemptLamports;
  const items: LaunchCostItem[] = [];
  if (input.newConfig)
    items.push({ label: 'DBC config account (rent)', lamports: rent(LAUNCH_ACCOUNT_BYTES.dbcConfig) });
  items.push(
    { label: 'DBC pool account (rent)', lamports: rent(LAUNCH_ACCOUNT_BYTES.dbcPool) },
    { label: 'Token mint (rent)', lamports: rent(LAUNCH_ACCOUNT_BYTES.mint) },
    { label: 'Curve vaults: token and SOL (rent)', lamports: 2 * rent(LAUNCH_ACCOUNT_BYTES.tokenAccount) },
    {
      label: 'Token metadata (rent, at most) + Metaplex fee',
      lamports: rent(LAUNCH_ACCOUNT_BYTES.metadata) + METAPLEX_CREATE_FEE_LAMPORTS,
    },
    { label: 'Signature fees', lamports: input.signatures * SIGNATURE_FEE_LAMPORTS },
  );
  const priority = (input.priorityFeeLamports ?? 0) * (input.transactions ?? 1);
  if (priority > 0) items.push({ label: 'Priority fees', lamports: priority });
  if (input.initialBuyLamports) {
    items.push(
      { label: 'Initial buy', lamports: input.initialBuyLamports },
      { label: "Buyer's token account (rent)", lamports: rent(LAUNCH_ACCOUNT_BYTES.tokenAccount) },
    );
  }
  const totalLamports = items.reduce((sum, row) => sum + row.lamports, 0);
  return { items, totalLamports, totalSol: totalLamports / LAMPORTS_PER_SOL };
}
