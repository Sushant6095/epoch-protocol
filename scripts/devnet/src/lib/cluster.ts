/**
 * Which cluster a command talks to. `--url` takes a moniker (devnet, testnet, localnet) or an http(s) URL; mainnet is
 * refused by name and, after connecting, by genesis hash, so no kit command can ever send a mainnet transaction.
 */
import { Connection, type Commitment } from '@solana/web3.js';

import { KitError } from './errors';

/** Genesis hashes of the public clusters (stable for the cluster's lifetime). */
export const GENESIS = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
} as const;

export type ClusterName = 'devnet' | 'testnet' | 'localnet' | 'custom';

export interface ClusterTarget {
  name: ClusterName;
  rpcUrl: string;
  wsUrl: string;
}

const MONIKERS: Record<string, { name: ClusterName; rpcUrl: string; wsUrl: string }> = {
  devnet: { name: 'devnet', rpcUrl: 'https://api.devnet.solana.com', wsUrl: 'wss://api.devnet.solana.com' },
  testnet: { name: 'testnet', rpcUrl: 'https://api.testnet.solana.com', wsUrl: 'wss://api.testnet.solana.com' },
  localnet: { name: 'localnet', rpcUrl: 'http://127.0.0.1:8899', wsUrl: 'ws://127.0.0.1:8900' },
};
const ALIASES: Record<string, string> = { d: 'devnet', t: 'testnet', l: 'localnet', localhost: 'localnet' };
const MAINNET_NAMES = new Set(['m', 'mainnet', 'mainnet-beta']);

const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

/**
 * The websocket URL for an RPC URL. `solana-test-validator` serves it on the RPC port + 1, so a loopback URL with an
 * explicit port gets port + 1; any other URL keeps its port and swaps the scheme only.
 */
export function wsUrlFor(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (isLoopback(url.hostname) && url.port) url.port = String(Number(url.port) + 1);
  return url.toString().replace(/\/$/, '');
}

/** Resolve `--url` (and an optional `--ws`) to a target. Throws for mainnet in any spelling. */
export function resolveCluster(url: string, ws?: string): ClusterTarget {
  const key = url.trim().toLowerCase();
  if (MAINNET_NAMES.has(key) || /mainnet/.test(key)) {
    throw new KitError('MAINNET_REFUSED', `refusing ${url}: the devnet kit never sends mainnet transactions`);
  }
  const moniker = MONIKERS[ALIASES[key] ?? key];
  if (moniker) return { ...moniker, wsUrl: ws ?? moniker.wsUrl };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new KitError('BAD_URL', `--url must be devnet, testnet, localnet or an http(s) URL, got ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new KitError('BAD_URL', `--url must be http(s), got ${parsed.protocol}`);
  }
  const rpcUrl = url.replace(/\/$/, '');
  return { name: isLoopback(parsed.hostname) ? 'localnet' : 'custom', rpcUrl, wsUrl: ws ?? wsUrlFor(rpcUrl) };
}

/** Name the cluster from its genesis hash (a custom URL may be a devnet or testnet RPC provider). */
export function clusterOfGenesis(genesisHash: string, fallback: ClusterName): ClusterName {
  if (genesisHash === GENESIS.devnet) return 'devnet';
  if (genesisHash === GENESIS.testnet) return 'testnet';
  return fallback === 'devnet' || fallback === 'testnet' ? 'custom' : fallback;
}

export interface Cluster extends ClusterTarget {
  connection: Connection;
  genesisHash: string;
}

/** Connect and check the genesis hash: mainnet's is refused, and a devnet/testnet moniker must match its cluster. */
export async function connect(target: ClusterTarget, commitment: Commitment = 'confirmed'): Promise<Cluster> {
  const connection = new Connection(target.rpcUrl, { commitment, wsEndpoint: target.wsUrl });
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash === GENESIS.mainnet) {
    throw new KitError('MAINNET_REFUSED', `${target.rpcUrl} is a mainnet RPC (genesis ${genesisHash}); refusing`);
  }
  if ((target.name === 'devnet' || target.name === 'testnet') && genesisHash !== GENESIS[target.name]) {
    throw new KitError('GENESIS_MISMATCH', `${target.rpcUrl} answered genesis ${genesisHash}, not ${target.name}'s`);
  }
  return { ...target, name: clusterOfGenesis(genesisHash, target.name), connection, genesisHash };
}

/** Explorer link for a transaction or an address on this cluster. */
export function explorerUrl(
  kind: 'tx' | 'address',
  id: string,
  target: Pick<ClusterTarget, 'name' | 'rpcUrl'>,
): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (target.name === 'devnet' || target.name === 'testnet') return `${base}?cluster=${target.name}`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(target.rpcUrl)}`;
}
