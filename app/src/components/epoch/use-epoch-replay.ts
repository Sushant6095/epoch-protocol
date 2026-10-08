'use client';
import { useEffect, useRef, useState } from 'react';
import type { NetworkSnapshot } from '@/lib/data/contracts/Api.types';
import validators from '@/fixtures/validators.real.json';

/**
 * Replays the epoch forward from the network snapshot so the Terminal reads like a running chain:
 * one slot every 400 ms (Solana's target), a stake-weighted leader per slot, a simulated block size and a
 * TPS reading that breathes around the snapshot value. Always labelled as a replay, never as live data.
 * Stops for reduced motion, when paused, or while the tab is hidden.
 */
export type ReplayBlock = { slot: number; leader: string; vote: string; txs: number; skipped: boolean };

const leaders = validators.rows.filter((r) => r.name && r.name !== 'Unnamed');
const totalStake = leaders.reduce((s, r) => s + r.stakeSol, 0);
function pickLeader(rand: number) {
  let acc = 0;
  for (const r of leaders) {
    acc += r.stakeSol / totalStake;
    if (rand <= acc) return r;
  }
  return leaders[0];
}

export function useEpochReplay(n: NetworkSnapshot, { enabled = true, slotMs = 400 } = {}) {
  const [slotIndex, setSlotIndex] = useState(n.epoch.slotIndex);
  const [tps, setTps] = useState(n.tps.total);
  const [blocks, setBlocks] = useState<ReplayBlock[]>([]);
  const [running, setRunning] = useState(false);
  const leaderRun = useRef({ left: 0, row: leaders[0] });

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!enabled || reduce) {
      setRunning(false);
      return;
    }
    setRunning(true);
    let tick = 0;
    const id = setInterval(() => {
      if (document.hidden) return;
      tick++;
      setSlotIndex((i) => (i + 1 >= n.epoch.slotsInEpoch ? n.epoch.slotIndex : i + 1));
      // leaders produce 4 consecutive slots, as on mainnet
      if (leaderRun.current.left <= 0) leaderRun.current = { left: 4, row: pickLeader(Math.random()) };
      leaderRun.current.left--;
      const row = leaderRun.current.row;
      const skipped = Math.random() < Math.max(n.blocks.skipRatePct / 100, 0.004);
      setBlocks((b) => {
        const slot = n.epoch.startSlot + (b.length ? b[b.length - 1].slot - n.epoch.startSlot + 1 : n.epoch.slotIndex + 1);
        const next = { slot, leader: row.name, vote: row.vote, skipped, txs: skipped ? 0 : Math.round(900 + Math.random() * 1700) };
        return [...b.slice(-63), next];
      });
      if (tick % 3 === 0) setTps(Math.round(n.tps.total * (0.95 + Math.random() * 0.1)));
    }, slotMs);
    return () => clearInterval(id);
  }, [enabled, slotMs, n]);

  return { slotIndex, tps, blocks, running };
}
