import * as sdk from '@epoch/epoch-sdk';

import { rentFromPerByte } from '../lib/budget';
import { depositKey, emptyProgress, revenueShortfall, walletNeeds } from './needs';
import { DEVNET_PLAN, seedLines, seedWallets } from './plan';

const rent = rentFromPerByte(5_080n);
const sizes = { voteAccount: 3_762, voteReserve: 100_000_000n };
const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

describe('walletNeeds', () => {
  it('asks for exactly what the budget prices for the onboarding-epoch steps', () => {
    const needs = walletNeeds(DEVNET_PLAN, rent, sizes, emptyProgress());
    expect([...needs.keys()].sort()).toEqual(seedWallets(DEVNET_PLAN).sort());
    const priced = seedLines(DEVNET_PLAN, rent, sizes)
      .filter((l) =>
        /^(deposits|\d+ lender accounts|\d+ vote accounts|\d+ positions|bonds|revenue float|advance accounts|fee floats|swap: taker collateral|swap account|revenue token r)/.test(
          l.item,
        ),
      )
      .reduce((a, l) => a + l.lamports, 0n);
    expect(sum(needs)).toBe(priced);
  });

  it('drops a step once its effect is on chain, so a re-run never sends the same capital twice', () => {
    const progress = emptyProgress();
    for (const d of DEVNET_PLAN.deposits) progress.deposited.add(depositKey(d.lender, d.tranche));
    progress.withdrawalRequested = true;
    for (const v of DEVNET_PLAN.validators) {
      progress.voteAccounts.add(v.name);
      progress.onboarded.add(v.name);
      progress.revenueMissing.set(v.name, 0n);
      progress.advanced.add(v.name);
    }
    progress.swapOpen = true;
    progress.revenueTokenDone = true;
    const needs = walletNeeds(DEVNET_PLAN, rent, sizes, progress);
    for (const lamports of needs.values()) expect(lamports).toBe(DEVNET_PLAN.feeFloat);
  });

  it('charges each operator for its own validators only', () => {
    const progress = emptyProgress();
    progress.voteAccounts.add('v2');
    progress.onboarded.add('v2');
    progress.revenueMissing.set('v1', 0n);
    progress.revenueTokenDone = true;
    const needs = walletNeeds(DEVNET_PLAN, rent, sizes, progress);
    const v3 = DEVNET_PLAN.validators.find((v) => v.name === 'v3')!;
    expect(needs.get('operator2')).toBe(
      DEVNET_PLAN.feeFloat +
        rent(3_762) +
        sizes.voteReserve +
        rent(sdk.ACCOUNT_SIZES.ValidatorPosition) +
        rent(0) +
        v3.bond,
    );
  });

  it('sends only the part of the next epoch revenue that a vote account does not hold yet', () => {
    expect(revenueShortfall(1_000n, 1_000n, 300n)).toBe(300n);
    expect(revenueShortfall(1_100n, 1_000n, 300n)).toBe(200n);
    expect(revenueShortfall(1_400n, 1_000n, 300n)).toBe(0n);
    expect(revenueShortfall(900n, 1_000n, 300n)).toBe(300n);
  });

  it('asks the rewards wallet only for revenue the vote accounts still miss', () => {
    const progress = emptyProgress();
    progress.revenueMissing.set('v1', 0n);
    progress.revenueMissing.set('v2', 100n);
    const v3 = DEVNET_PLAN.validators.find((v) => v.name === 'v3')!;
    expect(walletNeeds(DEVNET_PLAN, rent, sizes, progress).get('rewards')).toBe(
      DEVNET_PLAN.feeFloat + 100n + v3.revenuePerEpoch,
    );
  });
});
