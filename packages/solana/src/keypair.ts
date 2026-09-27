import fs from 'fs';
import os from 'os';

import { ConfigException } from '@epoch/exceptions';
import { Keypair } from '@solana/web3.js';

/** Loads a Solana CLI keypair file. Keypairs must live outside the repo. */
export function loadKeypair(path: string): Keypair {
  const resolved = path.replace(/^~/, os.homedir());
  if (!fs.existsSync(resolved)) throw new ConfigException(`Keypair file not found: ${resolved}`);
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(resolved, 'utf8')) as number[]);
  return Keypair.fromSecretKey(secret);
}
