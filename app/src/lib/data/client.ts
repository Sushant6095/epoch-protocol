'use client';
import { useQuery } from '@tanstack/react-query';
export const API_BASE = (process.env.NEXT_PUBLIC_EPOCH_API_URL || '').replace(/\/$/, '');
export const apiConfigured = Boolean(API_BASE);
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE) throw new Error('The Epoch API is not connected yet.');
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error(body.error?.message || `Request failed (${response.status})`);
  return body.data as T;
}
export function useResource<T>(path: string, snapshot: T | null, enabled = true) {
  return useQuery({
    queryKey: [path, API_BASE || 'snapshot'],
    queryFn: ({ signal }) =>
      apiConfigured
        ? request<T>(path, { signal })
        : snapshot !== null
          ? Promise.resolve(snapshot)
          : Promise.reject(new Error('Connect the Epoch API to load this resource.')),
    enabled,
    staleTime: apiConfigured ? 30_000 : Infinity,
    refetchInterval: apiConfigured ? 60_000 : false,
  });
}
