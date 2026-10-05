import { type MarketWindow } from './EpochSchedule';

/**
 * The words of a Fee Index market. Panta derives a market's address from the creator wallet and the exact `question`,
 * so the question depends on (epoch, threshold) only and must never change for them: re-quoting after a crash then
 * either reuses the same market slot or gets DUPLICATE_MARKET, never a second market. It is ASCII on purpose. The
 * title is deterministic too (crash recovery finds our market in Panta's catalog by it). Limits: question ≤ 512,
 * resolution rule ≤ 2,048, 1–20 sources (https://docs.panta.market/api-reference/markets/quote.md).
 */

export interface FeeIndexAccountRef {
  /** The Epoch program's FeeIndex PDA. */
  address: string;
  cluster: 'localnet' | 'devnet' | 'testnet' | 'mainnet';
}

export interface MarketTextInput {
  epoch: number;
  /** µL/CU. */
  threshold: number;
  window: MarketWindow;
  /** Epoch's public API base, https. */
  publicApiUrl: string;
  methodologyUrl: string;
  /** Null when EPOCH_PROGRAM_ID is unknown (dry runs only: live creation requires it). */
  feeIndexAccount: FeeIndexAccountRef | null;
  /** No final value this long after `window.resolutionTime` → NO. */
  graceHours: number;
  /** The last finished epoch, for the description. */
  reference: { epoch: number; value: number } | null;
}

export interface MarketText {
  question: string;
  title: string;
  description: string;
  resolutionRule: string;
  sourcesOfTruth: string[];
}

export const MAX_QUESTION = 512;
export const MAX_RULE = 2_048;

const thousands = (value: number): string => value.toLocaleString('en-US');
/** `2026-10-12T06:00:00Z`. */
export const utcIso = (unixSeconds: number): string =>
  new Date(unixSeconds * 1_000).toISOString().replace('.000Z', 'Z');
/** `2026-10-12 06:00`, for prose. */
const utcShort = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** Where a market resolves: Epoch's per-epoch index endpoint (`GET /v1/index/epochs/:epoch`). */
export const resolutionUrl = (publicApiUrl: string, epoch: number): string =>
  `${publicApiUrl.replace(/\/+$/, '')}/v1/index/epochs/${epoch}`;

/** The FeeIndex account on the Solana Explorer, on its cluster. */
export function explorerUrl(account: FeeIndexAccountRef): string {
  const base = `https://explorer.solana.com/address/${account.address}`;
  if (account.cluster === 'mainnet') return base;
  return `${base}?cluster=${account.cluster === 'localnet' ? 'custom' : account.cluster}`;
}

export const marketQuestion = (epoch: number, threshold: number): string =>
  `Will the Solana Fee Index for epoch ${epoch} close above ${thousands(threshold)} micro-lamports per CU?`;

export const marketTitle = (epoch: number, threshold: number): string =>
  `Solana Fee Index above ${thousands(threshold)} µL/CU in epoch ${epoch}`;

export function resolutionRule(input: MarketTextInput): string {
  const { epoch, threshold, window } = input;
  const x = thousands(threshold);
  const deadline = utcIso(window.resolutionTime + input.graceHours * 3_600);
  const account = input.feeIndexAccount
    ? `Epoch's on-chain FeeIndex account ${input.feeIndexAccount.address} (Solana ${input.feeIndexAccount.cluster})`
    : `Epoch's on-chain FeeIndex account`;
  return [
    `Resolves YES if the final Solana Fee Index for Solana mainnet epoch ${epoch} is strictly greater than ${x}`,
    `micro-lamports per compute unit (µL/CU); otherwise NO. A value equal to ${x} resolves NO.`,
    `The Fee Index of an epoch is the stake-weighted median, across that epoch's slot leaders, of each leader's median`,
    `priority fee per compute unit, excluding transactions whose fee payer is the slot leader. Methodology:`,
    `${input.methodologyUrl}.`,
    `Source: ${resolutionUrl(input.publicApiUrl, epoch)} returns JSON with data.epoch, data.value (µL/CU) and`,
    `data.status. Only a value with data.status "final" counts: it was posted to ${account} and its dispute window`,
    `passed without a veto. "pending", "computed" and "proposed" values are not final.`,
    `If the value for epoch ${epoch} is vetoed, the market resolves from the corrected value for the same epoch once it`,
    `is final. If no final value for epoch ${epoch} is published by ${deadline} UTC, the market resolves NO.`,
    `Epoch ${epoch} is mainnet slots ${window.firstSlot} to ${window.lastSlot}; trading closes before it starts.`,
  ].join(' ');
}

export function marketDescription(input: MarketTextInput): string {
  const { epoch, threshold, window, reference } = input;
  const last = reference ? ` Epoch ${reference.epoch} closed at ${thousands(reference.value)} µL/CU.` : '';
  return (
    `Epoch publishes the Solana Fee Index every epoch: the stake-weighted median priority fee per compute unit paid ` +
    `on Solana, leader-paid transactions excluded. Will epoch ${epoch} (expected ${utcShort(window.estStartMs)} to ` +
    `${utcShort(window.estEndMs)} UTC) close above ${thousands(threshold)} µL/CU?${last} Trading closes before ` +
    `epoch ${epoch} starts; the market resolves from Epoch's public index endpoint once the value is final on chain. ` +
    `Validators can use it to hedge priority-fee revenue. Created by Epoch, the revenue desk for Solana validators.`
  );
}

export function sourcesOfTruth(input: MarketTextInput): string[] {
  const sources = [resolutionUrl(input.publicApiUrl, input.epoch), input.methodologyUrl];
  if (input.feeIndexAccount) sources.push(explorerUrl(input.feeIndexAccount));
  return sources;
}

/** Everything a create quote needs in words. Throws when Panta's length limits would be exceeded. */
export function marketText(input: MarketTextInput): MarketText {
  const text: MarketText = {
    question: marketQuestion(input.epoch, input.threshold),
    title: marketTitle(input.epoch, input.threshold),
    description: marketDescription(input),
    resolutionRule: resolutionRule(input),
    sourcesOfTruth: sourcesOfTruth(input),
  };
  if (text.question.length > MAX_QUESTION) throw new RangeError('question is longer than Panta allows (512)');
  if (text.resolutionRule.length > MAX_RULE) throw new RangeError('resolution rule is longer than Panta allows (2048)');
  return text;
}
