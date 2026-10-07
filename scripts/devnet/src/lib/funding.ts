/**
 * Funding role wallets from the deployer, the one wallet the user funds. Every top-up sends only the shortfall to a
 * target balance, so re-running never over-funds; the local rehearsal funds the deployer alone (faucet) and then uses
 * exactly this path, which is how it proves the budget.
 */
import { type Connection, type Keypair, type PublicKey, SystemProgram } from '@solana/web3.js';

import { sol } from './budget';
import { KitError } from './errors';
import { type Landed, sendTx } from './tx';

export interface FundTarget {
  label: string;
  to: PublicKey;
  /** Balance the wallet should have after funding. */
  lamports: bigint;
  /**
   * Top up only when the balance is below this (default: `lamports`). A fee float uses half its target, so a re-run
   * right after a run that paid a few fees sends nothing; rent that must be there at once uses the full target.
   */
  refillBelow?: bigint;
}

export interface TopUp extends FundTarget {
  send: bigint;
}

/** Fee floats of the signing roles `init` funds (lamports); the cranker pays for the most transactions. */
export const ROLE_FEE_FLOAT = {
  admin: 20_000_000n,
  scorer: 20_000_000n,
  publisher: 20_000_000n,
  cranker: 50_000_000n,
} as const;

/**
 * Each Fee Index operator's float: its vote fees and, for the first voter of an epoch, the ballot's rent (≈ 0.0054 SOL
 * on devnet, refunded when CloseBallotsJob closes the ballot about four epochs later).
 */
export const INDEX_OPERATOR_FEE_FLOAT = 50_000_000n;

/** A fee float that is refilled to `lamports` once it has dropped below half of it. */
export function feeFloat(label: string, to: PublicKey, lamports: bigint): FundTarget {
  return { label, to, lamports, refillBelow: lamports / 2n };
}

/** What to send to bring each wallet below its refill line back up to its target; others are skipped. */
export function topUps(targets: FundTarget[], balances: bigint[]): TopUp[] {
  return targets
    .map((t, i) => {
      const below = balances[i] < (t.refillBelow ?? t.lamports);
      return { ...t, send: below && t.lamports > balances[i] ? t.lamports - balances[i] : 0n };
    })
    .filter((t) => t.send > 0n);
}

/** Up to this many transfers per transaction (≈ 50 bytes each; well inside one packet). */
export const TRANSFERS_PER_TX = 10;

export async function fundFromDeployer(
  conn: Connection,
  deployer: Keypair,
  targets: FundTarget[],
  microLamportsPerCu: bigint,
): Promise<{ sent: TopUp[]; txs: Landed[] }> {
  const balances = await Promise.all(targets.map(async (t) => BigInt(await conn.getBalance(t.to, 'confirmed'))));
  const sent = topUps(targets, balances);
  const total = sent.reduce((a, t) => a + t.send, 0n);
  const have = BigInt(await conn.getBalance(deployer.publicKey, 'confirmed'));
  if (total > 0n && have < total + 100_000n) {
    throw new KitError(
      'INSUFFICIENT_FUNDS',
      `funding role wallets needs ${sol(total)} SOL; deployer ${deployer.publicKey.toBase58()} has ${sol(have)}`,
    );
  }
  const txs: Landed[] = [];
  for (let i = 0; i < sent.length; i += TRANSFERS_PER_TX) {
    const batch = sent.slice(i, i + TRANSFERS_PER_TX);
    txs.push(
      await sendTx(
        conn,
        `fund ${batch.map((t) => `${t.label} +${sol(t.send)}`).join(', ')}`,
        batch.map((t) => SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: t.to, lamports: t.send })),
        [deployer],
        { microLamportsPerCu },
      ),
    );
  }
  return { sent, txs };
}
