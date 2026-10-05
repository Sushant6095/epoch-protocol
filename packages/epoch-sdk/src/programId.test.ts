/**
 * Every copy of the Epoch program id agrees with `declare_id!` (what scripts/check-program-id.sh checks, in the jest
 * gate): Anchor.toml, the IDL's address, the Rust vectors and `.env.example` (empty while the id is the placeholder).
 * scripts/set-program-id.sh <ID> updates them all.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { vectors } from './__fixtures__/vectors';

const ROOT = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const PLACEHOLDER = '11111111111111111111111111111111';

describe('the program id', () => {
  const declared = /^declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\);/m.exec(read('programs/epoch/src/lib.rs'))?.[1];

  it('is declared once in lib.rs', () => {
    expect(declared).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('agrees in Anchor.toml, the IDL, the vectors and .env.example', () => {
    const toml = read('Anchor.toml');
    const anchorIds = [...toml.matchAll(/^\[programs\.[a-z]+\]\s*\nepoch = "([^"]+)"/gm)].map((m) => m[1]);
    expect(anchorIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(anchorIds)).toEqual(new Set([declared]));
    expect((JSON.parse(read('programs/epoch/idl/epoch.json')) as { address: string }).address).toBe(declared);
    expect(vectors.declaredProgramId).toBe(declared);
    const env = /^EPOCH_PROGRAM_ID=(.*)$/m.exec(read('.env.example'))?.[1];
    expect(env === declared || (env === '' && declared === PLACEHOLDER)).toBe(true);
  });
});
