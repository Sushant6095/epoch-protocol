/**
 * The Epoch Score, ported line for line from `programs/epoch/src/math/score.rs` so a validator's score on
 * the site matches the one the program would compute. Integer maths, as in Rust (`u32` division truncates).
 *
 * | Component     | Max   | Rule                                                                          |
 * |---------------|-------|-------------------------------------------------------------------------------|
 * | Credits       | 6,000 | ≥97% of cluster average → full; 90–97% linear 3,000→6,000; below → pro rata   |
 * | Commission    | 2,500 | ≤5% → full; 5–10% linear 2,500→1,000; >10% → 0                                |
 * | Tenure        | 1,500 | epochs active / 30, capped                                                    |
 * | Delinquent    | —     | score is 0                                                                    |
 * | Superminority | —     | capped at 5,000                                                               |
 */
export interface ScoreInputs {
  /** Vote credits as a share of the cluster average, bps (10,000 = average). Clamped to u16. */
  creditsRatioBps: number;
  /** The higher of the inflation and MEV commission, bps. */
  commissionBps: number;
  epochsActive: number;
  delinquent: boolean;
  superminority: boolean;
}

export const MAX_SCORE = 10_000;
const CREDITS_MAX = 6_000;
const COMMISSION_MAX = 2_500;
const TENURE_MAX = 1_500;
const SUPERMINORITY_CAP = 5_000;
const TENURE_FULL_EPOCHS = 30;

const u16 = (value: number): number => Math.min(65_535, Math.max(0, Math.floor(value)));

/** 0–10,000. */
export function computeScore(input: ScoreInputs): number {
  if (input.delinquent) return 0;
  const credits = u16(input.creditsRatioBps);
  let creditsPts: number;
  if (credits >= 9_700) creditsPts = CREDITS_MAX;
  else if (credits >= 9_000) creditsPts = 3_000 + Math.floor(((credits - 9_000) * 3_000) / 700);
  else creditsPts = Math.floor((credits * 3_000) / 9_000);

  const commission = u16(input.commissionBps);
  let commissionPts: number;
  if (commission <= 500) commissionPts = COMMISSION_MAX;
  else if (commission <= 1_000) commissionPts = 2_500 - Math.floor(((commission - 500) * 1_500) / 500);
  else commissionPts = 0;

  const tenurePts = Math.floor(
    (Math.min(u16(input.epochsActive), TENURE_FULL_EPOCHS) * TENURE_MAX) / TENURE_FULL_EPOCHS,
  );

  let score = creditsPts + commissionPts + tenurePts;
  if (input.superminority) score = Math.min(score, SUPERMINORITY_CAP);
  return Math.min(score, MAX_SCORE);
}

/** The 0–100 figure the UI shows. */
export const displayScore = (score: number): number => Math.round(score / 100);
