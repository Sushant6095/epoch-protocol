import {
  burnLeftover,
  claimPartnerMigrationFee,
  claimPartnerSurplus,
  claimPartnerTradingFee,
  claimTreasuryLpFee,
  findPartnerTreasuryPda,
  findPoolPda,
} from '@epoch/epoch-sdk';
import { type ClaimableItem, type ClaimKind, type LaunchClaimsState } from '@epoch/meteora';
import { type Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';

import { type ClaimLaunch } from './LaunchRegistryFile';

/**
 * Compute units for one treasury claim: the program creates and closes up to two token accounts around the Meteora
 * call. Measured on localnet against the mainnet binaries: 16k–75k (the heaviest, a DAMM v2 fee claim that burns
 * token A, 74,802), so this leaves twice the headroom.
 */
export const TREASURY_CLAIM_COMPUTE_UNITS = 150_000;

/**
 * The Epoch program route for claims the partner treasury owns. The treasury is a PDA (`["treasury", pool]`) and cannot
 * sign, so the program claims on its behalf: anyone may send these instructions, and `cranker` pays only the fee.
 */
export interface TreasuryClaimRoute {
  programId: PublicKey;
  /** `["treasury", pool]` of `programId`: the DBC fee claimer and leftover receiver of Epoch's launches. */
  treasury: PublicKey;
  /** Signs and pays the transaction fee (the rent it fronts comes back in the same instruction). */
  cranker: Keypair;
}

export function treasuryClaimRoute(programId: PublicKey, cranker: Keypair): TreasuryClaimRoute {
  const [pool] = findPoolPda(programId);
  return { programId, treasury: findPartnerTreasuryPda(programId, pool)[0], cranker };
}

/** Kinds the program can claim for the treasury. Creator claims are signed by the creator's own key. */
const PROGRAM_KINDS: ReadonlySet<ClaimKind> = new Set([
  'partnerTradingFee',
  'partnerSurplus',
  'partnerMigrationFee',
  'leftover',
  'lpFee',
]);

/** Whether `claim` belongs to the treasury: it must sign it, or (the leftover) receive it. */
export function isTreasuryClaim(claim: ClaimableItem, treasury: PublicKey): boolean {
  if (!PROGRAM_KINDS.has(claim.kind)) return false;
  const owner = claim.kind === 'leftover' ? claim.receiver : claim.signer;
  return owner === treasury.toBase58();
}

/**
 * The Epoch program instruction for a treasury-owned claim: SOL becomes pool income, tokens are burned. Throws when a
 * needed account is unknown (a launch without its config, an LP claim whose position was not read).
 */
export function treasuryClaimInstructions(input: {
  programId: PublicKey;
  cranker: PublicKey;
  launch: ClaimLaunch;
  state: LaunchClaimsState;
  claim: ClaimableItem;
}): TransactionInstruction[] {
  const { programId, cranker, launch, state, claim } = input;
  const dbcPool = new PublicKey(launch.dbcPool);
  const dbcConfig = new PublicKey(state.config);
  const mint = new PublicKey(launch.mint);
  switch (claim.kind) {
    case 'partnerTradingFee':
      return claimPartnerTradingFee({ programId, cranker, dbcPool, dbcConfig, mint });
    case 'partnerSurplus':
      return claimPartnerSurplus({ programId, cranker, dbcPool, dbcConfig });
    case 'partnerMigrationFee':
      return claimPartnerMigrationFee({ programId, cranker, dbcPool, dbcConfig });
    case 'leftover':
      return burnLeftover({ programId, cranker, dbcPool, dbcConfig, mint });
    case 'lpFee': {
      const position = state.positions.find((candidate) => candidate.position === claim.position);
      if (!position || !state.dammPool) throw new Error(`LP position ${claim.position ?? '?'} was not read`);
      return claimTreasuryLpFee({
        programId,
        cranker,
        dammPool: new PublicKey(state.dammPool),
        mint,
        position: new PublicKey(position.position),
        nftMint: new PublicKey(position.nftMint),
      });
    }
    default:
      throw new Error(`${claim.kind} is not a treasury claim`);
  }
}
