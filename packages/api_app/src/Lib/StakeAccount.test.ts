import { parseStakeAccount, STAKE_ACCOUNT_SIZE } from './StakeLayouts';

const hex = (b: Buffer) => b.toString('hex').slice(0, 8);

describe('parseStakeAccount', () => {
  it('reads a delegated stake account at the StakeStateV2 offsets', () => {
    const data = Buffer.alloc(STAKE_ACCOUNT_SIZE);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(2_282_880n, 4);
    data.fill(1, 12, 44);
    data.fill(2, 44, 76);
    data.writeBigInt64LE(0n, 76);
    data.writeBigUInt64LE(0n, 84);
    data.fill(3, 92, 124);
    data.fill(4, 124, 156);
    data.writeBigUInt64LE(5_000_000_000n, 156);
    data.writeBigUInt64LE(700n, 164);
    data.writeBigUInt64LE(18_446_744_073_709_551_615n, 172);
    data.writeBigUInt64LE(123n, 188);
    const parsed = parseStakeAccount('S', 5_002_282_880n, data, hex);
    expect(parsed).toMatchObject({
      state: 'delegated',
      rentExemptReserve: 2_282_880n,
      staker: '01010101',
      withdrawer: '02020202',
      custodian: '03030303',
      voter: '04040404',
      stakeLamports: 5_000_000_000n,
      activationEpoch: 700n,
      deactivationEpoch: 18_446_744_073_709_551_615n,
      creditsObserved: 123n,
    });
  });

  it('reads an initialized (undelegated) account and skips uninitialized ones', () => {
    const data = Buffer.alloc(STAKE_ACCOUNT_SIZE);
    data.writeUInt32LE(1, 0);
    expect(parseStakeAccount('S', 1n, data, hex)).toMatchObject({
      state: 'initialized',
      voter: null,
      stakeLamports: 0n,
    });
    data.writeUInt32LE(0, 0);
    expect(parseStakeAccount('S', 1n, data, hex)).toBeUndefined();
    expect(parseStakeAccount('S', 1n, Buffer.alloc(10), hex)).toBeUndefined();
  });
});
