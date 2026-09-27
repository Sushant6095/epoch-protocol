/**
 * Loads environment variables before any other module reads them.
 *
 * Usage: `node dist/index.js --env .env.devnet` (defaults to `.env`).
 * Looks for the file in the current directory first, then the repo root.
 */
import fs from 'fs';
import path from 'path';

import * as dotenv from 'dotenv';

export function getArg(flags: string[], argv: string[] = process.argv.slice(2)): string | undefined {
  const index = argv.findIndex((arg) => flags.includes(arg));
  return index >= 0 ? argv[index + 1] : undefined;
}

export function loadEnv(argv: string[] = process.argv.slice(2)): string | undefined {
  const fileName = getArg(['--env', '-e'], argv) ?? '.env';
  const candidates = [path.resolve(process.cwd(), fileName), path.resolve(__dirname, '../../../', fileName)];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) {
    dotenv.config({ path: found, quiet: true });
  }
  return found;
}
