import { type PantaInstruction, toTransactionInstructions } from '@epoch/panta';
import {
  type ConnectionManager,
  EpochClock,
  PrebuiltTransactionSender,
  type SignatureState,
  TransactionSender,
} from '@epoch/solana';
import { type Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

import { type ClockSnapshot, secondsPerSlotFrom } from '../Markets/EpochSchedule';

/** The guard refused to sign: the transaction would take more than the quote allows, or is not what was built. */
export class SpendGuardError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SpendGuardError';
  }
}

export interface GuardLimits {
  /** The quoted creation fee: the most USDC the transaction may take from the bot. */
  maxUsdcBase: number;
  /** Network fees and rent the transaction may take, lamports. */
  maxLamports: number;
  /** The blockhash the build response named; the transaction must carry it. */
  recentBlockhash: string;
}

export interface SignedCreate {
  signature: string;
  signedBase64: string;
  /** What the simulation showed leaving the bot. */
  usdcSpentBase: number;
  lamportsSpent: number;
}

/** What the lifecycle needs from Solana mainnet and the creator key. Live: `LiveBotChain`; tests: a fake. */
export interface BotChain {
  /** The creator wallet (base58), or null without a keypair (dry run). */
  readonly wallet: string | null;
  clock(): Promise<ClockSnapshot>;
  /** The creator's USDC (base units) and SOL (lamports), or null without a keypair. */
  balances(): Promise<{ usdcBase: number; lamports: number } | null>;
  /** Checks Panta's unsigned create, simulates it, and signs it only if it stays within `limits`. */
  guardAndSign(unsignedBase64: string, limits: GuardLimits): Promise<SignedCreate>;
  /**
   * Broadcasts (or re-broadcasts) a signed transaction and waits until it is confirmed. Throws
   * `TransactionFailedException`: `details.expired` when the blockhash died first (it can never land), `details.err`
   * when it failed on chain.
   */
  send(signed: { signedBase64: string; signature: string }, lastValidBlockHeight: number): Promise<void>;
  /** Searches history too: for recovery after a restart. */
  state(signature: string): Promise<SignatureState['status']>;
  blockHeight(): Promise<number>;
  /** Compiles, signs and sends instructions with the creator key (creator-fee claims). */
  sendInstructions(instructions: readonly PantaInstruction[]): Promise<string>;
}

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SLOT_TIME_CACHE_MS = 10 * 60_000;

/** The owner's associated token account for `mint` (classic SPL Token). */
export const associatedTokenAddress = (owner: PublicKey, mint: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];

/** An SPL token account's amount: u64 little-endian at byte 64. */
export function tokenAmount(data: Uint8Array): number {
  const bytes = Buffer.from(data);
  return bytes.length >= 72 ? Number(bytes.readBigUInt64LE(64)) : 0;
}

export interface LiveBotChainOptions {
  connections: ConnectionManager;
  /** Undefined in a dry run: nothing can be signed. */
  keypair?: Keypair;
  usdcMint: string;
  computeUnitPriceMicroLamports: number;
  now?: () => number;
}

/** Mainnet through `@epoch/solana`: `EpochClock`, `PrebuiltTransactionSender` (creates), `TransactionSender` (claims). */
export class LiveBotChain implements BotChain {
  private readonly epochClock: EpochClock;
  private readonly prebuilt?: PrebuiltTransactionSender;
  private readonly sender?: TransactionSender;
  private readonly mint: PublicKey;
  private readonly now: () => number;
  private slotSeconds?: { value: number; at: number };

  constructor(private readonly options: LiveBotChainOptions) {
    this.epochClock = new EpochClock(options.connections);
    this.mint = new PublicKey(options.usdcMint);
    this.now = options.now ?? Date.now;
    if (options.keypair) {
      this.prebuilt = new PrebuiltTransactionSender(options.connections, options.keypair);
      this.sender = new TransactionSender(options.connections, options.keypair);
    }
  }

  get wallet(): string | null {
    return this.options.keypair?.publicKey.toBase58() ?? null;
  }

  async clock(): Promise<ClockSnapshot> {
    const snapshot = await this.epochClock.now();
    return {
      epoch: snapshot.epoch,
      slotIndex: snapshot.slotIndex,
      slotsInEpoch: snapshot.slotsInEpoch,
      absoluteSlot: snapshot.absoluteSlot,
      secondsPerSlot: await this.secondsPerSlot(),
      nowMs: this.now(),
    };
  }

  async balances(): Promise<{ usdcBase: number; lamports: number } | null> {
    const owner = this.options.keypair?.publicKey;
    if (!owner) return null;
    const ata = associatedTokenAddress(owner, this.mint);
    const [token, wallet] = await this.options.connections.withFailover((c) =>
      c.getMultipleAccountsInfo([ata, owner], 'confirmed'),
    );
    return { usdcBase: token ? tokenAmount(token.data) : 0, lamports: wallet?.lamports ?? 0 };
  }

  async guardAndSign(unsignedBase64: string, limits: GuardLimits): Promise<SignedCreate> {
    const owner = this.options.keypair?.publicKey;
    if (!owner || !this.prebuilt) throw new SpendGuardError('No creator keypair: nothing can be signed');
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(unsignedBase64, 'base64'));
    } catch {
      throw new SpendGuardError('Panta returned something that is not a transaction');
    }
    const { header, staticAccountKeys, recentBlockhash } = tx.message;
    if (!staticAccountKeys[0]?.equals(owner)) {
      throw new SpendGuardError('The create is not paid by the creator wallet', {
        feePayer: staticAccountKeys[0]?.toBase58() ?? null,
      });
    }
    if (header.numRequiredSignatures !== 1) {
      throw new SpendGuardError('The create asks for more than the creator signature', {
        requiredSignatures: header.numRequiredSignatures,
      });
    }
    if (recentBlockhash !== limits.recentBlockhash) {
      throw new SpendGuardError('The transaction blockhash differs from the build response');
    }

    // Balances before, then the simulated balances after: what the create would really take from the bot.
    const ata = associatedTokenAddress(owner, this.mint);
    const [tokenBefore, walletBefore] = await this.options.connections.withFailover((c) =>
      c.getMultipleAccountsInfo([ata, owner], 'confirmed'),
    );
    const { value } = await this.options.connections.withFailover((c) =>
      c.simulateTransaction(tx, {
        sigVerify: false,
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: [ata.toBase58(), owner.toBase58()] },
      }),
    );
    if (value.err) {
      throw new SpendGuardError('The create fails in simulation', {
        err: value.err,
        logs: (value.logs ?? []).slice(-8),
      });
    }
    const [tokenAfter, walletAfter] = value.accounts ?? [];
    const usdcBefore = tokenBefore ? tokenAmount(tokenBefore.data) : 0;
    const usdcAfter = tokenAfter ? tokenAmount(Buffer.from(tokenAfter.data[0], 'base64')) : 0;
    const usdcSpentBase = usdcBefore - usdcAfter;
    const lamportsSpent = (walletBefore?.lamports ?? 0) - (walletAfter?.lamports ?? 0);
    if (usdcSpentBase > limits.maxUsdcBase) {
      throw new SpendGuardError('The create would take more USDC than quoted', {
        usdcSpentBase,
        quotedUsdcBase: limits.maxUsdcBase,
      });
    }
    if (lamportsSpent > limits.maxLamports) {
      throw new SpendGuardError('The create would take more SOL than allowed', {
        lamportsSpent,
        maxLamports: limits.maxLamports,
      });
    }
    const signed = this.prebuilt.sign(unsignedBase64);
    return { signature: signed.signature, signedBase64: signed.signedBase64, usdcSpentBase, lamportsSpent };
  }

  async send(signed: { signedBase64: string; signature: string }, lastValidBlockHeight: number): Promise<void> {
    if (!this.prebuilt) throw new SpendGuardError('No creator keypair: nothing can be sent');
    await this.prebuilt.resend(signed.signedBase64, { lastValidBlockHeight });
  }

  async state(signature: string): Promise<SignatureState['status']> {
    if (!this.prebuilt) return 'unknown';
    return (await this.prebuilt.state(signature, true)).status;
  }

  blockHeight(): Promise<number> {
    return this.options.connections.withFailover((c) => c.getBlockHeight('confirmed'));
  }

  async sendInstructions(instructions: readonly PantaInstruction[]): Promise<string> {
    if (!this.sender) throw new SpendGuardError('No creator keypair: nothing can be sent');
    return this.sender.send(toTransactionInstructions(instructions), [], {
      computeUnitPriceMicroLamports: this.options.computeUnitPriceMicroLamports,
    });
  }

  /** Mainnet seconds per slot over the last hour of performance samples, cached 10 minutes; 0.4 if unreadable. */
  private async secondsPerSlot(): Promise<number> {
    const cached = this.slotSeconds;
    if (cached && this.now() - cached.at < SLOT_TIME_CACHE_MS) return cached.value;
    try {
      const samples = await this.options.connections.withFailover((c) => c.getRecentPerformanceSamples(60));
      const value = secondsPerSlotFrom(samples);
      this.slotSeconds = { value, at: this.now() };
      return value;
    } catch {
      return cached?.value ?? 0.4;
    }
  }
}
