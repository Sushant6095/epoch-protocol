'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Database, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiConfigured } from '@/lib/data/client';
import logoMap from '@/components/epoch/validator-logos.json';
import voteLogos from '@/components/epoch/validator-logos-by-vote.json';
export const fmt = (value: number | null | undefined, digits = 0) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const compact = (value: number | null | undefined) =>
  value == null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
export const signed = (value: number) => `${value >= 0 ? '+' : '−'}${compact(Math.abs(value))}`;
export function Source({ data }: { data?: { kind: string; asOf: string | null; source: string } }) {
  return (
    <Badge
      variant="outline"
      className="gap-1.5 text-xs font-normal text-muted-foreground"
      title={data ? `${data.source} · ${data.asOf || 'Illustrative data'}` : 'Loading source'}
    >
      <Database className="size-3" />
      {!data
        ? 'Loading'
        : data.kind === 'real'
          ? apiConfigured
            ? 'API data'
            : data.asOf
              ? `${new Date(data.asOf.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} snapshot`
              : 'Historical snapshot'
          : 'Sample data'}
    </Badge>
  );
}
export function Panel({
  title,
  aside,
  children,
  className = '',
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`workspace-panel rounded-xl border border-border bg-card py-6 ring-0 ${className}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 px-6">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside}
      </CardHeader>
      <CardContent className="px-6">{children}</CardContent>
    </Card>
  );
}
export function PageHeading({
  title,
  description,
  children,
  large = false,
  eyebrow,
  stats,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  large?: boolean;
  eyebrow?: ReactNode;
  stats?: { label: string; value: ReactNode; detail?: ReactNode; tone?: 'accent' | 'warn' | 'info' }[];
}) {
  return (
    <div className="workspace-heading page-hero" data-large={large || undefined}>
      <div className="page-hero-top">
        <div className="min-w-0">
          {eyebrow && <p className="page-hero-eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          <p className="page-hero-desc">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
      {stats && (
        <dl className="page-hero-stats">
          {stats.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd className="num" data-tone={s.tone}>
                {s.value}
              </dd>
              {s.detail && <small>{s.detail}</small>}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
/** Operator logo: on-chain validator-info image (via Stakewiz) by vote account, then a local mark by name, then a monogram. */
export function logoFor(name: string, vote?: string) {
  return (vote && (voteLogos as Record<string, string>)[vote]) || (logoMap as Record<string, { src: string }>)[name]?.src || null;
}
export function OperatorLogo({ name, vote, size = 40 }: { name: string; vote?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = logoFor(name, vote);
  return src && !failed ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="operator-logo"
      style={{ width: size, height: size }}
    />
  ) : (
    <span className="operator-logo operator-logo-mono" style={{ width: size, height: size }} aria-hidden="true">
      {(name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()}
    </span>
  );
}
export function Metric({
  label,
  value,
  detail,
  tone = '',
  title,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: string;
  title?: string;
}) {
  return (
    <div title={title} className="min-w-0">
      <p className="label-caps mb-2">{label}</p>
      <div className={`num whitespace-nowrap text-xl sm:text-2xl tracking-tight ${tone}`}>{value}</div>
      {detail && <p className="mt-2 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}
export function Jump({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex min-h-11 items-center gap-2 text-sm text-primary hover:underline">
      {children}
      <ArrowUpRight className="size-4" />
    </Link>
  );
}
export function QueryState({ pending, error, retry }: { pending: boolean; error: Error | null; retry: () => unknown }) {
  return pending ? (
    <div className="space-y-5" aria-label="Loading data">
      <Skeleton className="h-12 w-64" />
      <Skeleton className="h-80 w-full" />
    </div>
  ) : (
    <Panel title="We couldn’t load this data">
      <p className="text-muted-foreground">{error?.message || 'Please try again.'}</p>
      <Button className="mt-4" variant="outline" onClick={() => retry()}>
        <RotateCcw />
        Retry
      </Button>
    </Panel>
  );
}
export function downloadCsv(name: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) =>
    `"${String(v ?? '')
      .replace(/^[=+@-]/, "'$&")
      .replaceAll('"', '""')}"`;
  const url = URL.createObjectURL(
    new Blob([[headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `epoch-${name}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
