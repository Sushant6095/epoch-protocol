'use client';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EpochWalletProvider } from '@/components/wallet/wallet-provider';
import { Stream } from '@/components/epoch/stream';
import { useApiStatus } from '@/lib/api/status';
import { stream } from '@/lib/api/stream';

/** Probes the API once, re-probes while offline, and runs the side-track socket only while the API answers. */
function ApiStatusBoot() {
  const mode = useApiStatus((s) => s.mode);
  const probe = useApiStatus((s) => s.probe);
  useEffect(() => {
    void probe();
  }, [probe]);
  useEffect(() => {
    if (mode !== 'offline') return;
    const id = setInterval(() => void probe(), 20_000);
    return () => clearInterval(id);
  }, [mode, probe]);
  useEffect(() => {
    stream.setEnabled(mode === 'online');
  }, [mode]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, gcTime: 5 * 60_000 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <NuqsAdapter>
        <EpochWalletProvider>
          <TooltipProvider delay={150}>
            <ApiStatusBoot />
            <Suspense fallback={<div className="p-8 text-muted-foreground">Loading Epoch…</div>}>{children}</Suspense>
            <Stream />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </EpochWalletProvider>
      </NuqsAdapter>
    </QueryClientProvider>
  );
}
