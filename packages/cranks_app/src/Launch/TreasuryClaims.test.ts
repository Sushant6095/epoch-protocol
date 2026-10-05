import * as sdk from '@epoch/epoch-sdk';
import { type ClaimableItem, type ClaimKind, type LaunchClaimsState } from '@epoch/meteora';
import { Keypair } from '@solana/web3.js';

import { type ClaimLaunch } from './LaunchRegistryFile';
import { isTreasuryClaim, treasuryClaimInstructions, treasuryClaimRoute } from './TreasuryClaims';

const programId = Keypair.generate().publicKey;
const crank = Keypair.generate();
const route = treasuryClaimRoute(programId, crank);
const pda = route.treasury.toBase58();
const creator = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey;
const dbcPool = Keypair.generate().publicKey;
const dbcConfig = Keypair.generate().publicKey;
const dammPool = Keypair.generate().publicKey;
const position = Keypair.generate().publicKey;
const nftMint = Keypair.generate().publicKey;

const launch: ClaimLaunch = {
  mint: mint.toBase58(),
  symbol: 'rTEST',
  cluster: 'devnet',
  dbcPool: dbcPool.toBase58(),
  dbcConfig: dbcConfig.toBase58(),
  dammPool: dammPool.toBase58(),
};

const claim = (kind: ClaimKind, signer: string | null, receiver = signer ?? pda): ClaimableItem => ({
  kind,
  signer,
  receiver,
  lamports: 1n,
  tokens: 0n,
  available: true,
  withdrawn: false,
  reason: null,
  ...(kind === 'lpFee' ? { position: position.toBase58() } : {}),
});

const state = {
  config: dbcConfig.toBase58(),
  dammPool: dammPool.toBase58(),
  positions: [{ position: position.toBase58(), nftMint: nftMint.toBase58() }],
} as unknown as LaunchClaimsState;

describe('treasury claims through the Epoch program', () => {
  it('derives the treasury PDA of the program', () => {
    const [pool] = sdk.findPoolPda(programId);
    expect(pda).toBe(sdk.findPartnerTreasuryPda(programId, pool)[0].toBase58());
    expect(route.cranker).toBe(crank);
  });

  it('owns the partner claims it must sign and the leftover it receives, never a creator claim', () => {
    expect(isTreasuryClaim(claim('partnerTradingFee', pda), route.treasury)).toBe(true);
    expect(isTreasuryClaim(claim('partnerSurplus', pda), route.treasury)).toBe(true);
    expect(isTreasuryClaim(claim('partnerMigrationFee', pda), route.treasury)).toBe(true);
    expect(isTreasuryClaim(claim('lpFee', pda), route.treasury)).toBe(true);
    expect(isTreasuryClaim(claim('leftover', null, pda), route.treasury)).toBe(true);
    // Not the treasury's: another fee claimer, another leftover receiver, the creator's position and claims.
    expect(isTreasuryClaim(claim('partnerTradingFee', creator), route.treasury)).toBe(false);
    expect(isTreasuryClaim(claim('leftover', null, creator), route.treasury)).toBe(false);
    expect(isTreasuryClaim(claim('lpFee', creator), route.treasury)).toBe(false);
    expect(isTreasuryClaim(claim('creatorMigrationFee', pda), route.treasury)).toBe(false);
  });

  it('builds exactly the SDK instruction for each kind', () => {
    const cranker = crank.publicKey;
    const build = (kind: ClaimKind) =>
      treasuryClaimInstructions({
        programId,
        cranker,
        launch,
        state,
        claim: claim(kind, kind === 'leftover' ? null : pda),
      });
    expect(build('partnerTradingFee')).toEqual(
      sdk.claimPartnerTradingFee({ programId, cranker, dbcPool, dbcConfig, mint }),
    );
    expect(build('partnerSurplus')).toEqual(sdk.claimPartnerSurplus({ programId, cranker, dbcPool, dbcConfig }));
    expect(build('partnerMigrationFee')).toEqual(
      sdk.claimPartnerMigrationFee({ programId, cranker, dbcPool, dbcConfig }),
    );
    expect(build('leftover')).toEqual(sdk.burnLeftover({ programId, cranker, dbcPool, dbcConfig, mint }));
    expect(build('lpFee')).toEqual(sdk.claimTreasuryLpFee({ programId, cranker, dammPool, mint, position, nftMint }));
    for (const [ix] of ['partnerTradingFee', 'leftover', 'lpFee'].map((kind) => build(kind as ClaimKind))) {
      expect(ix.keys.find((k) => k.isSigner)?.pubkey.equals(cranker)).toBe(true);
    }
  });

  it('refuses a creator claim and an LP claim without its position', () => {
    const cranker = crank.publicKey;
    expect(() =>
      treasuryClaimInstructions({ programId, cranker, launch, state, claim: claim('creatorSurplus', creator) }),
    ).toThrow('creatorSurplus is not a treasury claim');
    expect(() =>
      treasuryClaimInstructions({
        programId,
        cranker,
        launch,
        state: { ...state, positions: [] },
        claim: claim('lpFee', pda),
      }),
    ).toThrow(`LP position ${position.toBase58()} was not read`);
  });
});
