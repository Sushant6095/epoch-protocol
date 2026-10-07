'use client';
import { useResource } from './client';
import fixture from '@/fixtures/network.real.json';
import type { NetworkSnapshot } from './contracts/Api.types';
export function useNetwork() {
  return useResource<NetworkSnapshot>('/v1/network', { ...fixture, schemaVersion: 1, kind: 'real' });
}
