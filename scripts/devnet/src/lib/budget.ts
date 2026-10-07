/**
 * SOL arithmetic for the budget: rent from the target cluster's own rate (devnet charges 5,080 lamports per byte since
 * SIMD-0437, mainnet 6,960), the upgradeable loader's account sizes, and transaction fees. Pure functions; the
 * `budget` command feeds them the cluster's numbers.
 */

/** Bytes the runtime adds to every account for rent purposes. */
export const ACCOUNT_STORAGE_OVERHEAD = 128;
/** Upgradeable loader: ProgramData header (enum tag + slot + Option<authority>). */
export const PROGRAMDATA_HEADER = 45;
/** Upgradeable loader: Program account (enum tag + programdata address). */
export const PROGRAM_ACCOUNT_SIZE = 36;
/** Upgradeable loader: Buffer header (enum tag + Option<authority>). */
export const BUFFER_HEADER = 37;
export const SIGNATURE_FEE = 5_000n;
/**
 * Program bytes per buffer-write transaction: one 1,232-byte packet minus the signature, message header, three keys,
 * the blockhash, the Write instruction's header and the compute-budget instructions the CLI adds with a priority fee.
 * The rehearsal measures the real count; this is the planning figure.
 */
export const WRITE_CHUNK_BYTES = 1_000;
/** Compute units a buffer write uses (the CLI simulates and sets a limit close to this). */
export const WRITE_COMPUTE_UNITS = 2_000;

export type RentFn = (dataLen: number) => bigint;

/** Rent-exempt minimum for a data length, from the cluster's lamports per byte (rent(0) / 128). */
export function rentFromPerByte(lamportsPerByte: bigint): RentFn {
  return (dataLen: number) => (BigInt(dataLen) + BigInt(ACCOUNT_STORAGE_OVERHEAD)) * lamportsPerByte;
}

export function perByteFromRentOfZero(rentOfZero: bigint): bigint {
  if (rentOfZero % BigInt(ACCOUNT_STORAGE_OVERHEAD) !== 0n) {
    throw new RangeError(`rent(0) = ${rentOfZero} is not a multiple of ${ACCOUNT_STORAGE_OVERHEAD}`);
  }
  return rentOfZero / BigInt(ACCOUNT_STORAGE_OVERHEAD);
}

/** Priority fee of one transaction: compute-unit price (micro-lamports) × units, rounded up to a lamport. */
export function priorityFee(microLamportsPerCu: bigint, computeUnits: number): bigint {
  return (microLamportsPerCu * BigInt(computeUnits) + 999_999n) / 1_000_000n;
}

export function txFee(signatures: number, microLamportsPerCu = 0n, computeUnits = 200_000): bigint {
  return SIGNATURE_FEE * BigInt(signatures) + priorityFee(microLamportsPerCu, computeUnits);
}

export interface BudgetLine {
  stage: string;
  item: string;
  lamports: bigint;
  /** Comes back later (deposits, bonds, collateral, refunded buffers): still has to be sent. */
  recoverable?: boolean;
  /** Needed only during the stage and refunded at its end (the deploy buffer): counts toward the peak only. */
  temporary?: boolean;
  note?: string;
}

export interface DeployInputs {
  soLen: number;
  maxLen: number;
  rent: RentFn;
  microLamportsPerCu?: bigint;
}

/** Deploy through a buffer: write transactions, then one deploy transaction (payer, program keypair). */
export function deployLines({ soLen, maxLen, rent, microLamportsPerCu = 0n }: DeployInputs): BudgetLine[] {
  if (!Number.isInteger(soLen) || soLen <= 0) throw new RangeError('soLen must be a positive integer');
  if (maxLen < soLen) throw new RangeError(`--max-len ${maxLen} is smaller than the program (${soLen} bytes)`);
  const writes = Math.ceil(soLen / WRITE_CHUNK_BYTES);
  return [
    {
      stage: 'deploy',
      item: `program data (${PROGRAMDATA_HEADER} + max-len ${maxLen} bytes)`,
      lamports: rent(PROGRAMDATA_HEADER + maxLen),
    },
    { stage: 'deploy', item: `program account (${PROGRAM_ACCOUNT_SIZE} bytes)`, lamports: rent(PROGRAM_ACCOUNT_SIZE) },
    {
      stage: 'deploy',
      item: `buffer (${BUFFER_HEADER} + ${soLen} bytes), refunded by the deploy`,
      lamports: rent(BUFFER_HEADER + soLen),
      temporary: true,
    },
    {
      stage: 'deploy',
      item: `≈ ${writes} buffer writes + create buffer + deploy`,
      lamports: txFee(1, microLamportsPerCu, WRITE_COMPUTE_UNITS) * BigInt(writes) + txFee(2, microLamportsPerCu) * 2n,
    },
  ];
}

export interface BudgetTotals {
  /** What leaves the wallet for good (rent kept by accounts, fees). */
  spent: bigint;
  /** Sent but recoverable later. */
  recoverable: bigint;
  /**
   * Needed at the busiest moment. Stages run in the order of `lines`; a temporary item (the deploy buffer) is refunded
   * when its stage ends, so it adds to what is committed up to the end of its own stage, not to later stages.
   */
  peak: bigint;
}

export function totals(lines: BudgetLine[]): BudgetTotals {
  let spent = 0n;
  let recoverable = 0n;
  let peak = 0n;
  const stages = [...new Set(lines.map((l) => l.stage))];
  for (const stage of stages) {
    let temporary = 0n;
    for (const l of lines.filter((x) => x.stage === stage)) {
      if (l.temporary) temporary = l.lamports > temporary ? l.lamports : temporary;
      else if (l.recoverable) recoverable += l.lamports;
      else spent += l.lamports;
    }
    const committed = spent + recoverable;
    if (committed + temporary > peak) peak = committed + temporary;
  }
  return { spent, recoverable, peak };
}

/** Lamports → "1.234567890" (exact, no float). */
export function sol(lamports: bigint): string {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Round up to a convenient amount to send (0.1 SOL steps). */
export function roundUpSol(lamports: bigint, step = 100_000_000n): bigint {
  return ((lamports + step - 1n) / step) * step;
}
