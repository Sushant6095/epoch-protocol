import { PostgresConnectionManager } from '@epoch/pg_models';

import { dbAvailable } from '../../Lib/Db';
import { getServices } from '../index';
import { FeeMarketService } from './FeeMarketService';
import { LenderPositionService } from './LenderPositionService';
import { OperatorPositionService } from './OperatorPositionService';
import { PgPoolHistory } from './PoolHistory';
import { NO_POOL_HISTORY, type ProgramServiceDeps, readEpochRewardsActive } from './ProgramSources';
import { VaultService } from './VaultService';

/** The services behind /v1/vault, /v1/validators/:vote/position, /v1/wallets/:address/lender and /v1/market. */
export interface ProgramServices {
  /** Also the WS `vault` channel's payload: `vault.snapshot()` without a session. */
  vault: VaultService;
  positions: OperatorPositionService;
  lenders: LenderPositionService;
  market: FeeMarketService;
}

export function createProgramServices(deps: ProgramServiceDeps): ProgramServices {
  return {
    vault: new VaultService(deps),
    positions: new OperatorPositionService(deps),
    lenders: new LenderPositionService(deps),
    market: new FeeMarketService(deps),
  };
}

let programServices: ProgramServices | undefined;

/** One set per process, built from `getServices()` on first use. */
export function getProgramServices(): ProgramServices {
  if (!programServices) {
    const services = getServices();
    programServices = createProgramServices({
      program: services.program,
      events: services.events,
      validators: services.validators,
      history: dbAvailable() ? new PgPoolHistory(PostgresConnectionManager.getDb()) : NO_POOL_HISTORY,
      rewardsActive: () => readEpochRewardsActive(services.program.connections),
      mev: (vote) => services.mev.latest?.byVote.get(vote),
    });
  }
  return programServices;
}

/** Replaces the process-wide set (tests); `undefined` rebuilds it from `getServices()` on next use. */
export function setProgramServices(services: ProgramServices | undefined): void {
  programServices = services;
}
