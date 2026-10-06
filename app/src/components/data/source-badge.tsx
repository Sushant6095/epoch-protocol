"use client";
// The badges that keep the "never show sample or stale data as live" rule visible: Sample (warn), Live (accent dot,
// only for API data the server itself calls live), Stale / Delayed (muted, with the time it was read).

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApiStatus } from "@/lib/api/status";
import type { DataSource } from "@/lib/data/query";
import { cn } from "@/lib/utils";
import { fmtDateTimeIst, fmtTimeIst } from "@/lib/format";

export function SampleBadge({ note, className }: { note?: string; className?: string }) {
  const reason = useApiStatus((s) => s.reason);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className={cn("h-6 cursor-help border-ep-warn-line bg-ep-warn-soft px-2 font-mono text-xs uppercase tracking-wider text-ep-warn", className)}
            tabIndex={0}
          />
        }
      >
        Sample
      </TooltipTrigger>
      <TooltipContent className="max-w-72 flex-col items-start text-left">
        <span>{reason ?? "Sample data, not live."}</span>
        {note ? <span className="text-ep-muted">{note}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function LiveDot({ on, className }: { on: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0 rounded-full", on ? "bg-ep-accent" : "bg-ep-muted", className)}>
      {on ? <span className="absolute inset-0 rounded-full bg-ep-accent motion-safe:animate-ep-pulse" /> : null}
    </span>
  );
}

export function LiveBadge({ label = "Live", detail, className }: { label?: string; detail?: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("h-6 gap-1.5 border-ep-accent-line bg-ep-accent-soft px-2 font-mono text-xs uppercase tracking-wider text-ep-accent", className)}>
      <LiveDot on />
      {label}
      {detail ? <span className="normal-case tracking-normal text-ep-text-2">· {detail}</span> : null}
    </Badge>
  );
}

export function StaleBadge({ asOf, word = "Stale", className }: { asOf: string | null | undefined; word?: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="outline" tabIndex={0} className={cn("h-6 cursor-help gap-1.5 border-ep-line-strong px-2 font-mono text-xs text-ep-muted", className)} />}
      >
        <LiveDot on={false} />
        {word} · as of {fmtTimeIst(asOf)}
      </TooltipTrigger>
      <TooltipContent>The last good answer, read {fmtDateTimeIst(asOf)}. Not live.</TooltipContent>
    </Tooltip>
  );
}

/** A block the API could not read this time: no value is shown as current. */
export function UnavailableBadge({ label = "Not available right now", detail, className }: { label?: string; detail?: string; className?: string }) {
  const badge = <Badge variant="outline" className={cn("h-6 gap-1.5 border-dashed border-ep-line-strong px-2 font-mono text-xs text-ep-muted", className)}>{label}</Badge>;
  if (!detail) return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex cursor-help rounded-sm" />}>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-72">{detail}</TooltipContent>
    </Tooltip>
  );
}

/** One badge for a block: Sample beats everything; then Unavailable; then Stale/Delayed; then Live only when the payload says so. */
export function DataStatus({
  source,
  live,
  stale,
  asOf,
  staleWord,
  liveLabel,
  liveDetail,
  sampleNote,
  idleLabel,
  unavailable,
  unavailableLabel,
  unavailableDetail,
}: {
  source: DataSource | undefined;
  live?: boolean | null;
  stale?: boolean | null;
  asOf?: string | null;
  staleWord?: string;
  liveLabel?: string;
  liveDetail?: string;
  sampleNote?: string;
  /** Shown for API data that is neither live nor stale (e.g. "Updated 19:08 IST"). */
  idleLabel?: string;
  /** The block was never read (or could not be read this time): say so instead of "stale". */
  unavailable?: boolean | null;
  unavailableLabel?: string;
  unavailableDetail?: string;
}) {
  if (!source) return null;
  if (source === "sample") return <SampleBadge note={sampleNote} />;
  if (unavailable) return <UnavailableBadge label={unavailableLabel} detail={unavailableDetail} />;
  if (stale) return <StaleBadge asOf={asOf} word={staleWord} />;
  if (live) return <LiveBadge label={liveLabel} detail={liveDetail} />;
  return (
    <Badge variant="outline" className="h-6 border-ep-line-strong px-2 font-mono text-xs text-ep-muted">
      {idleLabel ?? `Updated ${fmtTimeIst(asOf)}`}
    </Badge>
  );
}
