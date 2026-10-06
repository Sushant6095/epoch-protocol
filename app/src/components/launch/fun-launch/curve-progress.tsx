// Adapted from Meteora's fun-launch scaffold (MIT, Copyright (c) 2025 Meteora; see app/THIRD-PARTY-NOTICES.md):
// `components/TokenHeader/BondingCurve.tsx`, the curve-progress label and bar. Changed: Epoch tokens and words
// ("raise", "graduates"), the raise in SOL beside the percentage, a real progressbar role, and a graduated state
// instead of hiding at 100%.

import { fmtPct, fmtSolValue } from "@/lib/format";
import { cn } from "@/lib/utils";

export function CurveProgress({
  progressPct,
  raisedSol,
  targetSol,
  graduated,
  className,
  size = "md",
}: {
  progressPct: number;
  raisedSol: number;
  targetSol: number;
  graduated?: boolean;
  className?: string;
  size?: "sm" | "md";
}) {
  const pct = Math.max(0, Math.min(100, progressPct));
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-2 text-xs text-ep-muted">
        <span>{graduated ? "Raise complete" : "Curve"}</span>
        <span className="num text-ep-text-2">{fmtPct(pct, pct < 10 ? 2 : 1)}</span>
        <span className="num ml-auto">
          {fmtSolValue(raisedSol)} of {fmtSolValue(targetSol)} SOL
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={`Raise ${fmtPct(pct, 1)}: ${fmtSolValue(raisedSol)} of ${fmtSolValue(targetSol)} SOL`}
        className={cn("w-full overflow-hidden rounded-full bg-ep-line", size === "sm" ? "h-1" : "h-1.5")}
      >
        <div className={cn("h-full rounded-full", graduated ? "bg-ep-info" : "bg-ep-accent")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
