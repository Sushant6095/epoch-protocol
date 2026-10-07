import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KitError } from './errors';
import { assertOutsideRepo, isInside, KeyFolder, readKeypair } from './keys';

describe('keys', () => {
  let tmp: string;
  let repo: string;
  let outside: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devnet-kit-keys-'));
    repo = path.join(tmp, 'repo');
    outside = path.join(tmp, 'keys');
    fs.mkdirSync(repo);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('isInside handles equal, nested and sibling paths', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
  });

  it('refuses a key inside the repo, including through a symlink', () => {
    expect(() => assertOutsideRepo(path.join(repo, 'k.json'), 'keypair', repo)).toThrow(KitError);
    fs.symlinkSync(repo, path.join(tmp, 'link'));
    expect(() => assertOutsideRepo(path.join(tmp, 'link', 'new', 'k.json'), 'keypair', repo)).toThrow(
      /inside the repository/,
    );
    expect(assertOutsideRepo(path.join(outside, 'k.json'), 'keypair', repo)).toBe(
      path.join(fs.realpathSync(tmp), 'keys', 'k.json'),
    );
  });

  it('creates keys 0600 once and reads them back', () => {
    const folder = new KeyFolder(outside, repo);
    const a = folder.getOrCreate('admin');
    expect(folder.getOrCreate('admin').publicKey.equals(a.publicKey)).toBe(true);
    expect(fs.statSync(folder.path('admin')).mode & 0o777).toBe(0o600);
    expect(readKeypair(folder.path('admin'), repo).publicKey.equals(a.publicKey)).toBe(true);
  });

  it('rejects bad names, missing files and malformed keypairs', () => {
    const folder = new KeyFolder(outside, repo);
    expect(() => folder.path('../x')).toThrow(KitError);
    expect(() => folder.get('nobody')).toThrow(/does not exist/);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'bad.json'), '[1,2,3]');
    expect(() => folder.get('bad')).toThrow(/64-byte/);
  });

  it('refuses a key folder inside the repo', () => {
    expect(() => new KeyFolder(path.join(repo, 'keys'), repo)).toThrow(/key folder/);
  });
});
