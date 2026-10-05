import {
  decodeRevenueToken,
  findBuybackEscrowPda,
  findPartnerTreasuryPda,
  findPoolPda,
  findRevenueTokenPda,
  type RevenueTokenAccount,
  revenueTokenBuybacksPaused,
  revenueTokenRedeemOpen,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { endEpochOf, type LaunchRegistryEntry } from '@epoch/meteora';
import { PublicKey } from '@solana/web3.js';

import { isoIst, LAMPORTS_PER_SOL } from '../../Lib/Stats';
import { type EpochProgramSource } from '../../Sources/EpochProgramSource';
import { type RevenueTokenInfo } from '../../types/LaunchPage.types';

const logger = Logger.create('RevenueTokenSource');

/**
 * A launch's revenue-token terms (ADR 0006, plan F13): the program's `RevenueToken` account at `["revenue_token", vote]`
 * when the validator's operator registered the token (`register_revenue_token`), decoded with `@epoch/epoch-sdk`, with
 * the buyback escrow's balance at `["buyback", vote]`, both read on the program's cluster. Falls back to the launch
 * record's terms when the program id is unset, the launch has no vote account, the token is not registered (or the
 * vote account registered another mint), or the read fails.
 */
export interface RevenueTokenSource {
  get(entry: LaunchRegistryEntry): Promise<RevenueTokenInfo>;
}

/** `["revenue_token", vote]` under the Epoch program. */
export const revenueTokenAddress = (programId: PublicKey, vote: PublicKey): PublicKey =>
  findRevenueTokenPda(programId, vote)[0];

/** `["buyback", vote]` under the Epoch program: the escrow every sweep pays the share into. */
export const buybackEscrowAddress = (programId: PublicKey, vote: PublicKey): PublicKey =>
  findBuybackEscrowPda(programId, vote)[0];

/** `["treasury", pool]`: Epoch's partner treasury, the DBC fee claimer and leftover receiver of every launch. */
export const partnerTreasuryAddress = (programId: PublicKey): PublicKey =>
  findPartnerTreasuryPda(programId, findPoolPda(programId)[0])[0];

/** The launch record's terms, with the program's PDAs when the program id and vote account are known. */
export function registryRevenueToken(
  entry: LaunchRegistryEntry,
  programId: PublicKey | null,
  note: string | null = null,
): RevenueTokenInfo {
  const vote = entry.validator.vote ? new PublicKey(entry.validator.vote) : null;
  return {
    source: 'registry',
    address: programId && vote ? revenueTokenAddress(programId, vote).toBase58() : (entry.revenueToken ?? null),
    buybackEscrow: entry.escrow ?? (programId && vote ? buybackEscrowAddress(programId, vote).toBase58() : null),
    treasury: programId ? partnerTreasuryAddress(programId).toBase58() : (entry.feeClaimer ?? null),
    registeredOnChain: null,
    shareBps: entry.shareBps,
    termEpochs: entry.termEpochs,
    startEpoch: entry.startEpoch,
    endEpoch: endEpochOf(entry.startEpoch, entry.termEpochs),
    registeredEpoch: entry.registeredEpoch ?? null,
    status: null,
    dammPool: entry.dammPool ?? null,
    operator: null,
    commissionFloorBps: null,
    escrow: null,
    buybacks: null,
    totals: null,
    note,
  };
}

/** The program's record of a registered token, with the escrow's balance above rent (pure). */
export function programRevenueToken(input: {
  rt: RevenueTokenAccount;
  address: PublicKey;
  escrow: PublicKey;
  treasury: PublicKey;
  escrowLamports: number;
  rentExemptLamports: number;
  epoch: number;
  decimals: number;
  readAt: Date;
}): RevenueTokenInfo {
  const { rt, decimals } = input;
  const sol = (lamports: bigint | number) => Number(lamports) / LAMPORTS_PER_SOL;
  const tokens = (raw: bigint) => Number(raw) / 10 ** decimals;
  return {
    source: 'program',
    address: input.address.toBase58(),
    buybackEscrow: input.escrow.toBase58(),
    treasury: input.treasury.toBase58(),
    registeredOnChain: true,
    shareBps: rt.shareBps,
    termEpochs: rt.termEpochs,
    startEpoch: Number(rt.startEpoch),
    // The program keeps the first epoch after the term; the contract's endEpoch is the last one bought back.
    endEpoch: Number(rt.termEndEpoch) - 1,
    registeredEpoch: Number(rt.registeredEpoch),
    status: rt.status,
    dammPool: rt.dammPool?.toBase58() ?? null,
    operator: rt.operator.toBase58(),
    commissionFloorBps: { inflation: rt.inflationCommissionBps, blockRevenue: rt.blockCommissionBps },
    escrow: {
      balanceSol: sol(Math.max(0, input.escrowLamports - input.rentExemptLamports)),
      asOf: isoIst(input.readAt),
    },
    buybacks: {
      slicesPerEpoch: rt.slicesPerEpoch,
      windowSlots: rt.windowSlots,
      maxSlippageBps: rt.maxSlippageBps,
      maxImpactBps: rt.maxImpactBps,
      paused: revenueTokenBuybacksPaused(rt),
      redeemOpen: revenueTokenRedeemOpen(rt, BigInt(input.epoch)),
    },
    totals: {
      escrowedSol: sol(rt.totalEscrowed),
      spentSol: sol(rt.totalSpent),
      boughtTokens: tokens(rt.totalBought),
      burnedTokens: tokens(rt.totalBurned),
      redeemedTokens: tokens(rt.totalRedeemed),
      redeemedSol: sol(rt.totalRedeemedLamports),
      buybacks: rt.buybackCount,
    },
    note: null,
  };
}

/** The reads on the program's cluster; `RpcRevenueTokenChain` is the real one, tests pass fakes. */
export interface RevenueTokenChain {
  /** Data and lamports of each address, null when it does not exist. */
  accounts(addresses: readonly PublicKey[]): Promise<({ data: Uint8Array; lamports: number } | null)[]>;
  /** The rent-exempt minimum of a 0-byte account: the escrow keeps it. */
  rentExemptMinimum(): Promise<number>;
  epoch(): Promise<number>;
}

/** Through the API's `EpochProgramSource` connections (the program's cluster, with failover). */
export class RpcRevenueTokenChain implements RevenueTokenChain {
  private rent?: Promise<number>;

  constructor(private readonly program: Pick<EpochProgramSource, 'connections' | 'epochInfo'>) {}

  async accounts(addresses: readonly PublicKey[]): Promise<({ data: Uint8Array; lamports: number } | null)[]> {
    const infos = await this.program.connections.withFailover((connection) =>
      connection.getMultipleAccountsInfo([...addresses], 'confirmed'),
    );
    return infos.map((info) => (info ? { data: info.data, lamports: info.lamports } : null));
  }

  rentExemptMinimum(): Promise<number> {
    this.rent ??= this.program.connections
      .withFailover((connection) => connection.getMinimumBalanceForRentExemption(0))
      .catch((error: unknown) => {
        this.rent = undefined;
        throw error;
      });
    return this.rent;
  }

  async epoch(): Promise<number> {
    return (await this.program.epochInfo()).epoch;
  }
}

/** How long one program read is reused (the page is polled; the account changes once a sweep or a slice runs). */
const CACHE_MS = 10_000;

/** The program's `RevenueToken` when it is registered, else the launch record. */
export class ProgramRevenueTokenSource implements RevenueTokenSource {
  private readonly cache = new Map<string, { at: number; value: RevenueTokenInfo }>();

  constructor(
    private readonly programId: PublicKey | null,
    private readonly chain: RevenueTokenChain | null,
    private readonly now: () => number = Date.now,
  ) {}

  async get(entry: LaunchRegistryEntry): Promise<RevenueTokenInfo> {
    const cached = this.cache.get(entry.mint);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.value;
    const value = await this.read(entry);
    // A failed read is not kept: the next request tries again.
    if (value.source === 'program' || value.registeredOnChain === false) {
      this.cache.set(entry.mint, { at: this.now(), value });
    }
    return value;
  }

  private async read(entry: LaunchRegistryEntry): Promise<RevenueTokenInfo> {
    const { programId, chain } = this;
    if (!programId || !chain || !entry.validator.vote) return registryRevenueToken(entry, programId);
    const vote = new PublicKey(entry.validator.vote);
    const address = revenueTokenAddress(programId, vote);
    const escrow = buybackEscrowAddress(programId, vote);
    try {
      const [[token, escrowAccount], rent, epoch] = await Promise.all([
        chain.accounts([address, escrow]),
        chain.rentExemptMinimum(),
        chain.epoch(),
      ]);
      if (!token) {
        return {
          ...registryRevenueToken(
            entry,
            programId,
            "Not registered with the program yet: the terms are the launch record's.",
          ),
          registeredOnChain: false,
        };
      }
      const rt = decodeRevenueToken(token.data);
      if (rt.mint.toBase58() !== entry.mint) {
        return {
          ...registryRevenueToken(
            entry,
            programId,
            `The validator's registered revenue token is another mint (${rt.mint.toBase58()}).`,
          ),
          registeredOnChain: false,
        };
      }
      return programRevenueToken({
        rt,
        address,
        escrow,
        treasury: partnerTreasuryAddress(programId),
        escrowLamports: escrowAccount?.lamports ?? 0,
        rentExemptLamports: rent,
        epoch,
        decimals: entry.decimals,
        readAt: new Date(this.now()),
      });
    } catch (error) {
      logger.warn('revenue token read failed', { mint: entry.mint, error: String(error) });
      return registryRevenueToken(
        entry,
        programId,
        "The program could not be read just now: the terms are the launch record's.",
      );
    }
  }
}
