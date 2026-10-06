"use client";
// WS /v1/stream: one socket for the whole app (packages/api_app/README.md "WS /v1/stream").
//   client → server: { op: "subscribe" | "unsubscribe", channels: [...] } · { op: "ping" }
//   server → client: { type: "hello", channels } · { type: "subscribed", channels } · { type: "error", message,
//                    channel? } · data frames { channel, data, at }
// Channels are reference-counted, so several components can listen to `slots` or `launch:<mint>` at once. A dropped
// socket reconnects with backoff (1 s, 2 s, 4 s … 30 s), subscribes again, and tells listeners it reconnected so they
// can reload what they may have missed (docs/pages/live.md "Refresh behaviour" step 4).

import { useEffect, useRef, useSyncExternalStore } from "react";

import { streamUrl } from "@/lib/env";

export type StreamState = "idle" | "connecting" | "open" | "reconnecting";

type DataListener = (data: unknown, at: string) => void;

interface Snapshot {
  state: StreamState;
  /** Channels the server says it can serve (`hello`); null before the first hello. */
  available: readonly string[] | null;
  /** Last frame of any kind, ms since epoch. */
  lastFrameAt: number | null;
  /** The newest `error` frame. */
  lastError: { message: string; channel?: string; at: number } | null;
}

class StreamClient {
  private ws: WebSocket | null = null;
  private enabled = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refs = new Map<string, number>();
  private listeners = new Map<string, Set<DataListener>>();
  private reconnectListeners = new Set<() => void>();
  private storeListeners = new Set<() => void>();
  private everOpened = false;
  private snapshot: Snapshot = { state: "idle", available: null, lastFrameAt: null, lastError: null };
  /** Last data frame, ms since epoch (read on a timer by whoever shows an age). */
  lastDataAt: number | null = null;

  getSnapshot = (): Snapshot => this.snapshot;
  subscribeStore = (fn: () => void) => {
    this.storeListeners.add(fn);
    return () => {
      this.storeListeners.delete(fn);
    };
  };

  private setSnap(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.storeListeners) fn();
  }

  /** The socket runs only while the API is reachable (sample mode never opens it). */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      if (this.refs.size > 0) this.connect();
    } else {
      this.close();
    }
  }

  /** Listen to a channel; returns the unsubscribe function. */
  subscribe(channel: string, listener: DataListener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    const n = (this.refs.get(channel) ?? 0) + 1;
    this.refs.set(channel, n);
    if (n === 1) {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ op: "subscribe", channels: [channel] });
      else if (this.enabled && !this.ws) this.connect();
    }
    return () => {
      set?.delete(listener);
      const left = (this.refs.get(channel) ?? 1) - 1;
      if (left <= 0) {
        this.refs.delete(channel);
        this.listeners.delete(channel);
        if (this.ws?.readyState === WebSocket.OPEN) this.send({ op: "unsubscribe", channels: [channel] });
      } else {
        this.refs.set(channel, left);
      }
    };
  }

  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => {
      this.reconnectListeners.delete(fn);
    };
  }

  /** null: not known yet (no hello). `launch:<key>` in hello means every launch channel is served. */
  isAvailable(channel: string): boolean | null {
    const list = this.snapshot.available;
    if (!list) return null;
    if (list.includes(channel)) return true;
    if (channel.startsWith("launch:")) return list.some((c) => c.startsWith("launch:"));
    return false;
  }

  private send(msg: unknown) {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* the close handler reconnects */
    }
  }

  private connect() {
    if (typeof window === "undefined" || this.ws) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setSnap({ state: this.everOpened ? "reconnecting" : "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(streamUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const reconnected = this.everOpened;
      this.attempt = 0;
      this.everOpened = true;
      this.setSnap({ state: "open", lastFrameAt: Date.now() });
      if (this.refs.size) this.send({ op: "subscribe", channels: [...this.refs.keys()] });
      if (reconnected) for (const fn of this.reconnectListeners) fn();
    };
    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const now = Date.now();
      if (msg.type === "hello" && Array.isArray(msg.channels)) {
        this.setSnap({ available: msg.channels as string[], lastFrameAt: now });
        return;
      }
      if (msg.type === "error") {
        this.setSnap({
          lastError: { message: String(msg.message ?? "Stream error"), channel: msg.channel as string | undefined, at: now },
          lastFrameAt: now,
        });
        return;
      }
      if (typeof msg.channel === "string" && "data" in msg) {
        this.lastDataAt = now; // kept outside the snapshot: no re-render for every frame
        const set = this.listeners.get(msg.channel);
        if (set) for (const fn of set) fn(msg.data, String(msg.at ?? new Date(now).toISOString()));
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.enabled && this.refs.size > 0) this.scheduleReconnect();
      else this.setSnap({ state: "idle" });
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    const delay = Math.min(30_000, 1_000 * 2 ** this.attempt);
    this.attempt++;
    this.setSnap({ state: "reconnecting" });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.enabled && this.refs.size > 0) this.connect();
    }, delay);
  }

  private close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.setSnap({ state: "idle" });
  }
}

export const stream = new StreamClient();

const serverSnapshot: Snapshot = { state: "idle", available: null, lastFrameAt: null, lastError: null };

export function useStreamStatus(): Snapshot {
  return useSyncExternalStore(stream.subscribeStore, stream.getSnapshot, () => serverSnapshot);
}

/** Subscribe a component to a channel for as long as it is mounted (null: not now). */
export function useStreamChannel<T>(channel: string | null, onData: (data: T, at: string) => void) {
  const ref = useRef(onData);
  useEffect(() => {
    ref.current = onData;
  });
  useEffect(() => {
    if (!channel) return;
    return stream.subscribe(channel, (data, at) => ref.current(data as T, at));
  }, [channel]);
}

/** Run `fn` each time the socket comes back after a drop (reload what may have been missed). */
export function useStreamReconnect(fn: () => void) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => stream.onReconnect(() => ref.current()), []);
}
