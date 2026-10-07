import { sleep } from '@epoch/common';
import { Logger } from '@epoch/logger';
import {
  claimStatusAddress,
  type DistributionAccount,
  type DistributionKind,
  distributionAccountFilters,
  estimatedValidatorShare,
  JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
  JITO_TIP_DISTRIBUTION_PROGRAM_ID,
  parsePriorityFeeClaimStatus,
  parsePriorityFeeDistributionAccount,
  parseTipClaimStatus,
  parseTipDistributionAccount,
  TIP_DISTRIBUTION_ACCOUNT_SIZE,
  type TipClaimStatus,
} from '@epoch/solana';

import { type KnownClaim, type MevEpochRow, type MevRepository } from '../Repositories/MevRepository';
import { MAX_MULTIPLE_ACCOUNTS, type SolanaRpc } from '../Rpc/SolanaRpc';

const logger = Logger.create('MevScanner');

export type MevScanRpc = Pick<
  SolanaRpc,
  'getEpochInfo' | 'getProgramAccounts' | 'getMultipleAccounts' | 'getMinimumBalanceForRentExemption'
>;

export interface MevScannerOptions {
  /** Minutes between scans. */
  intervalMinutes: number;
  /** Epochs kept current: the epoch in progress and the `backfillEpochs - 1` before it. */
  backfillEpochs: number;
  /** Pause between RPC calls. */
  spacingMs: number;
  sleepFn?: (ms: number) => Promise<void>;
}

interface Located {
  address: string;
  lamports: number;
  account: DistributionAccount;
}

export interface MevEpochScan {
  epoch: number;
  tdas: number;
  pfdas: number;
  claimsRead: number;
  /** Accounts the filters returned that did not decode (layout drift): counted, logged, skipped. */
  undecoded: number;
}

export interface MevScanResult {
  currentEpoch: number;
  rentLamports: number;
  scanned: MevEpochScan[];
  skipped: number[];
  expired: number;
}

/**
 * Jito MEV per validator per mainnet epoch, cached in validator_mev_epochs for the API (`mevCommissionPct`,
 * `mevTipsSol`, the MEV history, MEV per position). Per epoch: the TipDistributionAccounts and the
 * PriorityFeeDistributionAccounts in bulk (getProgramAccounts filtered by epoch, two calls each because Borsh's
 * Option moves the epoch by 64 bytes once the merkle root is up), then the ClaimStatus of each validator's commission
 * node (claimant = the vote account) through getMultipleAccounts, skipping nodes already known claimed. An epoch whose
 * roots are all uploaded and whose commission nodes are all settled is not read again. For an epoch without a root the
 * tips so far are the TDA balance minus its rent-exempt minimum, read from the RPC (1,503,680 lamports in Oct 2026).
 */
export class MevScanner {
  private stopped = false;
  private wake: (() => void) | null = null;
  private lastCall = 0;

  constructor(
    private readonly rpc: MevScanRpc,
    private readonly repo: MevRepository,
    private readonly options: MevScannerOptions,
  ) {}

  /** Scans now, then every `intervalMinutes`, until stop(). A failed scan keeps the last rows and is logged once. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const result = await this.scanOnce();
        logger.info('MEV scan done', {
          currentEpoch: result.currentEpoch,
          scanned: result.scanned.map((s) => `${s.epoch}: ${s.tdas} TDAs, ${s.pfdas} PFDAs, ${s.claimsRead} claims`),
          skipped: result.skipped.length,
          expired: result.expired,
        });
      } catch (error) {
        logger.warn('MEV scan failed; keeping the last rows', { error: String((error as Error).message ?? error) });
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.intervalMinutes * 60_000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  async scanOnce(): Promise<MevScanResult> {
    const { epoch: currentEpoch } = await this.call(() => this.rpc.getEpochInfo());
    const epochs: number[] = [];
    for (let e = currentEpoch; e > currentEpoch - this.options.backfillEpochs && e >= 0; e--) epochs.push(e);
    const settled = await this.repo.settledEpochs(epochs.filter((e) => e < currentEpoch));
    const rentLamports = await this.call(() =>
      this.rpc.getMinimumBalanceForRentExemption(TIP_DISTRIBUTION_ACCOUNT_SIZE),
    );
    const scanned: MevEpochScan[] = [];
    for (const epoch of epochs) {
      if (settled.has(epoch)) continue;
      scanned.push(await this.scanEpoch(epoch, currentEpoch, BigInt(rentLamports)));
    }
    const expired = await this.repo.expirePending(currentEpoch);
    return { currentEpoch, rentLamports, scanned, skipped: epochs.filter((e) => settled.has(e)), expired };
  }

  /** Reads one epoch's TDAs, PFDAs and pending commission-node claims, and writes its rows. */
  async scanEpoch(epoch: number, currentEpoch: number, rentLamports: bigint): Promise<MevEpochScan> {
    const tip = await this.distributionAccounts('tip', epoch);
    const pf = await this.distributionAccounts('priority-fee', epoch);
    const known = await this.repo.claimedNodes(epoch);
    const toRead = tip.accounts.filter(
      (t) =>
        t.account.merkleRoot !== null &&
        t.account.validatorCommissionBps > 0 &&
        !known.has(t.account.validatorVoteAccount),
    );
    const claims = await this.readClaims(toRead);
    // PFDA validator nodes above 0 (rare): a ClaimStatus under the PF program means claimed.
    const pfToRead = pf.accounts.filter((p) => pfNode(p.account) > 0n);
    const pfClaimed = await this.readPfClaims(pfToRead);

    const byVote = new Map<string, { tda?: Located; pfda?: Located }>();
    for (const t of tip.accounts) byVote.set(t.account.validatorVoteAccount, { tda: t });
    for (const p of pf.accounts) {
      const entry = byVote.get(p.account.validatorVoteAccount) ?? {};
      entry.pfda = p;
      byVote.set(p.account.validatorVoteAccount, entry);
    }
    const rows: MevEpochRow[] = [...byVote.entries()].map(([vote, { tda, pfda }]) =>
      mevRow(
        vote,
        epoch,
        currentEpoch,
        rentLamports,
        tda,
        pfda,
        claims.get(vote),
        known.get(vote),
        pfClaimed.has(vote),
      ),
    );
    await this.repo.upsert(rows);
    return {
      epoch,
      tdas: tip.accounts.length,
      pfdas: pf.accounts.length,
      claimsRead: toRead.length + pfToRead.length,
      undecoded: tip.undecoded + pf.undecoded,
    };
  }

  private async distributionAccounts(
    kind: DistributionKind,
    epoch: number,
  ): Promise<{ accounts: Located[]; undecoded: number }> {
    const programId = kind === 'tip' ? JITO_TIP_DISTRIBUTION_PROGRAM_ID : JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID;
    const parse = kind === 'tip' ? parseTipDistributionAccount : parsePriorityFeeDistributionAccount;
    const accounts: Located[] = [];
    let undecoded = 0;
    for (const rootUploaded of [true, false]) {
      const found = await this.call(() =>
        this.rpc.getProgramAccounts(programId, distributionAccountFilters(kind, epoch, rootUploaded)),
      );
      for (const raw of found) {
        const account = parse(raw.data);
        if (!account || account.epochCreatedAt !== BigInt(epoch)) {
          undecoded++;
          continue;
        }
        accounts.push({ address: raw.pubkey, lamports: raw.lamports, account });
      }
    }
    if (undecoded > 0) logger.warn('distribution accounts that did not decode', { kind, epoch, undecoded });
    return { accounts, undecoded };
  }

  private async readClaims(tdas: Located[]): Promise<Map<string, TipClaimStatus>> {
    const claims = new Map<string, TipClaimStatus>();
    for (let i = 0; i < tdas.length; i += MAX_MULTIPLE_ACCOUNTS) {
      const chunk = tdas.slice(i, i + MAX_MULTIPLE_ACCOUNTS);
      const addresses = chunk.map((t) => claimStatusAddress(t.account.validatorVoteAccount, t.address));
      const infos = await this.call(() => this.rpc.getMultipleAccounts(addresses));
      infos.forEach((info, j) => {
        const status = info ? parseTipClaimStatus(info.data) : null;
        if (status?.isClaimed) claims.set(chunk[j].account.validatorVoteAccount, status);
      });
    }
    return claims;
  }

  private async readPfClaims(pfdas: Located[]): Promise<Set<string>> {
    const claimed = new Set<string>();
    for (let i = 0; i < pfdas.length; i += MAX_MULTIPLE_ACCOUNTS) {
      const chunk = pfdas.slice(i, i + MAX_MULTIPLE_ACCOUNTS);
      const addresses = chunk.map((p) =>
        claimStatusAddress(p.account.validatorVoteAccount, p.address, JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID),
      );
      const infos = await this.call(() => this.rpc.getMultipleAccounts(addresses));
      infos.forEach((info, j) => {
        if (info && parsePriorityFeeClaimStatus(info.data)) claimed.add(chunk[j].account.validatorVoteAccount);
      });
    }
    return claimed;
  }

  /** Spaces RPC calls `spacingMs` apart (public RPC rate limits). */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    const wait = this.lastCall + this.options.spacingMs - Date.now();
    if (wait > 0) await (this.options.sleepFn ?? sleep)(wait);
    try {
      return await fn();
    } finally {
      this.lastCall = Date.now();
    }
  }
}

/**
 * One validator's row for one epoch. Tips: the root's max_total_claim once uploaded, else the TDA balance less rent
 * (tips so far). The commission node: claimed (ClaimStatus amount, now or from an earlier scan), pending (commission > 0,
 * not claimed yet), none (0 % commission: the node is 0 and is never claimed), expired (the TDA closed unclaimed).
 */
export function mevRow(
  vote: string,
  epoch: number,
  currentEpoch: number,
  rentLamports: bigint,
  tda: Located | undefined,
  pfda: Located | undefined,
  claim: TipClaimStatus | undefined,
  known: KnownClaim | undefined,
  pfClaimed = false,
): MevEpochRow {
  const t = tda?.account;
  const root = t?.merkleRoot ?? null;
  const tdaLamports = tda ? BigInt(tda.lamports) : null;
  const tips = root ? root.maxTotalClaim : tdaLamports !== null ? maxBig(0n, tdaLamports - rentLamports) : null;
  const bps = t?.validatorCommissionBps ?? null;
  let validatorClaim: string | null = null;
  let share: bigint | null = null;
  let estimated: boolean | null = null;
  let claimedSlot: number | null = null;
  if (t && bps !== null && tips !== null) {
    if (bps === 0) {
      validatorClaim = 'none';
      share = 0n;
      estimated = false;
    } else if (claim) {
      validatorClaim = 'claimed';
      share = claim.amount;
      estimated = false;
      claimedSlot = Number(claim.slotClaimedAt);
    } else if (known) {
      validatorClaim = 'claimed';
      share = known.amount;
      estimated = false;
      claimedSlot = known.slot;
    } else {
      validatorClaim = BigInt(currentEpoch) > t.expiresAt ? 'expired' : 'pending';
      share = estimatedValidatorShare(tips, bps);
      estimated = true;
    }
  }
  const p = pfda?.account;
  return {
    vote,
    epoch,
    tda: tda?.address ?? null,
    mevCommissionBps: bps,
    tipsLamports: tips,
    tdaLamports,
    rootUploaded: t ? root !== null : null,
    totalFundsClaimedLamports: root?.totalFundsClaimed ?? null,
    nodesClaimed: root ? Number(root.numNodesClaimed) : null,
    maxNodes: root ? Number(root.maxNumNodes) : null,
    validatorShareLamports: share,
    validatorShareEstimated: estimated,
    validatorClaim,
    validatorClaimedSlot: claimedSlot,
    expiresAt: t ? Number(t.expiresAt) : null,
    uploadAuthority: t?.merkleRootUploadAuthority ?? null,
    pfda: pfda?.address ?? null,
    pfCommissionBps: p?.validatorCommissionBps ?? null,
    pfTransferredLamports: p?.totalLamportsTransferred ?? null,
    pfTotalClaimLamports: p?.merkleRoot?.maxTotalClaim ?? null,
    pfRootUploaded: p ? p.merkleRoot !== null : null,
    // A 0 node (0 % commission, or nothing shared) is never claimed; before the root the node is not known yet.
    pfValidatorClaim: !p
      ? null
      : p.validatorCommissionBps === 0 || (p.merkleRoot !== null && pfNode(p) === 0n)
        ? 'none'
        : pfClaimed
          ? 'claimed'
          : 'pending',
  };
}

/** The PFDA's validator node: ⌊total × bps ÷ 10,000⌋ once the root is up, else 0 (nothing to claim yet). */
function pfNode(p: DistributionAccount): bigint {
  return p.merkleRoot ? estimatedValidatorShare(p.merkleRoot.maxTotalClaim, p.validatorCommissionBps) : 0n;
}

const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
