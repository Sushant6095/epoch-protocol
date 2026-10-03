import { AddressParamsDto, isPublicKey, VoteParamsDto } from './Program.dto';

describe('Program DTOs', () => {
  it('accepts base58 public keys only', () => {
    expect(isPublicKey('FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk')).toBe(true);
    expect(isPublicKey('11111111111111111111111111111111')).toBe(true);
    expect(isPublicKey('1111111111111111111111111111111')).toBe(false); // 31 bytes
    expect(isPublicKey('0OIlFzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn')).toBe(false); // not base58
    expect(isPublicKey('x'.repeat(50))).toBe(false);
  });

  it('validates the route params', () => {
    expect(VoteParamsDto.safeParse({ vote: 'FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk' }).success).toBe(true);
    const bad = AddressParamsDto.safeParse({ address: 'abc' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toBe('address must be a base58 public key');
  });
});
