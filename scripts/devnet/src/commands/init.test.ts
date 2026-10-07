import * as sdk from '@epoch/epoch-sdk';
import { Keypair } from '@solana/web3.js';

import { rentFromPerByte } from '../lib/budget';
import { INDEX_OPERATOR_FEE_FLOAT, ROLE_FEE_FLOAT, topUps } from '../lib/funding';
import { initLines } from './budget';
import { type Roles, roleFundTargets } from './init';

const roles = (): Roles => ({
  admin: Keypair.generate(),
  scorer: Keypair.generate(),
  publisher: Keypair.generate(),
  cranker: Keypair.generate(),
  maker: Keypair.generate(),
  treasury: Keypair.generate().publicKey,
  operators: [Keypair.generate(), Keypair.generate(), Keypair.generate()],
});

// Devnet's rate (SIMD-0437): 5,080 lamports per byte.
const rent = rentFromPerByte(5_080n);
const adminRent = rent(sdk.ACCOUNT_SIZES.Pool) + rent(0) + rent(sdk.ACCOUNT_SIZES.FeeIndex);

describe('roleFundTargets', () => {
  it('gives the admin the rent of the accounts it still has to create, in full', () => {
    const [admin] = roleFundTargets(roles(), rent, { pool: true, index: true });
    expect(admin.lamports).toBe(ROLE_FEE_FLOAT.admin + adminRent);
    expect(admin.refillBelow ?? admin.lamports).toBe(admin.lamports);
    const [indexOnly] = roleFundTargets(roles(), rent, { pool: false, index: true });
    expect(indexOnly.lamports).toBe(ROLE_FEE_FLOAT.admin + rent(sdk.ACCOUNT_SIZES.FeeIndex));
  });

  it('sends nothing on a re-run after a complete init that paid fees (rehearsal 2 finding)', () => {
    const r = roles();
    // Balances after the first init on a local validator: the admin paid the rent and two fees.
    const after = [
      ROLE_FEE_FLOAT.admin - 10_000n,
      ROLE_FEE_FLOAT.scorer,
      ROLE_FEE_FLOAT.publisher,
      ROLE_FEE_FLOAT.cranker,
      rent(0),
      // The first voter paid a ballot's rent; the others a vote fee each.
      INDEX_OPERATOR_FEE_FLOAT - rent(sdk.ACCOUNT_SIZES.IndexBallot) - 5_000n,
      INDEX_OPERATOR_FEE_FLOAT - 5_000n,
      INDEX_OPERATOR_FEE_FLOAT - 5_000n,
    ];
    expect(topUps(roleFundTargets(r, rent, { pool: false, index: false, registry: false }), after)).toEqual([]);
  });

  it('funds every role and the treasury from empty wallets, as the budget prices it', () => {
    const targets = roleFundTargets(roles(), rent, { pool: true, index: true, registry: true });
    const sent = topUps(
      targets,
      targets.map(() => 0n),
    ).reduce((a, t) => a + t.send, 0n);
    const priced = initLines(rent, 0n, 3)
      .filter((l) => !l.item.startsWith('fund roles') && !l.item.startsWith('initialize_index_operators'))
      .reduce((a, l) => a + l.lamports, 0n);
    expect(sent).toBe(priced);
  });
});

describe('the operator registry', () => {
  it('adds the registry rent to the admin only while it is missing, and prices nothing without operators', () => {
    const [withRegistry] = roleFundTargets(roles(), rent, { pool: false, index: false, registry: true });
    expect(withRegistry.lamports).toBe(ROLE_FEE_FLOAT.admin + rent(sdk.ACCOUNT_SIZES.IndexOperators));
    const single = { ...roles(), operators: [] };
    expect(roleFundTargets(single, rent, { pool: false, index: false, registry: true })[0].lamports).toBe(
      ROLE_FEE_FLOAT.admin,
    );
    expect(initLines(rent, 0n, 0).some((l) => l.item.includes('IndexOperators'))).toBe(false);
  });
});
