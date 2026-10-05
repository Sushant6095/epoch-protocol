import { findPartnerTreasuryPda, findPoolPda, findVaultPda } from '@epoch/epoch-sdk';
import { type PublicKey } from '@solana/web3.js';

import { type LaunchTreasuryClaims } from '../../types/Buyback.types';
import { type EventReader } from '../Program/ProgramSources';
import { queryTreasuryClaims, treasuryClaims } from './BuybackFeed';

/** Claims listed per launch (the totals count every claim). */
const LISTED = 200;

/**
 * Epoch's partner treasury for the Launch page's `/fees` (ADR 0006, amendment of 4 Oct 2026): the treasury PDA
 * `["treasury", pool]` every launch names as DBC fee claimer, the pool vault `["vault", pool]` its claims pay into, and
 * the mint's `TreasuryClaimed` events, summed exactly as `/v1/launches/:mint/buybacks` sums them.
 */
export interface TreasuryClaimsSource {
  /** The treasury PDA; null without a program id. */
  readonly treasury: string | null;
  /** The lending pool's vault, where claimed SOL goes; null without a program id. */
  readonly vault: string | null;
  claims(mint: string, decimals: number): Promise<LaunchTreasuryClaims>;
}

/** From the API's ingested program events. */
export class EventTreasuryClaimsSource implements TreasuryClaimsSource {
  readonly treasury: string | null;
  readonly vault: string | null;
  private readonly treasuryKey: PublicKey | null;

  constructor(
    private readonly events: EventReader,
    programId: PublicKey | null,
  ) {
    const pool = programId ? findPoolPda(programId)[0] : null;
    this.treasuryKey = programId && pool ? findPartnerTreasuryPda(programId, pool)[0] : null;
    this.treasury = this.treasuryKey?.toBase58() ?? null;
    this.vault = programId && pool ? findVaultPda(programId, pool)[0].toBase58() : null;
  }

  async claims(mint: string, decimals: number): Promise<LaunchTreasuryClaims> {
    return treasuryClaims(await queryTreasuryClaims(this.events, mint), decimals, mint, this.treasuryKey, LISTED);
  }
}
