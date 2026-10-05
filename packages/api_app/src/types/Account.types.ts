// Response shapes for sign-in, the watchlist, alerts and Predict (requests #7, #11, #14, #15). They mirror the
// frontend contract (handover contracts/epoch-data.ts). New to the contract: `SiwsNonce`, `SessionView`,
// `TelegramLink`, `AlertTestResult` and `PredictLeaderboard` (GET /v1/predict/leaderboard).

import type { Role } from '../Lib/Session';
import type { Meta } from './Api.types';

// ── Sign-in (request #7) ─────────────────────────────── POST /v1/auth/siws/nonce · verify · logout · GET session
/** POST /v1/auth/siws/nonce: what the app puts in its `signIn()` input (domain = `window.location.host`). */
export interface SiwsNonce {
  /** Alphanumeric, single use, expires at `expirationTime`. */
  nonce: string;
  statement: string;
  /** ISO 8601 (IST). */
  issuedAt: string;
  /** ISO 8601 (IST): the nonce stops working then. */
  expirationTime: string;
  /** Hosts the message's domain may name (`SIWS_ALLOWED_DOMAINS`). */
  domains: string[];
}

/** POST /v1/auth/siws/verify and GET /v1/auth/session (null when signed out). */
export interface SessionView {
  address: string;
  /** From chain, cached 60 s: delegator (mainnet stake accounts), lender (vault shares), operator (onboarded). */
  roles: Role[];
  /** ISO 8601 (IST). */
  expiresAt: string;
}

// ── Watchlist and alerts (signed in) ───────── requests #14 and #15 · /v1/me/watchlist · /v1/me/alerts
export interface Watchlist {
  /** Vote accounts, at most 200. Signed out, the same list lives in local storage (`epoch.watchlist`). */
  votes: string[];
}
export interface AlertPrefs {
  rules: { offline: boolean; feeUp: boolean; losingMoney: boolean; rewardsLanded: boolean };
  channels: { email?: string | null; telegram?: string | null };
  /** e.g. the step-2 reminder after the first half of a stake move. */
  reminders: { kind: 'move-step-2'; epoch: number; stakeAccount: string }[];
}

/** POST /v1/me/alerts/telegram-link: open `url` in Telegram and press Start to connect the chat. */
export interface TelegramLink {
  url: string;
  code: string;
  /** ISO 8601 (IST), 15 minutes after the request. */
  expiresAt: string;
}

/** POST /v1/me/alerts/test: what happened on each channel. */
export type AlertTestStatus = 'sent' | 'skipped' | 'failed';
export interface AlertTestResult {
  email: AlertTestStatus;
  telegram: AlertTestStatus;
}

// ── Predict ─── points mode (decisions 2 and 3, 1 Oct) · GET /v1/predict/markets, GET /v1/predict/leaderboard,
//               POST /v1/predict/calls
// Points mode is the free tier: Fee Index markets, no SOL, no fee, no wallet transaction (a call needs the sign-in
// session). Real money (decision of 3 Oct 2026) is USDC through Panta at /v1/predict/panta (types/Panta.types.ts);
// the optional SOL fields below belonged to the dropped real-SOL design and are never sent.
export type CallSide = 'yes' | 'no';
/** A call puts one of these on YES or NO. */
export type CallPoints = 10 | 25 | 50 | 100;
export interface PredictMarket {
  id: string;
  question: string;
  /** 0–1 share of the pool on YES (0.5 for an empty pool). */
  yesShare: number;
  /** Points on both sides together. */
  poolPoints: number;
  /** Real-SOL path only (PREDICT_REAL_SOL, off). */
  poolSol?: number;
  players: number;
  closesAtEpoch: number;
  status: 'open' | 'closed' | 'settled';
  nowNote: string | null;
  answerSource: string;
}
export interface PredictSnapshot extends Meta {
  rules: {
    /** "points" in v1. "sol" only behind PREDICT_REAL_SOL, after legal advice. */
    mode: 'points' | 'sol';
    /** Points every signed-in wallet gets each epoch to call with; unused points do not carry over. */
    pointsPerEpoch: number;
    /** 10, 25, 50, 100. */
    callSizesPoints: CallPoints[];
    /** The signed-in wallet's points left this epoch; null when signed out or read-only. */
    pointsLeftThisEpoch: number | null;
    /** 0 in points mode: the losing side's points are shared among the winners, no fee. */
    feeBps: number | null;
    /** The leaderboard ranks net points won over this many epochs (30). */
    leaderboardEpochs: number;
    ageGate: '18+';
    regions: string;
    /** Real-SOL path only (PREDICT_REAL_SOL, off). */
    capPerCallSol?: number;
    amountChipsSol?: number[];
  };
  payoutFormula: string;
  markets: PredictMarket[];
  myCalls: {
    label: string;
    side: CallSide;
    points: CallPoints;
    /** "refunded": nobody called the winning side, so every call in the market came back (decision 23). */
    status: 'open' | 'settling' | 'won' | 'lost' | 'refunded';
    /** Open or settling: what the call returns if right, at the current pool. */
    estPayoutPoints: number | null;
    /** Won, lost or refunded: points back minus points called (0 when refunded). Leaderboard only. */
    netPoints: number | null;
    /** Real-SOL path only (PREDICT_REAL_SOL, off). */
    amountSol?: number;
    estPayoutSol?: number | null;
    pnlSol?: number | null;
  }[];
  /** The top 10 of GET /v1/predict/leaderboard: net points won over the last `rules.leaderboardEpochs` epochs. */
  leaderboard: PredictLeaderboardRow[];
}
/** POST /v1/predict/calls, sent with the sign-in session cookie. No wallet transaction. */
export interface PredictCallRequest {
  marketId: string;
  side: CallSide;
  points: CallPoints;
}

/** One wallet on the leaderboard. Refunded calls count in `calls` but not in `hitPct`. */
export interface PredictLeaderboardRow {
  rank: number;
  walletShort: string;
  netPoints: number;
  /** Won ÷ (won + lost) × 100, rounded; 0 when every call was refunded. */
  hitPct: number;
  calls: number;
  /** Real-SOL path only (PREDICT_REAL_SOL, off). */
  profitSol?: number;
}

/** GET /v1/predict/leaderboard?epochs=30 (new to the contract): the top 50 wallets by net points. */
export interface PredictLeaderboard extends Omit<Meta, 'note'> {
  /** Settled markets whose epoch is at least the current index epoch − `epochs`. */
  epochs: number;
  rows: PredictLeaderboardRow[];
}
