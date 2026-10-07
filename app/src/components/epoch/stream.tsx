'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, apiConfigured } from '@/lib/data/client';
/** One socket per app; HTTP remains the source of complete typed snapshots. */
export function Stream() {
  const cache = useQueryClient();
  useEffect(() => {
    if (!apiConfigured) return;
    let disposed = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout>;
    const last = new Map<string, number>();
    let attempts = 0;
    function connect() {
      if (disposed) return;
      const url = new URL(`${API_BASE}/v1/stream`);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => {
        attempts = 0;
        socket?.send(JSON.stringify({ op: 'subscribe', channels: ['slot', 'activity', 'vault', 'feeIndex'] }));
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          const key =
            frame.channel === 'slot'
              ? '/v1/network'
              : frame.channel === 'activity'
                ? '/v1/activity?limit=12'
                : frame.channel === 'vault'
                  ? '/v1/vault'
                  : frame.channel === 'feeIndex'
                    ? '/v1/index'
                    : null;
          if (!key || Date.now() - (last.get(key) ?? 0) < 10_000) return;
          last.set(key, Date.now());
          void cache.invalidateQueries({ predicate: (q) => q.queryKey[0] === key });
        } catch {}
      };
      socket.onclose = () => {
        if (!disposed) timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts++));
      };
      socket.onerror = () => socket?.close();
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [cache]);
  return null;
}
