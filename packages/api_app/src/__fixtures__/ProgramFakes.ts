/** Test-only builders around ProgramSim: mainnet validator rows, the directory and the service deps. */
import {
  type EventReader,
  NO_POOL_HISTORY,
  type PoolHistory,
  type ProgramServiceDeps,
} from '../Services/Program/ProgramSources';
import { type ValidatorRow } from '../types/Api.types';
import { type ProgramSim } from './ProgramSim';

/** 2026-10-03 10:00 IST. */
export const NOW = new Date('2026-10-03T04:30:00.000Z');

export function validatorRow(over: Partial<ValidatorRow> & Pick<ValidatorRow, 'name' | 'vote'>): ValidatorRow {
  return {
    identity: 'identity',
    voteShort: over.vote.slice(0, 4),
    client: 'Agave',
    clientId: 'JitoLabs',
    country: 'Germany',
    countryCode: 'DE',
    apyPct: 4.94,
    stakingApyPct: 4.8,
    tipsApyPct: 0.14,
    commissionPct: 5,
    stakeSol: 193_097,
    delegators: 1_988,
    biggestDelegatorSharePct: 42.1,
    blocksPerDay: 135,
    healthPerEpochSol: 2.1,
    uptimePct: 100,
    top18: false,
    epochScore: 100,
    mevCommissionPct: 10,
    delinquent: false,
    foundationSharePct: null,
    health: 'healthy',
    healthReasons: [],
    ...over,
  };
}

export interface FakeOptions {
  rows?: ValidatorRow[];
  epochsPerYear?: number;
  grossYieldPerEpoch?: number;
  /** The mainnet table fails to load. */
  directoryDown?: boolean;
  history?: PoolHistory;
  rewardsActive?: boolean | null;
}

export function fakeDeps(sim: ProgramSim, events: EventReader, options: FakeOptions = {}): ProgramServiceDeps {
  return {
    program: sim,
    events,
    validators: {
      get: async () => {
        if (options.directoryDown) throw new Error('mainnet RPC down');
        return {
          rows: options.rows ?? [],
          epochsPerYear: options.epochsPerYear ?? 271.5,
          grossYieldPerEpoch: options.grossYieldPerEpoch ?? 0.00018,
        };
      },
    },
    history: options.history ?? NO_POOL_HISTORY,
    rewardsActive: async () => (options.rewardsActive === undefined ? false : options.rewardsActive),
    now: () => NOW,
  };
}
