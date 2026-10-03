import { readFileSync } from 'fs';

import { Logger } from '@epoch/logger';
import { addressToBytes, bytesToAddress, findProgramAddress } from '@epoch/solana';

import { type TokenSource } from '../Sources/ExternalSources';
import { type SolanaDataSource } from '../Sources/SolanaDataSource';

const logger = Logger.create('DelegatorLabels');

export interface DelegatorLabel {
  name: string;
  /** `Liquid staking`, `Foundation`, `Exchange`, `Fund`… */
  kind: string;
  /** Labels sharing an entity are summed into one row (e.g. several Foundation wallets). */
  entity: string;
  /** Base58 address, for the explorer link. */
  address: string;
}

interface LabelFileRow {
  address: string;
  name: string;
  kind?: string;
  entity?: string;
}

/** Base64 of a base58 key's 32 bytes: the form the stake scan uses. */
export const keyBase64 = (address: string): string => addressToBytes(address).toString('base64');
export const keyBase58 = (base64: string): string => bytesToAddress(Buffer.from(base64, 'base64'));

/**
 * Names for delegator wallets: a hand-kept JSON file (Foundation, exchanges…) plus every SPL stake pool on
 * the configured programs, found on-chain and named by its token symbol (JitoSOL, jupSOL…).
 */
export class DelegatorLabels {
  private readonly labels = new Map<string, DelegatorLabel>();
  /** stake-pool withdraw authority (base64) → pool mint (base58), named lazily. */
  private readonly poolMints = new Map<string, string>();

  constructor(
    private readonly solana: SolanaDataSource,
    private readonly tokens: TokenSource,
    private readonly labelsPath: string | undefined,
    private readonly stakePoolPrograms: string[],
  ) {}

  async load(): Promise<void> {
    this.loadFile();
    for (const programId of this.stakePoolPrograms) {
      try {
        const pools = await this.solana.getStakePools(programId);
        for (const { pool, mint } of pools) {
          const authority = findProgramAddress([addressToBytes(pool), Buffer.from('withdraw')], programId);
          this.poolMints.set(keyBase64(authority), bytesToAddress(mint));
        }
        logger.info('stake pools loaded', { programId, pools: pools.length });
      } catch (error) {
        logger.warn('could not load stake pools', { programId, error: String(error) });
      }
    }
  }

  /** The label for an owner key (base64), naming stake pools on first use. */
  async resolve(key: string): Promise<DelegatorLabel | undefined> {
    const known = this.labels.get(key);
    if (known) return known;
    const mint = this.poolMints.get(key);
    if (!mint) return undefined;
    const symbol = await this.tokens.symbol(mint);
    const label: DelegatorLabel = {
      name: symbol ? `${symbol} pool` : `Stake pool ${mint.slice(0, 4)}…${mint.slice(-4)}`,
      kind: 'Liquid staking',
      entity: `pool:${mint}`,
      address: keyBase58(key),
    };
    // A failed lookup (undefined) is not cached, so the pool gets its name on a later request.
    if (symbol !== undefined) this.labels.set(key, label);
    return label;
  }

  /** Names the given owners ahead of the first request, one lookup at a time. */
  async warm(keys: readonly string[]): Promise<void> {
    let unnamedPools = 0;
    for (const key of keys) {
      const label = await this.resolve(key);
      if (label && !this.labels.has(key)) unnamedPools += 1;
    }
    if (unnamedPools > 0) logger.warn('some stake pools could not be named yet', { unnamedPools });
  }

  private loadFile(): void {
    if (!this.labelsPath) return;
    try {
      const rows = JSON.parse(readFileSync(this.labelsPath, 'utf8')) as LabelFileRow[];
      for (const row of rows) {
        this.labels.set(keyBase64(row.address), {
          name: row.name,
          kind: row.kind ?? 'Wallet',
          entity: row.entity ?? row.address,
          address: row.address,
        });
      }
      logger.info('delegator labels loaded', { count: rows.length });
    } catch (error) {
      logger.warn('could not read DELEGATOR_LABELS_PATH', { error: String(error) });
    }
  }
}
