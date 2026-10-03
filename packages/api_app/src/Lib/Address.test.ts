import { isAddress } from './Address';

describe('isAddress', () => {
  it('accepts base58 strings of 32 bytes', () => {
    expect(isAddress('FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk')).toBe(true);
    expect(isAddress('Stake11111111111111111111111111111111111111')).toBe(true);
    expect(isAddress('11111111111111111111111111111111')).toBe(true);
  });

  it('refuses other alphabets, lengths and byte counts', () => {
    expect(isAddress('FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmM0')).toBe(false);
    expect(isAddress('not-an-address')).toBe(false);
    expect(isAddress('')).toBe(false);
    expect(isAddress('1111111111111111111111111111111')).toBe(false);
    // 44 base58 characters that decode to 33 bytes.
    expect(isAddress('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
  });
});
