"use client";
// Small building blocks shared by the three pages: numbers with a source tooltip, tiny prices with subscript zeros,
// key/value grids (the Wealthsimple "Market details" pattern), KPI pairs (the Kraken Pro strip), section headings and
// the loading / empty / unavailable / error states every block needs.

import { AlertTriangle, CircleSlash, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorText, isApiError } from "@/lib/api/client";
import { priceParts } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A value with a tooltip (its source and time). Focusable so keyboard users get the tooltip too. */
export function Tip({ tip, children, className }: { tip: ReactNode; children: ReactNode; className?: string }) {
  if (!tip) return <span className={className}>{children}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={cn("cursor-help rounded-sm outline-offset-2", className)} />}>{children}</TooltipTrigger>
      <TooltipContent className="max-w-80 flex-col items-start text-left leading-relaxed">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Mono, tabular number. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("num", className)}>{children}</span>;
}

/** A SOL-per-token price: 0.0₆580362 with the zero count as a real <sub> (fun-launch's DigitSubscript). */
export function PriceText({ value, className, unit }: { value: number | null | undefined; className?: string; unit?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cn("num", className)}>—</span>;
  const p = priceParts(value);
  if (p.kind === "plain") {
    return (
      <span className={cn("num whitespace-nowrap", className)}>
        {p.text}
        {unit ? <span className="text-unit ml-1 text-ep-muted">{unit}</span> : null}
      </span>
    );
  }
  return (
    <span className={cn("num whitespace-nowrap", className)}>
      <span className="sr-only">{value.toLocaleString("en-US", { maximumSignificantDigits: 6 })}</span>
      <span aria-hidden>
        {p.sign}0.0<sub className="text-sub">{p.zeros}</sub>
        {p.digits}
      </span>
      {unit ? <span className="text-unit ml-1 text-ep-muted">{unit}</span> : null}
    </span>
  );
}

/** A label-caps label over a mono value (Kraken Pro strip / Wealthsimple details). */
export function KeyValue({
  label,
  value,
  sub,
  tip,
  className,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tip?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <dt className="label-caps truncate">{label}</dt>
      <dd className={cn("num truncate text-base text-ep-text", valueClassName)}>{tip ? <Tip tip={tip}>{value}</Tip> : value}</dd>
      {sub ? <dd className="truncate text-xs text-ep-muted">{sub}</dd> : null}
    </div>
  );
}

/** A grid of KeyValue pairs: 4 columns on wide screens, 2 on phones. */
export function KeyValueGrid({ children, className, cols = 4 }: { children: ReactNode; className?: string; cols?: 2 | 3 | 4 | 6 }) {
  const grid = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4", 6: "sm:grid-cols-3 lg:grid-cols-6" }[cols];
  return <dl className={cn("grid grid-cols-2 gap-x-6 gap-y-5", grid, className)}>{children}</dl>;
}

export function SectionHeading({
  title,
  id,
  description,
  action,
  className,
  as: As = "h2",
}: {
  title: ReactNode;
  id?: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  as?: "h2" | "h3";
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <As id={id} className={cn("font-semibold text-ep-text", As === "h2" ? "text-xl" : "text-base")}>
          {title}
        </As>
        {description ? <p className="mt-1 max-w-3xl text-sm text-ep-text-2">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A block that could not be read: "Couldn't load … — Retry". Keeps the last good data visible elsewhere. */
export function ErrorCard({ error, what, onRetry, className }: { error: unknown; what: string; onRetry?: () => void; className?: string }) {
  const code = isApiError(error) ? error.code : null;
  const trace = isApiError(error) ? error.traceId : undefined;
  return (
    <div role="alert" className={cn("flex flex-col gap-3 rounded-lg border border-ep-warn-line bg-ep-warn-soft p-4 sm:flex-row sm:items-center", className)}>
      <AlertTriangle className="size-5 shrink-0 text-ep-warn" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-ep-text">Couldn&apos;t load {what}</p>
        <p className="text-ep-text-2">
          {errorText(error)}
          {code ? <span className="num ml-2 text-xs text-ep-muted">{code}</span> : null}
          {trace ? <span className="num ml-2 text-xs text-ep-muted">trace {trace.slice(0, 8)}</span> : null}
        </p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Unavailable is not empty: the block could not be read, so no zeros are shown. */
export function Unavailable({ title = "Not available right now", body, className }: { title?: string; body?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border border-dashed border-ep-line-strong p-4 text-sm", className)}>
      <CircleSlash className="mt-0.5 size-4 shrink-0 text-ep-muted" aria-hidden />
      <div>
        <p className="font-medium text-ep-text-2">{title}</p>
        {body ? <p className="mt-0.5 text-ep-muted">{body}</p> : null}
      </div>
    </div>
  );
}

export function EmptyBlock({ title, body, action, className }: { title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ep-line p-8 text-center", className)}>
      <p className="font-medium text-ep-text-2">{title}</p>
      {body ? <p className="max-w-md text-sm text-ep-muted">{body}</p> : null}
      {action}
    </div>
  );
}

/** Skeleton rows in the shape of a table. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** A card shell used by every block: surface, hairline border, 12 px radius, 20 px padding. */
export function Panel({ children, className, as: As = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" } & Record<string, unknown>) {
  return (
    <As className={cn("rounded-lg border border-ep-line bg-ep-surface p-5", className)} {...rest}>
      {children}
    </As>
  );
}
