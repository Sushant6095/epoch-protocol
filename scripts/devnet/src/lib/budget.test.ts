import { deployerReserveLine } from '../commands/budget';
import {
  deployLines,
  perByteFromRentOfZero,
  priorityFee,
  rentFromPerByte,
  roundUpSol,
  sol,
  totals,
  txFee,
} from './budget';

describe('budget', () => {
  const devnetRent = rentFromPerByte(5_080n);

  it('matches the rent devnet reported (getMinimumBalanceForRentExemption)', () => {
    // Read on 7 Oct 2026: rent(0) = 650,240 and rent(1,959,981) = 9,957,353,720 on devnet.
    expect(perByteFromRentOfZero(650_240n)).toBe(5_080n);
    expect(devnetRent(1_959_981)).toBe(9_957_353_720n);
    expect(() => perByteFromRentOfZero(650_241n)).toThrow(RangeError);
  });

  it('matches the mainnet go-live table at 6,960 lamports per byte', () => {
    const mainnet = rentFromPerByte(6_960n);
    expect(mainnet(45 + 957_464)).toBe(6_665_153_520n);
    expect(mainnet(45 + 1_200_000)).toBe(8_353_204_080n);
  });

  it('prices a deploy: program data and account kept, buffer temporary', () => {
    const lines = deployLines({ soLen: 957_464, maxLen: 1_200_000, rent: devnetRent });
    expect(lines.map((l) => l.lamports)).toEqual([
      devnetRent(1_200_045),
      devnetRent(36),
      devnetRent(957_501),
      958n * 5_000n + 4n * 5_000n,
    ]);
    const t = totals(lines);
    expect(t.spent).toBe(devnetRent(1_200_045) + devnetRent(36) + 958n * 5_000n + 20_000n);
    expect(t.peak).toBe(t.spent + devnetRent(957_501));
    expect(() => deployLines({ soLen: 10, maxLen: 9, rent: devnetRent })).toThrow(/max-len/);
  });

  it('adds priority fees rounded up to a lamport', () => {
    expect(priorityFee(0n, 200_000)).toBe(0n);
    expect(priorityFee(1n, 1)).toBe(1n);
    expect(priorityFee(10_000n, 200_000)).toBe(2_000n);
    expect(txFee(2, 10_000n, 200_000)).toBe(12_000n);
  });

  it('separates recoverable from spent and keeps only the largest temporary item in the peak', () => {
    const t = totals([
      { stage: 's', item: 'rent', lamports: 10n },
      { stage: 's', item: 'deposit', lamports: 100n, recoverable: true },
      { stage: 's', item: 'buffer', lamports: 50n, temporary: true },
      { stage: 's', item: 'buffer2', lamports: 70n, temporary: true },
    ]);
    expect(t).toEqual({ spent: 10n, recoverable: 100n, peak: 180n });
  });

  it('refunds a temporary item at the end of its stage, before later stages', () => {
    const t = totals([
      { stage: 'deploy', item: 'program data', lamports: 6n },
      { stage: 'deploy', item: 'buffer', lamports: 5n, temporary: true },
      { stage: 'seed', item: 'deposits', lamports: 10n, recoverable: true },
    ]);
    expect(t).toEqual({ spent: 6n, recoverable: 10n, peak: 16n });
    const big = totals([
      { stage: 'deploy', item: 'program data', lamports: 6n },
      { stage: 'deploy', item: 'buffer', lamports: 50n, temporary: true },
      { stage: 'seed', item: 'deposits', lamports: 10n, recoverable: true },
    ]);
    expect(big.peak).toBe(56n);
  });

  it('formats lamports exactly and rounds up to 0.1 SOL', () => {
    expect(sol(6_096_878_840n)).toBe('6.096878840');
    expect(sol(-5n)).toBe('-0.000000005');
    expect(roundUpSol(6_096_878_840n)).toBe(6_100_000_000n);
    expect(roundUpSol(6_100_000_000n)).toBe(6_100_000_000n);
  });

  it('keeps the deployer rent-exempt: its rent-exempt minimum is part of every stage', () => {
    const lines = [
      ...deployLines({ soLen: 957_464, maxLen: 1_600_000, rent: devnetRent }),
      deployerReserveLine(devnetRent),
    ];
    expect(deployerReserveLine(devnetRent).lamports).toBe(650_240n);
    // program data 8.128878840 + program account + reserve, plus the buffer at the deploy's peak
    expect(totals(lines).peak).toBe(
      devnetRent(45 + 1_600_000) + devnetRent(36) + 650_240n + devnetRent(37 + 957_464) + lines[3].lamports,
    );
  });
});
