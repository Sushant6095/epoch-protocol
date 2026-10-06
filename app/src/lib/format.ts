// Number, unit, time and key formatting. Rules (handover/03-DESIGN-SYSTEM.md "Numbers"): a missing value is "—",
// never 0; signs on every change with a true minus sign; SOL with 2 decimals at ≥ 1 and 2–4 under 1; prices are SOL
// per token with 6 significant digits (tiny prices with subscript zeros, the fun-launch scaffold's notation); every
// time is IST.

export const DASH = "—";
const MINUS = "−";

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Parse a decimal string (USDC amounts come as strings) to a number, or null. */
export function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const cache = new Map<string, Intl.NumberFormat>();
function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", options);
    cache.set(key, f);
  }
  return f;
}

const withMinus = (s: string) => s.replace(/^-/, MINUS);

/** 12,092 */
export function fmtInt(v: number | null | undefined): string {
  return isNum(v) ? withMinus(nf({ maximumFractionDigits: 0 }).format(v)) : DASH;
}

/** Epoch and slot-like ordinals read as names: "1048", never "1,048". */
export function fmtEpoch(v: number | null | undefined): string {
  return isNum(v) ? String(Math.trunc(v)) : DASH;
}

/** A plain number with a fixed range of decimals. */
export function fmtNum(v: number | null | undefined, max = 2, min = 0): string {
  return isNum(v) ? withMinus(nf({ minimumFractionDigits: min, maximumFractionDigits: max }).format(v)) : DASH;
}

/** 212.9M · 1.2k */
export function fmtCompact(v: number | null | undefined, digits = 1): string {
  return isNum(v) ? withMinus(nf({ notation: "compact", maximumFractionDigits: digits }).format(v)) : DASH;
}

/** SOL amount without the unit: 1,124 · 1.25 · 0.0198 · 0.00016 */
export function fmtSolValue(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1) return withMinus(nf({ maximumFractionDigits: 2 }).format(v));
  if (abs >= 0.001) return withMinus(nf({ minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v));
  return withMinus(nf({ maximumSignificantDigits: 3 }).format(v));
}

/** "1.25 SOL" */
export function fmtSol(v: number | null | undefined): string {
  return isNum(v) ? `${fmtSolValue(v)} SOL` : DASH;
}

/** Token amounts (UI units): 89,402.42 · 3,069.47 · 913,465 */
export function fmtTokens(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 100_000) return withMinus(nf({ maximumFractionDigits: 0 }).format(v));
  if (abs >= 1) return withMinus(nf({ maximumFractionDigits: 2 }).format(v));
  return withMinus(nf({ maximumSignificantDigits: 4 }).format(v));
}

export type PriceParts =
  | { kind: "plain"; text: string }
  | { kind: "subscript"; sign: string; zeros: number; digits: string };

/**
 * A price with 6 significant digits. Under 0.001 the run of zeros after the point is written as a subscript count
 * (5.80362e-7 → 0.0₆580362), the notation of Meteora's fun-launch scaffold (ReadableNumber / DigitSubscript).
 */
export function priceParts(v: number, significant = 6): PriceParts {
  const abs = Math.abs(v);
  const sign = v < 0 ? MINUS : "";
  if (abs === 0 || abs >= 0.001) {
    return { kind: "plain", text: withMinus(nf({ maximumSignificantDigits: significant }).format(v)) };
  }
  const exponent = Math.floor(Math.log10(abs)); // e.g. -7 for 5.8e-7
  const zeros = -exponent - 1; // zeros between the point and the first significant digit
  const mantissa = abs / 10 ** exponent; // 5.80362
  const digits = mantissa.toFixed(significant - 1).replace(".", "").replace(/0+$/, "") || "0";
  return { kind: "subscript", sign, zeros, digits };
}

/** The same price as plain text: "0.0₆580362" with Unicode subscripts (for titles, tooltips and aria-labels). */
export function fmtPrice(v: number | null | undefined, significant = 6): string {
  if (!isNum(v)) return DASH;
  const p = priceParts(v, significant);
  if (p.kind === "plain") return p.text;
  const sub = String(p.zeros)
    .split("")
    .map((d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)])
    .join("");
  return `${p.sign}0.0${sub}${p.digits}`;
}

/** "49.9%" from a 0–100 percentage. */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  return isNum(v) ? `${withMinus(nf({ maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v))}%` : DASH;
}

/** "+2.94%" / "−1.2%" from a 0–100 percentage change, sign always shown. */
export function fmtSignedPct(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return DASH;
  const body = nf({ maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Math.abs(v));
  return `${v > 0 ? "+" : v < 0 ? MINUS : "±"}${body}%`;
}

/** "62%" from a 0–1 probability or price. */
export function fmtProb(v: number | null | undefined, digits = 0): string {
  return isNum(v) ? `${nf({ maximumFractionDigits: digits }).format(v * 100)}%` : DASH;
}

/** "0.62" USDC per share from a 0–1 price. */
export function fmtSharePrice(v: number | null | undefined): string {
  return isNum(v) ? nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v) : DASH;
}

/** USDC decimal strings: "1,240.00". */
export function fmtUsdc(v: string | number | null | undefined, digits = 2): string {
  const n = toNum(v);
  return n === null ? DASH : withMinus(nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n));
}

/** "$335.38" */
export function fmtUsd(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  if (Math.abs(v) < 0.01) return `$${nf({ maximumSignificantDigits: 3 }).format(v)}`;
  return withMinus(nf({ style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v));
}

/** µL/CU values: 12,092. */
export function fmtCu(v: number | null | undefined): string {
  return fmtInt(v);
}

/** Axis ticks for µL/CU on a log scale: 1k · 10k · 562k. */
export function fmtCuTick(v: number): string {
  if (v >= 1_000_000) return `${nf({ maximumFractionDigits: 1 }).format(v / 1_000_000)}M`;
  if (v >= 1_000) return `${nf({ maximumFractionDigits: 1 }).format(v / 1_000)}k`;
  return nf({ maximumFractionDigits: 0 }).format(v);
}

/** 1.2 GB */
export function fmtBytes(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${nf({ maximumFractionDigits: i === 0 ? 0 : 1 }).format(n)} ${units[i]}`;
}

/** "HEL1…e2TU" */
export function shortKey(key: string | null | undefined, head = 4, tail = 4): string {
  if (!key) return DASH;
  if (key.length <= head + tail + 1) return key;
  return `${key.slice(0, head)}…${key.slice(-tail)}`;
}

// ── Time (IST) ────────────────────────────────────────────────────────────────────────────────────────

const IST = "Asia/Kolkata";
const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: IST, ...o });
const timeF = dtf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const timeSecF = dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dayF = dtf({ day: "numeric", month: "short" });
const dateF = dtf({ day: "numeric", month: "short", year: "numeric" });

const parse = (iso: string | number | Date | null | undefined): Date | null => {
  if (iso === null || iso === undefined || iso === "") return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "19:08 IST" */
export function fmtTimeIst(iso: string | number | Date | null | undefined): string {
  const d = parse(iso);
  return d ? `${timeF.format(d)} IST` : DASH;
}

/** "19:08:39 IST" */
export function fmtTimeSecIst(iso: string | number | Date | null | undefined): string {
  const d = parse(iso);
  return d ? `${timeSecF.format(d)} IST` : DASH;
}

/** "5 Oct, 22:47 IST" */
export function fmtDateTimeIst(iso: string | number | Date | null | undefined): string {
  const d = parse(iso);
  return d ? `${dayF.format(d)}, ${timeF.format(d)} IST` : DASH;
}

/** "5 Oct 2026" */
export function fmtDateIst(iso: string | number | Date | null | undefined): string {
  const d = parse(iso);
  return d ? dateF.format(d) : DASH;
}

/** Seconds since an instant (never negative). */
export function secondsSince(iso: string | number | Date | null | undefined, now = Date.now()): number | null {
  const d = parse(iso);
  return d ? Math.max(0, Math.round((now - d.getTime()) / 1000)) : null;
}

/** "just now" · "4 s ago" · "3 min ago" · "2 h ago" · "3 d ago" */
export function fmtAgo(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return DASH;
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${Math.round(seconds)} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** "1 d 11 h" · "42 min" · "6 s" */
export function fmtDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** Countdown to a future instant: "2 h 14 min", or "now" once it has passed. */
export function fmtCountdown(iso: string | null | undefined, now = Date.now()): string {
  const d = parse(iso);
  if (!d) return DASH;
  const s = Math.round((d.getTime() - now) / 1000);
  return s <= 0 ? "now" : fmtDuration(s);
}

/** Bps → "5%" (shares) */
export function fmtBps(v: number | null | undefined): string {
  return isNum(v) ? fmtPct(v / 100, 2) : DASH;
}

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
