import { launchTradesFromTransaction, normalizeTransaction } from '@epoch/meteora';
import { CommitmentLevel, type GeyserClient, type SubscribeRequest, type SubscribeUpdate } from '@epoch/solana';
import { type Context, type Logs, type PublicKey, type SlotInfo } from '@solana/web3.js';

import { DAMM_POOL, DBC_POOL, rehearsalGrpcUpdate, rehearsalTx } from '../../__fixtures__/LaunchFixtures';
import { launchRealtimeSource } from './LaunchLive';
import {
  GrpcRealtimeSource,
  launchTransactionsRequest,
  type LogsConnection,
  type RealtimeTransaction,
  rpcTransactionFromGrpc,
  WebsocketRealtimeSource,
} from './LaunchRealtime';

const NOW = Date.parse('2026-10-05T16:30:00Z');

describe('rpcTransactionFromGrpc', () => {
  it.each(['dbc-buy', 'migrate-damm-v2', 'damm-sell', 'claim-lp-fee'])(
    'reads %s from its gRPC update exactly as from getTransaction',
    (name) => {
      const recorded = rehearsalTx(name);
      // gRPC carries no block time: the caller passes what it knows (the arrival time); here, the recorded one.
      const tx = rpcTransactionFromGrpc(rehearsalGrpcUpdate(name), recorded.blockTime);
      expect(tx).toMatchObject({ signature: recorded.signature, slot: recorded.slot, failed: false });
      const fromGrpc = normalizeTransaction(tx?.raw, recorded.signature);
      const fromRpc = normalizeTransaction(recorded.raw, recorded.signature);
      expect(fromGrpc).toEqual(fromRpc);
      // The decoder finds the same trades in both.
      const pools = new Map([
        [DBC_POOL, { venue: 'dbc' as const, baseDecimals: 6 }],
        [DAMM_POOL, { venue: 'damm-v2' as const, baseDecimals: 6, baseIsTokenA: true }],
      ]);
      expect(launchTradesFromTransaction(fromGrpc, pools)).toEqual(launchTradesFromTransaction(fromRpc, pools));
      expect(tx?.keys).toEqual(expect.arrayContaining(recorded.accounts));
    },
  );

  it('flags a failed transaction, and has nothing for an update without one', () => {
    const update = rehearsalGrpcUpdate('dbc-buy');
    const meta = update.transaction?.meta;
    if (meta) meta.err = { err: Uint8Array.from([8, 0, 0, 0]) };
    expect(rpcTransactionFromGrpc(update, null)?.failed).toBe(true);
    expect(rpcTransactionFromGrpc({ slot: '1', transaction: undefined }, null)).toBeNull();
  });
});

describe('launchTransactionsRequest', () => {
  it("asks for the pools' confirmed, successful, non-vote transactions, and never for a firehose", () => {
    expect(launchTransactionsRequest([DBC_POOL, DAMM_POOL])).toMatchObject({
      transactions: {
        launch: {
          vote: false,
          failed: false,
          accountInclude: [DBC_POOL, DAMM_POOL],
          accountExclude: [],
          accountRequired: [],
        },
      },
      slots: {},
      blocks: {},
      commitment: CommitmentLevel.CONFIRMED,
    });
    expect(() => launchTransactionsRequest([])).toThrow('at least one pool');
  });
});

/** A Yellowstone client that streams the given updates, then stays open until destroyed. */
function fakeGeyser(updates: SubscribeUpdate[]) {
  const requests: SubscribeRequest[] = [];
  const client = (): GeyserClient => ({
    connect: async () => undefined,
    subscribeReplayInfo: async () => ({}),
    subscribe: async (request?: SubscribeRequest) => {
      if (request) requests.push(request);
      let destroyed = false;
      let release: (() => void) | undefined;
      const iterable = {
        async *[Symbol.asyncIterator]() {
          for (const update of updates) yield update;
          await new Promise<void>((resolve) => {
            release = resolve;
            if (destroyed) resolve();
          });
        },
        destroy: () => {
          destroyed = true;
          release?.();
        },
      };
      return iterable;
    },
  });
  return { client, requests };
}

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('GrpcRealtimeSource', () => {
  it("delivers the watched pools' transactions with the transaction itself, and resubscribes for new pools", async () => {
    const buy = { transaction: rehearsalGrpcUpdate('dbc-buy') } as SubscribeUpdate;
    // An update stamped by the node 2.4 s before it arrived.
    const sell = { transaction: rehearsalGrpcUpdate('dbc-sell'), createdAt: new Date(NOW - 2_400) } as SubscribeUpdate;
    const ping = { ping: {} } as SubscribeUpdate;
    const geyser = fakeGeyser([ping, buy, sell]);
    const source = new GrpcRealtimeSource([{ name: 'solami', url: 'https://grpc.example', token: 'x' }], {
      createClient: geyser.client,
      now: () => NOW,
    });
    const seen: RealtimeTransaction[] = [];
    const health: boolean[] = [];
    source.start(
      (tx) => seen.push(tx),
      (healthy) => health.push(healthy),
    );
    // Nothing to watch yet: no subscription (an empty filter would be a firehose).
    await flush();
    expect(geyser.requests).toHaveLength(0);
    source.watch([DBC_POOL]);
    await flush();
    expect(geyser.requests[0].transactions.launch.accountInclude).toEqual([DBC_POOL]);
    expect(source.healthy()).toBe(true);
    expect(health).toEqual([true]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      signature: rehearsalTx('dbc-buy').signature,
      slot: rehearsalTx('dbc-buy').slot,
      pools: [DBC_POOL],
      failed: false,
      receivedAt: NOW,
    });
    // No block time on gRPC: the node's creation time when the update has one, else the arrival time.
    expect(normalizeTransaction(seen[0].raw).blockTime).toBe(Math.floor(NOW / 1000));
    expect(normalizeTransaction(seen[1].raw).blockTime).toBe(Math.floor((NOW - 2_400) / 1000));
    // The same pools: no new subscription. A graduation adds the DAMM v2 pool: one new subscription with both.
    source.watch([DBC_POOL]);
    source.watch([DAMM_POOL, DBC_POOL]);
    await flush();
    expect(geyser.requests.map((request) => request.transactions.launch.accountInclude)).toEqual([
      [DBC_POOL],
      [DAMM_POOL, DBC_POOL].sort(),
    ]);
    source.stop();
    expect(source.healthy()).toBe(false);
  });
});

/** The websocket API of a web3.js Connection, driven by hand. */
class FakeLogs implements LogsConnection {
  readonly logs = new Map<number, { pool: string; callback: (logs: Logs, context: Context) => void }>();
  readonly removed: number[] = [];
  slot?: (slot: SlotInfo) => void;
  private next = 1;

  onLogs(filter: PublicKey, callback: (logs: Logs, context: Context) => void): number {
    const id = this.next++;
    this.logs.set(id, { pool: filter.toBase58(), callback });
    return id;
  }

  async removeOnLogsListener(id: number): Promise<void> {
    this.logs.delete(id);
    this.removed.push(id);
  }

  onSlotChange(callback: (slot: SlotInfo) => void): number {
    this.slot = callback;
    return 99;
  }

  async removeSlotChangeListener(): Promise<void> {
    this.slot = undefined;
  }

  emit(pool: string, signature: string, err: unknown = null, slot = 5_000): void {
    for (const sub of this.logs.values()) {
      if (sub.pool === pool) sub.callback({ signature, err, logs: [] } as Logs, { slot });
    }
  }
}

describe('WebsocketRealtimeSource', () => {
  it('subscribes each pool, delivers signatures to fetch, and is healthy while slots keep coming', () => {
    let clock = NOW;
    const connection = new FakeLogs();
    const source = new WebsocketRealtimeSource(connection, { heartbeatMs: 15_000, now: () => clock });
    const seen: RealtimeTransaction[] = [];
    const health: boolean[] = [];
    source.watch([DBC_POOL]);
    source.start(
      (tx) => seen.push(tx),
      (healthy) => health.push(healthy),
    );
    expect([...connection.logs.values()].map((sub) => sub.pool)).toEqual([DBC_POOL]);
    // Subscribed, but no slot yet: not known to be alive.
    expect(source.healthy()).toBe(false);
    connection.slot?.({ slot: 5_000, parent: 4_999, root: 4_968 });
    expect(source.healthy()).toBe(true);
    connection.emit(DBC_POOL, 'sig-a');
    connection.emit(DBC_POOL, 'sig-failed', { InstructionError: [2, { Custom: 6001 }] });
    expect(seen).toEqual([
      { signature: 'sig-a', slot: 5_000, pools: [DBC_POOL], failed: false, raw: null, receivedAt: NOW },
      { signature: 'sig-failed', slot: 5_000, pools: [DBC_POOL], failed: true, raw: null, receivedAt: NOW },
    ]);
    // The graduation: the DAMM v2 pool is added; dropping the curve unsubscribes it.
    source.watch([DBC_POOL, DAMM_POOL]);
    source.watch([DAMM_POOL]);
    expect([...connection.logs.values()].map((sub) => sub.pool)).toEqual([DAMM_POOL]);
    expect(connection.removed).toEqual([1]);
    // No slot for longer than the heartbeat: down.
    clock += 16_000;
    expect(source.healthy()).toBe(false);
    source.stop();
    expect(connection.logs.size).toBe(0);
    expect(health).toEqual([true, false]);
  });
});

describe('launchRealtimeSource (LAUNCH_REALTIME)', () => {
  const mainnet = { LAUNCH_CLUSTER: 'mainnet' as const, LAUNCH_RPC_URL: 'https://rpc.example' };
  const devnet = { LAUNCH_CLUSTER: 'devnet' as const, LAUNCH_RPC_URL: 'http://127.0.0.1:8899' };
  const key = { SOLAMI_TOKEN: 'x' };
  const mode = (
    setting: 'auto' | 'grpc' | 'websocket' | 'off',
    launch: typeof mainnet | typeof devnet,
    env: Record<string, string>,
  ) => launchRealtimeSource({ LAUNCH_REALTIME: setting, LAUNCH_RPC_WS_URL: undefined }, launch, env)?.mode ?? null;

  it('streams gRPC for a mainnet launch with a Solami key, else the websocket; off is polling only', () => {
    expect(mode('auto', mainnet, key)).toBe('grpc');
    expect(mode('grpc', mainnet, key)).toBe('grpc');
    expect(mode('auto', mainnet, {})).toBe('websocket');
    // Solami streams mainnet: a devnet launch (or a local stand-in) uses the websocket, even when gRPC is asked for.
    expect(mode('auto', devnet, key)).toBe('websocket');
    expect(mode('grpc', devnet, key)).toBe('websocket');
    expect(mode('websocket', mainnet, key)).toBe('websocket');
    expect(mode('off', mainnet, key)).toBeNull();
  });
});
