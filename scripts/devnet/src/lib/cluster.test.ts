import { clusterOfGenesis, explorerUrl, GENESIS, resolveCluster, wsUrlFor } from './cluster';
import { KitError } from './errors';

describe('resolveCluster', () => {
  it('maps the monikers and their aliases', () => {
    expect(resolveCluster('devnet')).toEqual({
      name: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      wsUrl: 'wss://api.devnet.solana.com',
    });
    expect(resolveCluster('t').name).toBe('testnet');
    expect(resolveCluster('localhost').rpcUrl).toBe('http://127.0.0.1:8899');
  });

  it('refuses mainnet in every spelling', () => {
    for (const url of ['m', 'mainnet', 'mainnet-beta', 'https://api.mainnet-beta.solana.com', 'MAINNET']) {
      expect(() => resolveCluster(url)).toThrow(KitError);
    }
  });

  it('treats a loopback URL as localnet with the websocket on port + 1', () => {
    expect(resolveCluster('http://127.0.0.1:48899/')).toEqual({
      name: 'localnet',
      rpcUrl: 'http://127.0.0.1:48899',
      wsUrl: 'ws://127.0.0.1:48900',
    });
  });

  it('keeps a provider URL custom and honours an explicit --ws', () => {
    const t = resolveCluster('https://devnet.example.com/key', 'wss://ws.example.com');
    expect(t).toEqual({ name: 'custom', rpcUrl: 'https://devnet.example.com/key', wsUrl: 'wss://ws.example.com' });
  });

  it('rejects other schemes and garbage', () => {
    expect(() => resolveCluster('ftp://x')).toThrow(/http/);
    expect(() => resolveCluster('not a url')).toThrow(/devnet, testnet, localnet/);
  });
});

describe('wsUrlFor', () => {
  it('swaps the scheme and keeps remote ports', () => {
    expect(wsUrlFor('https://rpc.example.com:8443/x')).toBe('wss://rpc.example.com:8443/x');
    expect(wsUrlFor('http://localhost:18899')).toBe('ws://localhost:18900');
  });
});

describe('clusterOfGenesis', () => {
  it('names public clusters by genesis hash', () => {
    expect(clusterOfGenesis(GENESIS.devnet, 'custom')).toBe('devnet');
    expect(clusterOfGenesis(GENESIS.testnet, 'custom')).toBe('testnet');
    expect(clusterOfGenesis('abc', 'localnet')).toBe('localnet');
    expect(clusterOfGenesis('abc', 'devnet')).toBe('custom');
  });
});

describe('explorerUrl', () => {
  it('links public clusters by name and others by custom URL', () => {
    expect(explorerUrl('tx', 'SIG', { name: 'devnet', rpcUrl: '' })).toBe(
      'https://explorer.solana.com/tx/SIG?cluster=devnet',
    );
    expect(explorerUrl('address', 'K', { name: 'localnet', rpcUrl: 'http://127.0.0.1:48899' })).toBe(
      'https://explorer.solana.com/address/K?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A48899',
    );
  });
});
