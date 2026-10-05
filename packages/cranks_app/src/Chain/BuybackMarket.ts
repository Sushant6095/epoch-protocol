import { type BuybackVenueState, type RevenueTokenAccount } from '@epoch/epoch-sdk';
import {
  buybackGraduation,
  buybackVenueState,
  decodeMintAccount,
  quoteBuyback,
  readBuybackVenue,
} from '@epoch/meteora';
import { type ConnectionManager } from '@epoch/solana';
import { type PublicKey } from '@solana/web3.js';

/** A fresh quote for one slice, in base units. */
export interface SliceQuote {
  /** SOL the swap uses, fee included. */
  lamportsIn: bigint;
  /** Tokens out after the pool fee. */
  amountOut: bigint;
  /** `amountOut` less the crank's slippage: the `min_amount_out` it sends. */
  minimumOut: bigint;
}

/** The venue a slice will trade on, read once: its raw state (for the program's own floor) and a quote on it. */
export interface BuybackVenueSnapshot {
  kind: 'dbc' | 'dammV2';
  pool: PublicKey;
  state: BuybackVenueState;
  quote(lamportsIn: bigint, slippageBps: number): Promise<SliceQuote>;
}

/** What `sync_revenue_token_pool` needs once the curve graduated. */
export interface Graduation {
  dammConfig: PublicKey;
  dammPool: PublicKey;
}

/** The Meteora side of the buybacks: a seam so BuybackJob runs against a fake in tests. */
export interface BuybackMarket {
  /** The token's venue now: its DBC pool until the DAMM v2 pool is synced, then that pool. Null when missing. */
  venue(token: RevenueTokenAccount): Promise<BuybackVenueSnapshot | null>;
  /** For a curve that migrated but is not synced yet: its DAMM v2 config and pool. Null otherwise. */
  graduation(token: RevenueTokenAccount): Promise<Graduation | null>;
}

/** The real market: Meteora pool reads and quotes through @epoch/meteora on the program's cluster. */
export class MeteoraBuybackMarket implements BuybackMarket {
  private readonly decimals = new Map<string, number>();

  constructor(private readonly connections: ConnectionManager) {}

  async venue(token: RevenueTokenAccount): Promise<BuybackVenueSnapshot | null> {
    const kind = token.dammPool ? 'dammV2' : 'dbc';
    const pool = token.dammPool ?? token.dbcPool;
    const accounts = await this.connections.withFailover((connection) =>
      readBuybackVenue({ connection, kind, pool, dbcConfig: token.dbcConfig, mint: token.mint }),
    );
    if (!accounts) return null;
    const tokenDecimals = await this.tokenDecimals(token.mint);
    const connection = this.connections.primary;
    return {
      kind,
      pool,
      state: buybackVenueState(accounts),
      quote: (lamportsIn, slippageBps) =>
        quoteBuyback({ connection, accounts, lamportsIn, slippageBps, tokenDecimals }),
    };
  }

  async graduation(token: RevenueTokenAccount): Promise<Graduation | null> {
    if (token.dammPool) return null;
    const accounts = await this.connections.withFailover((connection) =>
      readBuybackVenue({ connection, kind: 'dbc', pool: token.dbcPool, dbcConfig: token.dbcConfig }),
    );
    return accounts?.kind === 'dbc' ? buybackGraduation(accounts) : null;
  }

  private async tokenDecimals(mint: PublicKey): Promise<number> {
    const cached = this.decimals.get(mint.toBase58());
    if (cached !== undefined) return cached;
    const info = await this.connections.withFailover((c) => c.getAccountInfo(mint, 'confirmed'));
    if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
    const { decimals } = decodeMintAccount(info.data);
    this.decimals.set(mint.toBase58(), decimals);
    return decimals;
  }
}
