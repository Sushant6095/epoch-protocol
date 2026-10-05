import { Logger } from '@epoch/logger';
import { type ClaimableItem, type ClaimKind, fromBaseUnits, type LaunchClaimsState } from '@epoch/meteora';
import { type Keypair, PublicKey } from '@solana/web3.js';

import { type LaunchClaimChain } from '../Launch/LaunchClaimChain';
import { type ClaimLaunch } from '../Launch/LaunchRegistryFile';
import {
  isTreasuryClaim,
  TREASURY_CLAIM_COMPUTE_UNITS,
  treasuryClaimInstructions,
  type TreasuryClaimRoute,
} from '../Launch/TreasuryClaims';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('LaunchFeeClaimJob');

/** Claims that accrue continuously: left to accumulate below the minimum (each claim costs a fee). */
const ACCRUING: ReadonlySet<ClaimKind> = new Set(['partnerTradingFee', 'creatorTradingFee', 'lpFee']);

/** Where each claim's funds end up when its signer sends it, for the logs. */
const DESTINATION: Record<ClaimKind, string> = {
  partnerTradingFee: 'the fee claimer',
  partnerSurplus: 'the fee claimer',
  partnerMigrationFee: 'the fee claimer',
  lpFee: 'the LP position owner',
  creatorMigrationFee: 'the validator (upfront SOL)',
  creatorSurplus: 'the validator',
  creatorTradingFee: 'the validator',
  leftover: 'the leftover receiver (tokens)',
};

/** Where a treasury claim made through the Epoch program ends up (ADR 0006, amendment of 4 Oct 2026). */
const PROGRAM_DESTINATION = 'Epoch pool income for lenders (senior coupon first); tokens burned';

export interface LaunchFeeClaimOptions {
  /** This cluster's launches (re-read each run). */
  launches: () => ClaimLaunch[];
  chain: LaunchClaimChain;
  /** Keypairs that may sign claims, by public key: the treasury (fee claimer) and any creators. */
  signers: ReadonlyMap<string, Keypair>;
  /** Pays for permissionless claims (the leftover). Default: the first signer. */
  payer?: Keypair;
  kinds: ReadonlySet<ClaimKind>;
  /** Accruing fees below this are not claimed yet, lamports. */
  minLamports: bigint;
  /** Simulate and log every claim; send nothing. */
  dryRun: boolean;
  /**
   * Claims the Epoch partner treasury PDA owns go through the Epoch program, sent and paid (fees only) by the crank.
   * Without it they need the fee claimer's key in `signers` (a fee claimer that is a plain wallet).
   */
  program?: TreasuryClaimRoute;
}

/** What one run did, for logs and tests. `via: 'program'` marks a treasury claim made through the Epoch program. */
export interface ClaimRunSummary {
  claimed: {
    symbol: string;
    kind: ClaimKind;
    signature: string;
    lamports: bigint;
    tokens: bigint;
    via?: 'program';
  }[];
  simulated: { symbol: string; kind: ClaimKind; ok: boolean; reason: string; via?: 'program' }[];
  failed: { symbol: string; kind: ClaimKind | 'read'; error: string }[];
}

/**
 * Claims what Epoch and the launches' creators are owed from each revenue token's Meteora pools (ADR 0006, plan F13).
 *
 * Epoch's own share belongs to the partner treasury PDA `["treasury", pool]` (every launch's DBC fee claimer and
 * leftover receiver): the DBC partner trading fees, the partner's surplus and migration fee, the leftover supply and
 * the fees of the DAMM v2 LP position it owns. A PDA cannot sign, so with `program` set those claims are Epoch program
 * instructions sent by the crank (it pays the fee only): the SOL becomes pool income for lenders and the tokens are
 * burned. The creator's 70% migration fee, surplus and trading fees are signed with the creator's own key when it is
 * configured.
 *
 * Every run reads the pools first and claims only what is available, so repeats are no-ops: accruing fees under
 * `minLamports` wait, and one-shot withdrawals are flagged on chain after they happen. A claim whose signer's key is
 * not configured, or any claim under `dryRun`, is simulated and logged instead.
 */
export class LaunchFeeClaimJob implements Job {
  readonly name = 'LaunchFeeClaimJob';
  /** The last run's summary. */
  last: ClaimRunSummary = { claimed: [], simulated: [], failed: [] };

  constructor(private readonly options: LaunchFeeClaimOptions) {}

  /** The partner treasury PDA whose claims go through the program, when that route is on. */
  get treasury(): PublicKey | undefined {
    return this.options.program?.treasury;
  }

  async run(): Promise<JobOutcome> {
    const summary: ClaimRunSummary = { claimed: [], simulated: [], failed: [] };
    for (const launch of this.options.launches()) {
      let state;
      try {
        state = await this.options.chain.readClaims(launch);
      } catch (error) {
        summary.failed.push({ symbol: launch.symbol, kind: 'read', error: String(error) });
        logger.warn('could not read a launch; retrying next run', { symbol: launch.symbol, error: String(error) });
        continue;
      }
      if (!state) {
        logger.debug('launch pool not found', { symbol: launch.symbol, dbcPool: launch.dbcPool });
        continue;
      }
      for (const claim of state.items) {
        if (!this.options.kinds.has(claim.kind) || !claim.available) continue;
        if (ACCRUING.has(claim.kind) && claim.tokens === 0n && claim.lamports < this.options.minLamports) continue;
        if (this.options.program && isTreasuryClaim(claim, this.options.program.treasury)) {
          await this.claimThroughProgram(this.options.program, launch, state, claim, summary);
        } else {
          await this.claim(launch, claim, state.dammPool, state.baseDecimals, summary);
        }
      }
      await this.burnWithdrawnLeftover(launch, state, summary);
    }
    this.last = summary;
    if (summary.claimed.length > 0 || summary.failed.length > 0) {
      logger.info('launch fee claims run', {
        claimed: summary.claimed.length,
        simulated: summary.simulated.length,
        failed: summary.failed.length,
      });
    }
    return summary.failed.length > 0 ? 'retry' : 'done';
  }

  private async claim(
    launch: ClaimLaunch,
    claim: ClaimableItem,
    dammPool: string | null,
    baseDecimals: number,
    summary: ClaimRunSummary,
  ): Promise<void> {
    const signer = claim.signer ? this.options.signers.get(claim.signer) : (this.options.payer ?? this.firstSigner());
    const context = {
      symbol: launch.symbol,
      kind: claim.kind,
      sol: fromBaseUnits(claim.lamports, 9),
      tokens: fromBaseUnits(claim.tokens, baseDecimals),
      signer: claim.signer ?? signer?.publicKey.toBase58() ?? null,
      to: claim.receiver,
      destination: DESTINATION[claim.kind],
      ...(claim.position ? { position: claim.position } : {}),
    };
    if (this.options.dryRun || !signer) {
      const reason = this.options.dryRun ? 'LAUNCH_CLAIMS_DRY_RUN' : 'no key for the signer';
      const simulateAs = claim.signer ? new PublicKey(claim.signer) : (signer?.publicKey ?? null);
      let simulation = { ok: false, error: 'no payer to simulate a permissionless claim' as string | null };
      if (simulateAs) {
        try {
          simulation = await this.options.chain.simulateClaim(launch, claim, dammPool, simulateAs);
        } catch (error) {
          simulation = { ok: false, error: String(error) };
        }
      }
      summary.simulated.push({ symbol: launch.symbol, kind: claim.kind, ok: simulation.ok, reason });
      logger.info('launch claim not sent (dry run)', {
        ...context,
        reason,
        simulation: simulation.ok ? 'ok' : simulation.error,
      });
      return;
    }
    try {
      const signature = await this.options.chain.sendClaim(launch, claim, dammPool, signer);
      summary.claimed.push({
        symbol: launch.symbol,
        kind: claim.kind,
        signature,
        lamports: claim.lamports,
        tokens: claim.tokens,
      });
      logger.info('launch claim sent', { ...context, signature });
    } catch (error) {
      summary.failed.push({ symbol: launch.symbol, kind: claim.kind, error: String(error) });
      logger.error('launch claim failed; retrying next run', error, context);
    }
  }

  /**
   * DBC lets anyone withdraw the leftover to the receiver's token account. When that happened to the treasury, the
   * tokens wait there unburned and the pool reports the leftover as withdrawn, so look at the account itself and burn
   * what it holds (`burn_leftover` burns the account's balance once DBC's leftover is gone).
   */
  private async burnWithdrawnLeftover(
    launch: ClaimLaunch,
    state: LaunchClaimsState,
    summary: ClaimRunSummary,
  ): Promise<void> {
    const route = this.options.program;
    if (!route || !this.options.kinds.has('leftover') || !state.leftover.withdrawn) return;
    if (state.leftoverReceiver !== route.treasury.toBase58()) return;
    let held: bigint;
    try {
      held = await this.options.chain.treasuryTokenBalance(new PublicKey(launch.mint), route.treasury);
    } catch (error) {
      summary.failed.push({ symbol: launch.symbol, kind: 'leftover', error: String(error) });
      return;
    }
    if (held === 0n) return;
    const claim: ClaimableItem = {
      kind: 'leftover',
      signer: null,
      receiver: route.treasury.toBase58(),
      lamports: 0n,
      tokens: held,
      available: true,
      withdrawn: true,
      reason: null,
    };
    await this.claimThroughProgram(route, launch, state, claim, summary);
  }

  /** A treasury claim: the Epoch program instruction, signed and paid (fees only) by the crank. */
  private async claimThroughProgram(
    route: TreasuryClaimRoute,
    launch: ClaimLaunch,
    state: LaunchClaimsState,
    claim: ClaimableItem,
    summary: ClaimRunSummary,
  ): Promise<void> {
    const cranker = route.cranker.publicKey;
    const context = {
      symbol: launch.symbol,
      kind: claim.kind,
      sol: fromBaseUnits(claim.lamports, 9),
      tokens: fromBaseUnits(claim.tokens, state.baseDecimals),
      via: 'epoch program',
      treasury: route.treasury.toBase58(),
      cranker: cranker.toBase58(),
      destination: PROGRAM_DESTINATION,
      ...(claim.position ? { position: claim.position } : {}),
    };
    try {
      const instructions = treasuryClaimInstructions({ programId: route.programId, cranker, launch, state, claim });
      if (this.options.dryRun) {
        const simulation = await this.options.chain.simulateProgramClaim(
          instructions,
          cranker,
          TREASURY_CLAIM_COMPUTE_UNITS,
        );
        summary.simulated.push({
          symbol: launch.symbol,
          kind: claim.kind,
          ok: simulation.ok,
          reason: 'LAUNCH_CLAIMS_DRY_RUN',
          via: 'program',
        });
        logger.info('treasury claim not sent (dry run)', {
          ...context,
          simulation: simulation.ok ? 'ok' : simulation.error,
        });
        return;
      }
      const signature = await this.options.chain.sendProgramClaim(
        instructions,
        route.cranker,
        TREASURY_CLAIM_COMPUTE_UNITS,
      );
      summary.claimed.push({
        symbol: launch.symbol,
        kind: claim.kind,
        signature,
        lamports: claim.lamports,
        tokens: claim.tokens,
        via: 'program',
      });
      logger.info('treasury claim sent', { ...context, signature });
    } catch (error) {
      summary.failed.push({ symbol: launch.symbol, kind: claim.kind, error: String(error) });
      logger.error('treasury claim failed; retrying next run', error, context);
    }
  }

  private firstSigner(): Keypair | undefined {
    return this.options.signers.values().next().value;
  }
}
