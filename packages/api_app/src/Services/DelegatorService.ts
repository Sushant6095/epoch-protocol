import { EpochException } from '@epoch/exceptions';

import { round } from '../Lib/Stats';
import { type BiggestDelegators, type RetailMagnets } from '../types/Api.types';
import { keyBase58, type DelegatorLabels } from './DelegatorLabels';
import { type DelegatorScanService, type ScanSnapshot } from './DelegatorScanService';
import { type ValidatorTable } from './ValidatorTable';

const SOURCE = 'Solana mainnet RPC: every delegated stake account, grouped by withdraw authority';

export class DelegatorService {
  constructor(
    private readonly scan: DelegatorScanService,
    private readonly labels: DelegatorLabels,
    private readonly table: ValidatorTable,
  ) {}

  /** GET /v1/delegators/biggest — the largest owners of stake, named where we know them. */
  async biggest(limit: number): Promise<BiggestDelegators> {
    const snapshot = this.ready();
    const entities = new Map<
      string,
      { name: string; kind: string; address: string | null; stakeSol: number; validators: number }
    >();
    for (const owner of snapshot.topOwners) {
      const label = await this.labels.resolve(owner.key);
      const address = label?.address ?? keyBase58(owner.key);
      const entityKey = label?.entity ?? address;
      const existing = entities.get(entityKey);
      if (existing) {
        existing.stakeSol += owner.stakeSol;
        existing.validators = Math.max(existing.validators, owner.validators);
        existing.address = null;
      } else {
        entities.set(entityKey, {
          name: label?.name ?? `${address.slice(0, 4)}…${address.slice(-4)}`,
          kind: label?.kind ?? 'Wallet',
          address,
          stakeSol: owner.stakeSol,
          validators: owner.validators,
        });
      }
    }
    const rows = [...entities.values()]
      .sort((a, b) => b.stakeSol - a.stakeSol)
      .slice(0, limit)
      .map((e) => ({ ...e, stakeSol: Math.round(e.stakeSol) }));
    return { schemaVersion: 1, kind: 'real', asOf: snapshot.asOf, source: SOURCE, rows };
  }

  /** GET /v1/delegators/retail-magnets — validators with the most small wallets (under 1,000 SOL in total). */
  async retailMagnets(limit: number): Promise<RetailMagnets> {
    const snapshot = this.ready();
    const table = await this.table.get();
    const names = new Map(table.rows.map((r) => [r.vote, r.name]));
    const rows = [...snapshot.perVote.entries()]
      .map(([vote, stats]) => ({
        name: names.get(vote) ?? `${vote.slice(0, 4)}…${vote.slice(-4)}`,
        wallets: stats.retailWallets,
        vote,
      }))
      .sort((a, b) => b.wallets - a.wallets)
      .slice(0, limit);
    const retail = snapshot.network.retail;
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: snapshot.asOf,
      source: SOURCE,
      note: `${retail.wallets.toLocaleString('en-US')} retail wallets hold ${round(retail.sharePct, 1)}% of stake; scan of ${snapshot.stakeAccounts.toLocaleString('en-US')} stake accounts`,
      rows,
    };
  }

  private ready(): ScanSnapshot {
    const snapshot = this.scan.latest;
    if (!snapshot) {
      const status = this.scan.status;
      throw new EpochException('The delegator scan has not finished yet', 'NOT_READY', 503, {
        running: status.running,
        votesDone: status.votesDone,
        votesTotal: status.votesTotal,
        lastError: status.lastError,
      });
    }
    return snapshot;
  }
}
