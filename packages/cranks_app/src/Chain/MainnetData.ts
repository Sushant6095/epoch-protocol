import { retry } from '@epoch/common';
import { ChainException } from '@epoch/exceptions';
import { type ConnectionManager, parseVoteState, type VoteState } from '@epoch/solana';
import { type PublicKey, type VoteAccountInfo } from '@solana/web3.js';

/** The data cluster's vote accounts (getVoteAccounts) and its current epoch. */
export interface VoterSnapshot {
  epoch: number;
  current: VoteAccountInfo[];
  delinquent: VoteAccountInfo[];
}

/** What the scorer reads about validators: DATA_RPC_URL (mainnet) and Jito Kobe. */
export interface ValidatorDataSource {
  voters(): Promise<VoterSnapshot>;
  /** Parsed vote accounts on the data cluster; null for one that is missing or unreadable. */
  voteStates(votes: PublicKey[]): Promise<Map<string, VoteState | null>>;
  /** Jito MEV commission per vote account (bps); null when the validator does not run Jito. */
  mevCommissions(): Promise<Map<string, number | null>>;
}

interface KobeValidator {
  vote_account: string;
  mev_commission_bps: number | null;
  running_jito: boolean;
}

/** getMultipleAccounts takes at most 100 keys. */
const MULTIPLE_ACCOUNTS_LIMIT = 100;

export class MainnetData implements ValidatorDataSource {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly kobeUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async voters(): Promise<VoterSnapshot> {
    const [info, accounts] = await Promise.all([
      this.connections.withFailover((c) => c.getEpochInfo('confirmed')),
      this.connections.withFailover((c) => c.getVoteAccounts('confirmed')),
    ]);
    return { epoch: info.epoch, current: accounts.current, delinquent: accounts.delinquent };
  }

  async voteStates(votes: PublicKey[]): Promise<Map<string, VoteState | null>> {
    const out = new Map<string, VoteState | null>();
    for (let i = 0; i < votes.length; i += MULTIPLE_ACCOUNTS_LIMIT) {
      const chunk = votes.slice(i, i + MULTIPLE_ACCOUNTS_LIMIT);
      const infos = await this.connections.withFailover((c) => c.getMultipleAccountsInfo(chunk, 'confirmed'));
      chunk.forEach((vote, index) => {
        const info = infos[index];
        let state: VoteState | null = null;
        try {
          state = info ? parseVoteState(info.data) : null;
        } catch {
          state = null;
        }
        out.set(vote.toBase58(), state);
      });
    }
    return out;
  }

  async mevCommissions(): Promise<Map<string, number | null>> {
    const url = `${this.kobeUrl.replace(/\/$/, '')}/api/v1/validators`;
    const body = await retry(
      async () => {
        const res = await this.fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new ChainException(`Jito Kobe answered HTTP ${res.status}`);
        return (await res.json()) as { validators?: KobeValidator[] };
      },
      { retries: 2, baseDelayMs: 1_000 },
    );
    if (!Array.isArray(body.validators)) throw new ChainException('Jito Kobe returned no validator list');
    return new Map(
      body.validators.map((v) => [
        v.vote_account,
        v.running_jito === false || typeof v.mev_commission_bps !== 'number' ? null : v.mev_commission_bps,
      ]),
    );
  }
}
