/**
 * Fakes for the India page tests. Stakewiz geolocated no validator in India on 3 Oct 2026, so the Indian rows here
 * are made up (Mumbai, Bengaluru, Chennai); every other figure is in the range mainnet showed that day.
 */
import { type StakewizValidator } from '../Sources/ExternalSources';
import { type LivePrice } from '../Services/India/InrPriceService';
import { type ValidatorTableData } from '../Services/ValidatorTable';
import { type ValidatorRow } from '../types/Api.types';
import { type ValidatorProfile } from '../types/Wallet.types';
import { validatorRow } from './ProgramFakes';

export const VOTES = {
  mumbai: 'Mumb1VoteAccount111111111111111111111111111',
  bengaluru: 'BLR2VoteAccount1111111111111111111111111111',
  chennai: 'Chen3VoteAccount111111111111111111111111111',
  frankfurt: 'FRA4VoteAccount1111111111111111111111111111',
  ashburn: 'ASH5VoteAccount1111111111111111111111111111',
  singapore: 'SGP6VoteAccount1111111111111111111111111111',
  listed: 'SGP7ListedVoteAccount1111111111111111111111',
  nowhere: 'XXX8VoteAccount1111111111111111111111111111',
} as const;

const india = { country: 'India', countryCode: 'IN' };

export function indiaRows(): ValidatorRow[] {
  return [
    validatorRow({
      name: 'Frankfurt Big',
      vote: VOTES.frankfurt,
      country: 'Germany',
      countryCode: 'DE',
      stakeSol: 1_000_000,
    }),
    validatorRow({
      name: 'Ashburn',
      vote: VOTES.ashburn,
      country: 'United States',
      countryCode: 'US',
      stakeSol: 500_000,
    }),
    validatorRow({
      name: 'Singapore One',
      vote: VOTES.singapore,
      country: 'Singapore',
      countryCode: 'SG',
      stakeSol: 300_000,
    }),
    validatorRow({
      name: 'Mumbai One',
      vote: VOTES.mumbai,
      ...india,
      stakeSol: 200_000,
      commissionPct: 5,
      mevCommissionPct: 5,
      tipsApyPct: 0.2,
      blocksPerDay: 400,
      apyPct: 6.1,
      epochScore: 96,
    }),
    validatorRow({
      name: 'Listed Indian Operator',
      vote: VOTES.listed,
      country: 'Singapore',
      countryCode: 'SG',
      stakeSol: 80_000,
      apyPct: 6.4,
    }),
    validatorRow({
      name: 'Bengaluru Two',
      vote: VOTES.bengaluru,
      ...india,
      stakeSol: 50_000,
      commissionPct: 0,
      apyPct: 6.6,
      client: 'Firedancer',
      clientId: 'Frankendancer',
      health: 'watch',
      healthReasons: ['below break-even'],
    }),
    validatorRow({ name: 'Chennai Three', vote: VOTES.chennai, ...india, stakeSol: 10_000, apyPct: null }),
    validatorRow({ name: 'Nowhere', vote: VOTES.nowhere, country: 'Unknown', countryCode: 'XX', stakeSol: 5_000 }),
  ];
}

/** The validator table as the India services read it (3 Oct 2026 network rates, 32-hour epochs). */
export function indiaTable(over: Partial<ValidatorTableData> = {}): ValidatorTableData {
  const rows = over.rows ?? indiaRows();
  return {
    asOf: '2026-10-03T18:15:00+05:30',
    rows,
    epoch: { epoch: 1048, slotIndex: 216_000, slotsInEpoch: 432_000, absoluteSlot: 452_952_000 },
    secondsPerSlot: 0.267,
    hoursPerEpoch: 32,
    epochsPerYear: 273.9,
    voteFeesPerEpochSol: 2.16,
    grossYieldPerEpoch: 0.000_178_6,
    feePerBlockSol: 0.0125,
    medianCommissionBps: 500,
    totalStakeSol: rows.reduce((s, r) => s + r.stakeSol, 0),
    superminorityCount: 18,
    recentlyDelinquent: 0,
    clients: { agavePct: 80, firedancerPct: 20, validatorsWithVersion: rows.length },
    blocks: { perDay: 324_000, skipRatePct: 1 },
    sources: ['Solana mainnet RPC', 'Stakewiz', 'Jito Kobe'],
    scanAsOf: null,
    historyVersion: 0,
    ...over,
  };
}

export function indiaStakewiz(): Map<string, StakewizValidator> {
  const row = (vote: string, city: string | null, org: string): StakewizValidator =>
    ({ vote_identity: vote, ip_city: city, ip_org: org }) as StakewizValidator;
  return new Map([
    [VOTES.mumbai, row(VOTES.mumbai, 'Mumbai', 'Equinix India')],
    [VOTES.bengaluru, row(VOTES.bengaluru, 'Bengaluru', 'Tata Communications')],
    [VOTES.chennai, row(VOTES.chennai, null, 'Unknown host')],
    [VOTES.listed, row(VOTES.listed, 'Singapore', 'The Constant Company, LLC')],
  ]);
}

/** The parts of a validator profile the India page reads. */
export function indiaProfile(vote: string): ValidatorProfile {
  return {
    vote,
    revenueEpoch: 1047,
    revenueLastEpochSol: {
      inflationCommission: 1.8,
      tipsCommission: 0.25,
      blockFeesEstimate: 1.6,
      voteFees: -2.16,
      netEstimate: 1.49,
    },
    creditEstimate: {
      sweepablePerEpochSol: 2.05,
      sweepableLast10EpochsSol: 20.4,
      limitUnhedgedSol: 5.1,
      limitHedgedSol: 8.16,
      note: 'limit = min(25% or 40% hedged of 10 epochs’ swept revenue, 4 x bond, cap)',
    },
  } as ValidatorProfile;
}

export function livePrice(over: Partial<LivePrice> = {}): LivePrice {
  return {
    inr: 11_496.63,
    usd: 119.35,
    usdInr: 96.33,
    change24hPct: -2.11,
    source: 'CoinGecko',
    observedAtMs: Date.parse('2026-10-03T18:05:10+05:30'),
    fetchedAtMs: Date.parse('2026-10-03T18:06:00+05:30'),
    stale: false,
    staleReason: null,
    ...over,
  };
}
