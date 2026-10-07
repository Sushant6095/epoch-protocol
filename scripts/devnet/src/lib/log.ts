/** Console output for the kit's commands, with times in IST (the team's working zone). */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `2026-10-07 18:35 IST` for a time in milliseconds since the epoch. */
export function ist(ms: number = Date.now()): string {
  return `${new Date(ms + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16)} IST`;
}

export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function step(line: string): void {
  out(`[${ist().slice(11, 16)}] ${line}`);
}

export function warn(line: string): void {
  process.stderr.write(`warning: ${line}\n`);
}
