import { readFileSync } from 'fs';
import { join } from 'path';

import { decodeTokenMetadata } from './tokenMetadata';

describe('decodeTokenMetadata', () => {
  it("the rehearsal token's metadata is immutable: is_mutable false, update authority the System Program", () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__/rehearsal/account-metadata.json'), 'utf8'),
    ) as {
      address: string;
      data: string;
    };
    const bytes = Uint8Array.from(atob(fixture.data), (char) => char.charCodeAt(0));
    expect(decodeTokenMetadata(bytes, fixture.address)).toEqual({
      address: fixture.address,
      updateAuthority: '11111111111111111111111111111111',
      mint: '2gg2Sun6S8EoJq2E9QjrjPf9bENzrveDGCvP9CHM7Tby',
      name: 'Epoch rehearsal revenue token',
      symbol: 'rREH',
      uri: 'https://example.invalid/rreh.json',
      sellerFeeBasisPoints: 0,
      isMutable: false,
      locked: true,
    });
    expect(() => decodeTokenMetadata(Uint8Array.from([1, 2, 3]))).toThrow('not a Metaplex metadata account');
  });
});
