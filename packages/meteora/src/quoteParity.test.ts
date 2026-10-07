import { readFileSync } from 'fs';
import { join } from 'path';

import { getAmountWithSlippage, type PoolState, SwapMode } from '@meteora-ag/cp-amm-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import { NATIVE_MINT } from './constants';
import { cpAmmClient } from './pools';
import { dammSwapAmounts } from './trade';

/**
 * The unit of DAMM v2 `getQuote2`'s `slippage`, on the real cp-amm SDK (1.5.1) and the rehearsal's graduated pool.
 *
 * `trade.ts` and `buyback.ts` pass `slippage: slippageBps`, and `dammSwapAmounts` takes the SDK's `minimumAmountOut` when
 * it returns one. The SDK reads basis points (`getAmountWithSlippage(amount, slippageBps, swapMode)`, "1% = 100"), but
 * Meteora's DAMM v2 SDK reference shows `slippage: 0.5` in its `getQuote2` example
 * (docs.meteora.ag/developer-guides/damm-v2/typescript-sdk/reference, "Quote A Swap"), which reads like a percent, and the
 * older `getQuote` did take a percent. Were the SDK to switch to a percent, 100 would mean 100% and every minimum would be
 * zero; this test fails first.
 */
const fixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/rehearsal', 'account-damm-pool.json'), 'utf8'),
) as { address: string; data: string };
const client = cpAmmClient(new Connection('http://127.0.0.1:1'));
// The SDK's own program coder, as `fetchPoolState` decodes (camelCase fields).
const pool = client._program.coder.accounts.decode('pool', Buffer.from(fixture.data, 'base64')) as PoolState;
const currentPoint = pool.activationPoint.addn(1_000_000);

const quoteBuy = (slippage: number) =>
  client.getQuote2({
    inputTokenMint: NATIVE_MINT,
    slippage,
    currentPoint,
    poolState: pool,
    tokenADecimal: 6,
    tokenBDecimal: 9,
    hasReferral: false,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(10_000_000),
  });

describe('DAMM v2 getQuote2 slippage, on the real SDK', () => {
  it('is the rehearsal pool: SOL is token B', () => {
    expect(pool.tokenBMint.equals(new PublicKey(NATIVE_MINT))).toBe(true);
  });

  it.each([1, 50, 100, 300, 5_000])('reads %i as basis points', (bps) => {
    const quote = quoteBuy(bps);
    const out = BigInt(quote.outputAmount.toString());
    expect(out).toBeGreaterThan(0n);
    expect(BigInt(quote.minimumAmountOut.toString())).toBe((out * BigInt(10_000 - bps)) / 10_000n);
    expect(getAmountWithSlippage(quote.outputAmount, bps, SwapMode.ExactIn).toString()).toBe(
      quote.minimumAmountOut.toString(),
    );
  });

  it('gives the trade quote the SDK’s minimum, at our basis points', () => {
    const quote = quoteBuy(100);
    const raw = dammSwapAmounts({
      side: 'buy',
      result: quote,
      collectFeeMode: pool.collectFeeMode,
      baseIsTokenA: true,
      spotPriceSol: 0.001,
      baseDecimals: 6,
      quoteDecimals: 9,
      slippageBps: 100,
    });
    expect(raw.minimumOut).toBe((BigInt(quote.outputAmount.toString()) * 9_900n) / 10_000n);
  });
});
