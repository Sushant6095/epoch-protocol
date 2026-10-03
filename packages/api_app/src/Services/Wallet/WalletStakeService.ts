import { KeyedSnapshotCache } from '../../Lib/KeyedSnapshotCache';
import { isoIst } from '../../Lib/Stats';
import { type SolanaDataSource } from '../../Sources/SolanaDataSource';
import { type MyStake } from '../../types/Wallet.types';
import { type ScanSnapshot } from '../DelegatorScanService';
import { type InflationRewards } from '../InflationRewards';
import { type MarketData, optional } from '../MarketData';
import { type ValidatorTable } from '../ValidatorTable';
import { buildMyStake, REWARD_EPOCHS, rewardAccounts, type VoteStanding } from './WalletStakeBuilder';

const WALLET_TTL_MS = 60_000;
const WALLETS_KEPT = 500;

/**
 * GET /v1/wallets/:address/stake — a wallet's stake accounts (staker or withdrawer), its idle SOL, rewards for the last
 * five finished epochs, health from the validator table and three healthier validators. Kept 60 seconds per wallet.
 */
export class WalletStakeService {
  private readonly wallets: KeyedSnapshotCache<MyStake>;

  constructor(
    private readonly market: MarketData,
    private readonly solana: SolanaDataSource,
    private readonly table: ValidatorTable,
    private readonly rewards: InflationRewards,
    private readonly scan: () => ScanSnapshot | undefined,
  ) {
    this.wallets = new KeyedSnapshotCache(
      'walletStake',
      WALLETS_KEPT,
      WALLET_TTL_MS,
      (wallet) => this.build(wallet),
      2 * WALLET_TTL_MS,
    );
  }

  get(wallet: string): Promise<MyStake> {
    return this.wallets.get(wallet);
  }

  private async build(wallet: string): Promise<MyStake> {
    const [t, accounts, balance, voteAccounts] = await Promise.all([
      this.table.get(),
      this.solana.getStakeAccountsByAuthority(wallet),
      this.solana.getBalance(wallet),
      this.market.voteAccounts.get(),
    ]);
    const stakewiz = await optional(this.market.stakewiz, new Map());
    const epoch = t.epoch.epoch;
    const rewardEpochs = Array.from({ length: REWARD_EPOCHS }, (_, i) => epoch - REWARD_EPOCHS + i);
    const toRead = rewardAccounts(accounts);
    // All five epochs at once: on the public RPC one call for stake accounts takes 5–9 s.
    const rewards =
      toRead.length > 0
        ? await this.rewards.getEpochs(toRead, rewardEpochs, epoch, REWARD_EPOCHS)
        : new Map(rewardEpochs.map((e) => [e, new Map<string, number | null>()]));

    const current = new Set(voteAccounts.current.map((v) => v.votePubkey));
    const delinquent = new Set(voteAccounts.delinquent.map((v) => v.votePubkey));
    const standing = (vote: string): VoteStanding =>
      current.has(vote) ? 'current' : delinquent.has(vote) ? 'delinquent' : 'missing';

    const { body, notes } = buildMyStake({
      wallet,
      epoch,
      epochsPerYear: t.epochsPerYear,
      hoursPerEpoch: t.hoursPerEpoch,
      balanceLamports: balance,
      accounts,
      rows: t.rows,
      standing,
      stakewiz,
      rewards,
      rewardEpochs,
      scanReady: this.scan() !== undefined,
    });
    const sources = ['Solana mainnet RPC (stake accounts, balance, getInflationReward)'];
    if (stakewiz.size > 0) sources.push('Stakewiz');
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(),
      source: [...sources, ...t.sources.filter((s) => s !== 'Solana mainnet RPC' && s !== 'Stakewiz')].join(', '),
      note: notes.join('; '),
      ...body,
    };
  }
}
