// Epoch's ring mark: an epoch as a ring that fills. Epoch's own identity (no third-party asset).
import { cn } from "@/lib/utils";

export function EpochMark({ className, progress = 0.72 }: { className?: string; progress?: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6", className)} aria-hidden>
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--ep-line-strong)" strokeWidth="3" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke="var(--ep-accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${c * progress} ${c}`}
        transform="rotate(-90 12 12)"
      />
      <circle cx="12" cy="12" r="2.5" fill="var(--ep-accent)" />
    </svg>
  );
}
