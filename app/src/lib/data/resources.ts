'use client';
import { useResource, request, apiConfigured } from './client';
import history from '@/fixtures/stake-history-64.real.json';
import vault from '@/fixtures/vault.sample.json';
import activity from '@/fixtures/activity.sample.json';
import fees from '@/fixtures/fee-index.sample.json';
import biggest from '@/fixtures/biggest-delegators.real.json';
import profile from '@/fixtures/validator-ntt-docomo.real.json';
import type { StakeHistory } from './contracts/Api.types';
import type {
  VaultSnapshot,
  FeeMarketSnapshot,
  LenderPositionSnapshot,
  OperatorPositionSnapshot,
} from './contracts/Program.types';
import type { ValidatorProfile, MyStake } from './contracts/Wallet.types';
import type { SessionView, PredictSnapshot, AlertPrefs } from './contracts/Account.types';
import type { ActivityFeed, FeeIndexPoint } from './contracts/Activity.types';
import { useQuery } from '@tanstack/react-query';
export function useStakeHistory() {
  return useResource<StakeHistory>('/v1/network/stake-history?epochs=64', {
    ...history,
    schemaVersion: 1,
    kind: 'real',
    unit: 'SOL',
  });
}
export function useVault() {
  return useResource<VaultSnapshot>('/v1/vault', vault as unknown as VaultSnapshot);
}
export function useActivity() {
  return useResource<ActivityFeed>('/v1/activity?limit=12', activity as unknown as ActivityFeed);
}
export function useBiggestDelegators() {
  return useResource('/v1/delegators/biggest', biggest);
}
export function useFeeIndex() {
  return useQuery({
    queryKey: ['/v1/index', apiConfigured],
    queryFn: async () =>
      apiConfigured
        ? {
            kind: 'real' as const,
            asOf: null,
            source: 'Epoch Fee Index API',
            points: await request<FeeIndexPoint[]>('/v1/index?limit=64'),
          }
        : fees,
    staleTime: 30_000,
  });
}
const adaptedProfile: ValidatorProfile = {
  ...profile,
  schemaVersion: 1,
  kind: 'real',
  stakeByEpoch: profile.stakeByEpoch as [number, number][],
  voteCreditsByEpoch: { ...profile.voteCreditsByEpoch, rows: profile.voteCreditsByEpoch.rows as [number, number][] },
  jitoTipsTotalByEpochSol: profile.jitoTipsTotalByEpochSol as [number, number][],
  stakeMoves: profile.stakeMoves as ValidatorProfile['stakeMoves'],
  revenueEpoch: 1043,
  revenueLastEpochSol: profile.revenueEpoch1043Sol,
};
export function useValidator(vote: string) {
  return useResource<ValidatorProfile>(
    `/v1/validators/${encodeURIComponent(vote)}`,
    vote === profile.vote ? adaptedProfile : null,
    Boolean(vote),
  );
}
export function useSession() {
  return useResource<SessionView | null>('/v1/auth/session', null, apiConfigured);
}
export function useMyStake(wallet: string) {
  return useResource<MyStake>(
    `/v1/wallets/${encodeURIComponent(wallet)}/stake`,
    null,
    Boolean(wallet) && apiConfigured,
  );
}
export function useLender(wallet: string) {
  return useResource<LenderPositionSnapshot>(
    `/v1/wallets/${encodeURIComponent(wallet)}/lender`,
    null,
    Boolean(wallet) && apiConfigured,
  );
}
export function useOperatorPosition(vote: string) {
  return useResource<OperatorPositionSnapshot>(
    `/v1/validators/${encodeURIComponent(vote)}/position`,
    null,
    Boolean(vote) && apiConfigured,
  );
}
export function useFeeMarket() {
  return useResource<FeeMarketSnapshot>('/v1/market', null, apiConfigured);
}
export function usePredict() {
  return useResource<PredictSnapshot>('/v1/predict/markets', null, apiConfigured);
}
export function useAlerts(enabled: boolean) {
  return useResource<AlertPrefs>('/v1/me/alerts', null, enabled && apiConfigured);
}
