"use client";
// The token page's blocks below the chart (Wealthsimple's order: promo card → "Market details" → "Dividends" →
// "News" → "About"), filled with what backs a revenue token: the curve and its graduation to DAMM v2 (LP17), what
// backs it (LP18), buybacks and burns with the schedule (LP19), holders, fees and treasury, the revenue-token terms,
// and about and risks. Words: revenue token, share, term, curve, raise, graduate, buyback, burn, backing.

import { ExternalLink, Flame, Lock, PauseCircle } from "lucide-react";
import { useMemo } from "react";

import { EmptyBlock, KeyValue, KeyValueGrid, Panel, PriceText, SectionHeading, SkeletonRows, Tip, Unavailable } from "@/components/data/primitives";
import { type Column, columnHelper, DataTable } from "@/components/data/data-table";
import { DataStatus } from "@/components/data/source-badge";
import { Badge } from "@/components/ui/badge";
import { isApiError } from "@/lib/api/client";
import type { DataSource } from "@/lib/data/query";
import type { LaunchBuyback, LaunchBuybackFeed, LaunchFees, LaunchHolder, LaunchHolders, LaunchPage, LaunchTrade, TreasuryClaimRow } from "@/lib/data/types";
import { explorerAddress, explorerTx } from "@/lib/explorers";
import { fmtBps, fmtDateTimeIst, fmtDuration, fmtEpoch, fmtInt, fmtNum, fmtPct, fmtSolValue, fmtTokens, fmtUsd, plural, shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";

import { CurveProgress } from "./fun-launch/curve-progress";

const Sol = ({ v }: { v: number | null | undefined }) => (
  <>
    {fmtSolValue(v)} <span className="text-unit text-ep-muted">SOL</span>
  </>
);

function AddressLink({ address, cluster, label, disabled }: { address: string | null | undefined; cluster: string | null; label?: string; disabled?: boolean }) {
  if (!address) return <span className="text-ep-muted">—</span>;
  if (disabled) return <span className={label ? undefined : "num"}>{label ?? shortKey(address)}</span>;
  return (
    <a href={explorerAddress(address, cluster)} target="_blank" rel="noreferrer" className={cn("inline-flex items-center gap-1 underline-offset-4 hover:text-ep-accent hover:underline", !label && "num")}>
      {label ?? shortKey(address)} <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

// ── Curve card (LP17) ─────────────────────────────────────────────────────────────────────────

export function CurveCard({ page, sample }: { page: LaunchPage; sample: boolean }) {
  const { market, launch, detail } = page;
  const curve = detail.curve;
  const target = market.raise.targetSol;
  const toValidator = (target * curve.creatorMigrationFeePct) / 100;
  const toPool = target - toValidator;
  const state = market.graduation.state;
  const cluster = page.network === "mainnet" ? null : page.network;
  const indexed = market.indexed ?? null;
  if (market.freshness.asOf === null) {
    return (
      <Panel aria-labelledby="curve-title" className="flex flex-col gap-4 p-6">
        <h2 id="curve-title" className="text-lg font-semibold text-ep-text">
          The curve
        </h2>
        <Unavailable body="The API could not read the pool this time, so the raise and the graduation state are not shown. The rest of the page works." />
        <p className="text-sm leading-relaxed text-ep-text-2">
          The curve sells from <PriceText value={curve.bandLowSol} /> to <PriceText value={curve.bandHighSol} /> SOL a token and graduates at {fmtSolValue(target)} SOL: {launch.validator.name} gets {fmtSolValue(toValidator)} SOL and{" "}
          {fmtSolValue(toPool)} SOL seeds a DAMM v2 pool locked forever.
        </p>
      </Panel>
    );
  }
  return (
    <Panel aria-labelledby="curve-title" className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="curve-title" className="text-lg font-semibold text-ep-text">
          {state === "migrated" ? "Graduated to Meteora DAMM v2" : state === "complete" ? "Raise complete: graduating" : state === "upcoming" ? "The curve" : "The raise on the curve"}
        </h2>
        <Badge variant="outline" className={cn("uppercase tracking-wider", state === "migrated" ? "border-ep-info-line bg-ep-info-soft text-ep-info" : "border-ep-accent-line bg-ep-accent-soft text-ep-accent")}>
          {state === "migrated" ? "DAMM v2" : state === "upcoming" ? "Upcoming" : "Dynamic Bonding Curve"}
        </Badge>
      </div>
      {state !== "upcoming" ? (
        <Tip
          tip={`${fmtSolValue(market.raise.raisedSol)} of ${fmtSolValue(target)} SOL raised from ${launch.raise.buyers} ${plural(launch.raise.buyers, "buyer")}. At ${fmtSolValue(target)} SOL it graduates: ${launch.validator.name} gets ${fmtSolValue(toValidator)} SOL and ${fmtSolValue(toPool)} SOL seeds a DAMM v2 pool locked forever.`}
          className="block"
        >
          <CurveProgress progressPct={market.raise.progressPct} raisedSol={market.raise.raisedSol} targetSol={target} graduated={state === "migrated"} />
        </Tip>
      ) : null}
      {state === "curve" ? (
        <p className="text-sm leading-relaxed text-ep-text-2">
          At {fmtSolValue(target)} SOL it graduates to a Meteora DAMM v2 pool: {launch.validator.name} gets {fmtSolValue(toValidator)} SOL ({curve.creatorMigrationFeePct}%), and {fmtSolValue(toPool)} SOL seeds the pool with its
          liquidity locked forever. The curve sells from <PriceText value={curve.bandLowSol} /> to <PriceText value={curve.bandHighSol} /> SOL, 60% to 95% of the share&apos;s value (<PriceText value={curve.valuePerTokenSol} /> SOL a token).
        </p>
      ) : state === "complete" ? (
        <p className="text-sm leading-relaxed text-ep-text-2">
          The raise is in{market.graduation.curveCompletedAt ? ` (${fmtDateTimeIst(market.graduation.curveCompletedAt)})` : ""}. The curve migrates to a DAMM v2 pool on the next pass of the migration crank, usually within minutes; trading
          resumes there.
        </p>
      ) : state === "migrated" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-ep-text-2">
            Graduated{market.graduation.graduatedEpoch !== null ? ` in epoch ${fmtEpoch(market.graduation.graduatedEpoch)}` : ""}
            {market.graduation.curveCompletedAt ? ` (${fmtDateTimeIst(market.graduation.curveCompletedAt)})` : ""}. {launch.validator.name} got{" "}
            {detail.upfrontToValidatorSol !== null ? `${fmtSolValue(detail.upfrontToValidatorSol)} SOL` : `${curve.creatorMigrationFeePct}% of the raise`} upfront; the rest seeds the DAMM v2 pool, whose liquidity is{" "}
            {curve.lockedLiquidityPct}% locked with Epoch&apos;s treasury, so holders always have a market and its fees go to Epoch&apos;s lenders.
          </p>
          <KeyValueGrid cols={3}>
            <KeyValue label="Pool" value={<AddressLink address={market.graduation.dammPool} cluster={cluster} disabled={sample} />} />
            <KeyValue label="Liquidity" value={<Sol v={market.liquiditySol} />} sub="SOL in the pool now" />
            <KeyValue label="Locked" value={<span className="inline-flex items-center gap-1.5"><Lock className="size-3.5 text-ep-muted" aria-hidden /> {fmtPct(curve.lockedLiquidityPct, 0)}</span>} sub="of the pool's LP, forever" />
          </KeyValueGrid>
          {market.graduation.meteoraUrl ? (
            <a href={market.graduation.meteoraUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-sm text-ep-text-2 underline underline-offset-4 hover:text-ep-accent">
              The pool on Meteora <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ) : null}
          {indexed ? (
            <div className="flex flex-col gap-2 rounded-md border border-ep-line bg-ep-inset p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-ep-text">Meteora&apos;s view of the pool</p>
                <DataStatus source="api" stale={indexed.freshness.stale} asOf={indexed.freshness.asOf} idleLabel={`From ${indexed.source}`} />
              </div>
              <KeyValueGrid cols={4}>
                <KeyValue label="TVL" value={fmtUsd(indexed.tvlUsd)} />
                <KeyValue label="Volume 24 h" value={fmtUsd(indexed.volume24hUsd)} />
                <KeyValue label="Fees 24 h" value={fmtUsd(indexed.fees24hUsd)} />
                <KeyValue label="Locked liquidity" value={fmtUsd(indexed.lockedLiquidityUsd)} />
              </KeyValueGrid>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-ep-text-2">
          Opens{launch.opensAtEpoch !== null ? ` in epoch ${fmtEpoch(launch.opensAtEpoch)}` : " soon"}. The curve will sell from <PriceText value={curve.bandLowSol} /> to <PriceText value={curve.bandHighSol} /> SOL a token and graduate at{" "}
          {fmtSolValue(target)} SOL.
        </p>
      )}
    </Panel>
  );
}

// ── What backs it (LP18) ─────────────────────────────────────────────────────────────────────

export function BacksGrid({
  page,
  fees,
  holders,
}: {
  page: LaunchPage;
  fees: Omit<LaunchFees, "schemaVersion" | "kind" | "asOf" | "source" | "note" | "network" | "mint"> | null;
  holders: Omit<LaunchHolders, "schemaVersion" | "kind" | "asOf" | "source" | "note" | "network" | "mint"> | null | undefined;
}) {
  const { launch, market, detail, revenueToken } = page;
  // When the pool (and so the mint) could not be read, the API fills the token's counts with 0 and its metadata
  // flag with false: show those as unknown, not as facts (backend request #32).
  const chainKnown = market.freshness.asOf !== null;
  const supplyNow = detail.token.supply - detail.token.burned;
  return (
    <section aria-labelledby="backs-title" className="flex flex-col gap-5">
      <SectionHeading id="backs-title" title="What backs it" description="The share of the validator's revenue the program buys back, against what the market pays for the token." />
      <KeyValueGrid cols={4}>
        <KeyValue label="Share" value={fmtBps(revenueToken.shareBps)} sub={`of ${launch.validator.name}'s revenue`} tip="Immutable once registered: the program takes it off the top of every sweep in the term." />
        <KeyValue
          label="Term"
          value={`${fmtInt(revenueToken.termEpochs)} epochs`}
          sub={`epochs ${fmtEpoch(revenueToken.startEpoch)}–${fmtEpoch(revenueToken.endEpoch)}`}
          tip="The first and last epoch whose sweep pays the share into the buyback escrow."
        />
        <KeyValue
          label="Share revenue / epoch"
          value={market.shareRevenuePerEpochSol ? <Sol v={market.shareRevenuePerEpochSol} /> : "—"}
          sub={market.pricedAtShareRevenuePerEpochSol !== null ? `priced at ${fmtSolValue(market.pricedAtShareRevenuePerEpochSol)} SOL` : market.shareRevenuePerEpochSol ? "live estimate" : "not known yet"}
          tip="The live estimate of the validator's revenue × the share: what the buyback gets each epoch. 'Priced at' is the 10-epoch average the curve was built from."
        />
        <KeyValue
          label="Implied yield"
          value={market.impliedYieldPctPerEpoch !== null ? `${fmtPct(market.impliedYieldPctPerEpoch, 2)}` : "—"}
          sub="of market cap, per epoch"
          tip="Share revenue per epoch ÷ market cap, per epoch, not a yearly rate: the cashflow stops when the term ends."
        />
        <KeyValue
          label="Backing"
          value={launch.backingRatio !== null ? `${fmtNum(launch.backingRatio, 2)}×` : "—"}
          sub="buybacks left ÷ market cap"
          tip="Expected buybacks left in the term (share revenue × epochs left) ÷ market cap. An estimate, not a promise."
        />
        <KeyValue
          label="Market cap"
          value={<Sol v={market.marketCapSol} />}
          sub={market.marketCapUsd !== null ? `fully diluted · ≈ ${fmtUsd(market.marketCapUsd)}` : "fully diluted"}
          tip="Price × tokens not burned (supply − burned)."
        />
        <KeyValue label="Supply now" value={chainKnown ? fmtTokens(supplyNow) : "—"} sub={`of ${fmtTokens(detail.token.supply)} minted`} tip="Fixed supply: buybacks and the leftover burn only lower it." />
        <KeyValue label="Burned" value={chainKnown ? fmtTokens(detail.token.burned) : "—"} sub="buybacks, leftover, redeems" />
        <KeyValue
          label="Holders"
          value={holders?.count.all !== null && holders?.count.all !== undefined ? fmtInt(holders.count.all) : chainKnown ? fmtInt(detail.token.holders) : "—"}
          sub="accounts with a balance"
        />
        <KeyValue label="Mint authority" value="None" sub="fixed supply at launch" tip="Epoch's launch revokes the mint authority: no one can mint more." />
        <KeyValue label="Metadata" value={chainKnown ? (detail.token.metadataImmutable ? "Immutable" : "Mutable") : "—"} />
        <KeyValue
          label="Fees to lenders"
          value={fees ? <Sol v={fees.toLenders.claimedSol} /> : "—"}
          sub={fees ? `${fmtSolValue(fees.toLenders.pendingSol)} SOL still accruing` : "not available right now"}
          tip="Epoch's partner fees (trading fees, surplus, migration fee, locked LP fees), claimed into the lending pool as income."
        />
      </KeyValueGrid>
    </section>
  );
}

// ── Buybacks and burns (LP19) ─────────────────────────────────────────────────────────────────

export function BuybacksBlock({
  feed,
  source,
  loading,
  error,
  symbol,
  trades,
  page,
}: {
  feed: LaunchBuybackFeed | null | undefined;
  source: DataSource | undefined;
  loading: boolean;
  error: unknown;
  symbol: string;
  trades: LaunchTrade[];
  page: LaunchPage;
}) {
  const bySig = useMemo(() => new Map(trades.map((t) => [t.signature, t])), [trades]);
  const groups = useMemo(() => {
    const m = new Map<number, LaunchBuyback[]>();
    for (const b of feed?.buybacks ?? []) m.set(b.epoch, [...(m.get(b.epoch) ?? []), b]);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [feed]);
  const lastEpoch = groups[0];
  const lastSol = lastEpoch ? lastEpoch[1].reduce((a, b) => a + b.solIn, 0) : null;
  const lastBurned = lastEpoch ? lastEpoch[1].reduce((a, b) => a + b.tokensBurned, 0) : null;
  const next = feed?.schedule?.nextSlice ?? null;
  const term = feed?.term ?? null;
  const link = (sig: string | null) => (sig ? bySig.get(sig)?.explorerUrl ?? explorerTx(sig, feed?.network) : null);

  return (
    <section aria-labelledby="buybacks-title" className="flex flex-col gap-5">
      <SectionHeading
        id="buybacks-title"
        title="Buybacks and burns"
        description="Every epoch of the term the sweep pays the share into the escrow; the program spends it on the token in slices and burns what it buys."
        action={feed ? <DataStatus source={source} asOf={feed.asOf} idleLabel={`Read ${fmtDateTimeIst(feed.asOf)}`} sampleNote="The program's buyback feed as recorded." /> : null}
      />
      {loading && !feed ? (
        <SkeletonRows rows={4} />
      ) : !feed ? (
        <Unavailable
          body={
            isApiError(error, "PROGRAM_NOT_CONFIGURED")
              ? "This API has no Epoch program id, so it cannot read the buyback escrow. The rest of the page works."
              : "The buyback feed could not be read. The rest of the page works."
          }
        />
      ) : (
        <>
          {feed.closed ? (
            <div className="flex items-start gap-3 rounded-lg border border-ep-info-line bg-ep-info-soft p-4 text-sm">
              <Flame className="mt-0.5 size-4 shrink-0 text-ep-info" aria-hidden />
              <p className="text-ep-text-2">
                <span className="font-medium text-ep-text">Term over: closed{feed.closed.epoch !== null ? ` in epoch ${fmtEpoch(feed.closed.epoch)}` : ""}.</span> The{" "}
                {fmtSolValue(feed.closed.unclaimedToPoolSol)} SOL holders had not redeemed after the grace period went to the Epoch lending pool as income.{" "}
                <a href={explorerTx(feed.closed.signature, feed.network)} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-ep-accent">
                  Transaction
                </a>
              </p>
            </div>
          ) : null}
          {!feed.revenueToken ? (
            <EmptyBlock title="No buybacks for this token" body={feed.note || "No validator has registered this mint as a revenue token."} />
          ) : (
            <>
              <p className="text-base text-ep-text">
                <Flame className="mr-1.5 inline size-4 align-text-bottom text-ep-info" aria-hidden />
                Bought back and burned: <span className="num font-medium">{fmtTokens(feed.totals.burned)}</span> {symbol} for <span className="num font-medium">{fmtSolValue(feed.totals.spentSol)}</span> SOL
                <span className="text-ep-muted">
                  {" "}
                  in {feed.totals.buybacks} {plural(feed.totals.buybacks, "slice")}
                </span>
                {feed.schedule?.paused ? (
                  <Badge variant="outline" className="ml-2 gap-1 border-ep-warn-line bg-ep-warn-soft align-middle text-ep-warn">
                    <PauseCircle className="size-3" aria-hidden /> Paused by the pool admin
                  </Badge>
                ) : null}
              </p>
              <KeyValueGrid cols={3}>
                <KeyValue
                  label="Last epoch"
                  value={lastEpoch ? <><Sol v={lastSol} /> → {fmtTokens(lastBurned)}</> : "—"}
                  sub={lastEpoch ? `epoch ${fmtEpoch(lastEpoch[0])} · ${lastEpoch[1].length} of ${lastEpoch[1][0].slices} slices · burned` : "no slice has run yet"}
                />
                <KeyValue
                  label="Next slice"
                  value={
                    !next
                      ? "None"
                      : term && next.epoch <= term.startEpoch && feed.totals.buybacks === 0
                        ? `Epoch ${fmtEpoch(term.startEpoch)}`
                        : `${next.waitsForSweep ? "from " : "in "}≈ ${fmtDuration(next.etaSeconds)}`
                  }
                  sub={
                    !next
                      ? "the term ended and the escrow is spent"
                      : term && next.epoch <= term.startEpoch && feed.totals.buybacks === 0
                        ? `buybacks start in epoch ${fmtEpoch(term.startEpoch)}`
                        : `epoch ${fmtEpoch(next.epoch)}, slice ${next.slice + 1} of ${feed.schedule?.slicesPerEpoch ?? "—"}${next.waitsForSweep ? " · after that epoch's sweep" : ""}`
                  }
                  tip={feed.schedule ? `${feed.schedule.slicesPerEpoch} slices in the first ${fmtInt(feed.schedule.windowSlots)} slots of each epoch; ${feed.schedule.slicesDoneThisEpoch} ran this epoch.` : undefined}
                />
                <KeyValue
                  label="Escrow"
                  value={<Sol v={feed.escrow.balanceSol} />}
                  sub={feed.escrow.mode === "redeem" ? "redeem open: holders can burn for their share" : "waiting for the next slices"}
                  tip="SOL in the buyback escrow above its rent: what buybacks (or redemptions) can still spend."
                />
              </KeyValueGrid>
              {groups.length ? (
                <ol className="flex flex-col gap-3" aria-label="Buyback slices by epoch, newest first">
                  {groups.map(([epoch, rows]) => (
                    <li key={epoch} className="rounded-lg border border-ep-line bg-ep-surface">
                      <p className="flex flex-wrap items-center justify-between gap-2 border-b border-ep-line px-4 py-2.5 text-sm">
                        <span className="font-medium text-ep-text">Epoch {fmtEpoch(epoch)}</span>
                        <span className="num text-xs text-ep-muted">
                          {fmtSolValue(rows.reduce((a, b) => a + b.solIn, 0))} SOL → {fmtTokens(rows.reduce((a, b) => a + b.tokensBurned, 0))} {symbol} burned
                        </span>
                      </p>
                      <ul className="divide-y divide-ep-line">
                        {rows.map((b) => {
                          const href = link(b.signature);
                          return (
                            <li key={`${b.epoch}-${b.slice}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                              <span className="w-24 text-ep-text-2">
                                Slice {b.slice + 1} of {b.slices}
                              </span>
                              <span className="num text-ep-text">
                                {fmtSolValue(b.solIn)} SOL → {fmtTokens(b.tokensBurned)} {symbol}
                              </span>
                              <span className="num text-xs text-ep-muted">
                                at <PriceText value={b.priceSol} />
                              </span>
                              <Badge variant="outline" className="text-xs text-ep-muted">
                                {b.venue === "dbc" ? "Curve" : "DAMM v2"}
                              </Badge>
                              {href ? (
                                <a href={href} target="_blank" rel="noreferrer" className="ml-auto inline-flex size-8 items-center justify-center rounded-sm text-ep-muted hover:text-ep-accent" aria-label={`Slice ${b.slice + 1} of epoch ${b.epoch} on Solana Explorer`}>
                                  <ExternalLink className="size-3.5" aria-hidden />
                                </a>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyBlock
                  title="No buyback has run yet"
                  body={term ? `The first slices run in the first hour of epoch ${fmtEpoch(Math.max(term.startEpoch, next?.epoch ?? term.startEpoch))}, once that epoch's sweep pays the share in.` : undefined}
                />
              )}
            </>
          )}
          {page.revenueToken.registeredOnChain !== true && feed.revenueToken ? (
            <p className="text-xs text-ep-muted">{page.revenueToken.note}</p>
          ) : null}
        </>
      )}
    </section>
  );
}

// ── Holders ────────────────────────────────────────────────────────────────────────────────────

const hh = columnHelper<LaunchHolder & { rank: number }>();

export function HoldersBlock({
  holders,
  source,
  loading,
  unavailable,
  symbol,
  wallet,
}: {
  holders: Omit<LaunchHolders, "schemaVersion" | "kind" | "asOf" | "source" | "note" | "network" | "mint"> | null | undefined;
  source: DataSource | undefined;
  loading: boolean;
  unavailable: boolean;
  symbol: string;
  wallet: string | null;
}) {
  const rows = useMemo(() => (holders?.top ?? []).map((h, i) => ({ ...h, rank: i + 1 })), [holders]);
  const columns = useMemo(
    () =>
      [
        hh.accessor("rank", { header: "#", meta: { numeric: true }, cell: (c) => <span className="text-ep-muted">{c.getValue()}</span> }),
        hh.accessor((r) => r.label ?? r.owner ?? r.tokenAccount, {
          id: "holder",
          header: "Holder",
          cell: (c) => {
            const r = c.row.original;
            return (
              <span className="flex items-center gap-2">
                {wallet && r.owner === wallet ? <span className="rounded-sm bg-ep-hover px-1 text-xs text-ep-text">You</span> : null}
                {r.label ? <span className="text-ep-muted">{r.label}</span> : <span className="num text-ep-text-2">{shortKey(r.owner ?? r.tokenAccount, 4, 4)}</span>}
              </span>
            );
          },
        }),
        hh.accessor("amount", { header: () => <span className="normal-case">{symbol}</span>, meta: { numeric: true }, cell: (c) => fmtTokens(c.getValue()) }),
        hh.accessor("sharePct", {
          header: "Share",
          meta: { numeric: true },
          cell: (c) => (
            <span className="inline-flex items-center justify-end gap-2">
              <span aria-hidden className="hidden h-1 w-16 overflow-hidden rounded-full bg-ep-line sm:inline-block">
                <span className="block h-full bg-ep-accent-line" style={{ width: `${Math.min(100, c.getValue())}%` }} />
              </span>
              {fmtPct(c.getValue(), 2)}
            </span>
          ),
        }),
      ] as Column<LaunchHolder & { rank: number }>[],
    [symbol, wallet],
  );
  return (
    <section aria-labelledby="holders-title" className="flex flex-col gap-4">
      <SectionHeading
        id="holders-title"
        title="Holders"
        description={holders ? `${holders.count.all !== null ? fmtInt(holders.count.all) : "—"} accounts with a balance · ${holders.count.buyers !== null ? fmtInt(holders.count.buyers) : "—"} buyers (pools, escrow and treasury left out). Labelled rows are not buyers.` : undefined}
        action={holders ? <DataStatus source={source} stale={holders.freshness.stale} asOf={holders.freshness.asOf} idleLabel={`Read ${fmtDateTimeIst(holders.freshness.asOf)}`} /> : null}
      />
      {loading && !holders ? (
        <SkeletonRows rows={5} />
      ) : !holders || unavailable ? (
        <Unavailable body="Holders could not be read this time." />
      ) : rows.length ? (
        <DataTable columns={columns} data={rows} getRowId={(r) => r.tokenAccount} caption={`The ${rows.length} largest ${symbol} accounts`} rowClassName={(r) => (r.label ? "text-ep-muted" : undefined)} />
      ) : (
        <EmptyBlock title="No holder list yet" body={`${holders.count.all ?? 0} accounts hold ${symbol}; the largest-accounts read is empty.`} />
      )}
    </section>
  );
}

// ── Fees and treasury ──────────────────────────────────────────────────────────────────────────

/** `TreasuryClaimed.kind`: claims the Epoch program made for its treasury (it burns the tokens among them). */
const CLAIM_WORDS: Record<string, string> = {
  tradingFee: "Trading fees",
  surplus: "Surplus",
  migrationFee: "Migration fee",
  leftover: "Unsold supply burned",
  lpFee: "Locked LP fees",
};

/** `LaunchFeeEventRow.kind`: claims and lifecycle events seen in the pools' transactions. */
const HISTORY_WORDS: Record<string, string> = {
  leftover: "Unsold supply withdrawn",
  lpFee: "Locked LP fees",
  partnerTradingFee: "Partner trading fees",
  creatorTradingFee: "Creator trading fees",
  partnerMigrationFee: "Partner migration fee",
  creatorMigrationFee: "Upfront to the validator (70%)",
  partnerSurplus: "Partner surplus",
  creatorSurplus: "Creator surplus",
  curveComplete: "Raise complete",
  dammPoolCreated: "DAMM v2 pool created",
};

const ch = columnHelper<TreasuryClaimRow>();

export function FeesBlock({
  fees,
  feed,
  source,
  loading,
  unavailable,
  symbol,
  network,
  sample,
}: {
  fees: Omit<LaunchFees, "schemaVersion" | "kind" | "asOf" | "source" | "note" | "network" | "mint"> | null | undefined;
  feed: LaunchBuybackFeed | null | undefined;
  source: DataSource | undefined;
  loading: boolean;
  unavailable: boolean;
  symbol: string;
  network: string;
  sample: boolean;
}) {
  const claimColumns = useMemo(
    () =>
      [
        ch.accessor("kind", { header: "Claim", cell: (c) => CLAIM_WORDS[c.getValue()] ?? c.getValue() }),
        ch.accessor("epoch", { header: "Epoch", meta: { numeric: true }, cell: (c) => fmtEpoch(c.getValue()) }),
        ch.accessor("toLendersSol", { header: "To lenders SOL", meta: { numeric: true }, cell: (c) => fmtSolValue(c.getValue()) }),
        ch.accessor("tokensBurned", { header: () => <><span className="normal-case">{symbol}</span> burned</>, meta: { numeric: true }, cell: (c) => fmtTokens(c.getValue()) }),
        ch.accessor("signature", {
          header: () => <span className="sr-only">Explorer</span>,
          enableSorting: false,
          cell: (c) => (
            <a href={explorerTx(c.getValue(), feed?.network ?? network)} target="_blank" rel="noreferrer" aria-label={`Claim ${shortKey(c.getValue())} on Solana Explorer`} className="inline-flex size-8 items-center justify-center rounded-sm text-ep-muted hover:text-ep-accent">
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ),
        }),
      ] as Column<TreasuryClaimRow>[],
    [symbol, feed?.network, network],
  );
  const claims = feed?.treasury.claims ?? [];
  const lp = fees?.lp.positions.find((p) => p.role === "partner") ?? null;
  return (
    <section aria-labelledby="fees-title" className="flex flex-col gap-5">
      <SectionHeading
        id="fees-title"
        title="Fees and treasury"
        description="Epoch's fees go to lenders. Its share of trading fees, the migration fee and its LP fees are claimed into the lending pool (senior coupon first), and any tokens among them are burned, as is the supply the curve never sold."
        action={fees ? <DataStatus source={source} stale={fees.freshness.stale} asOf={fees.freshness.asOf} idleLabel={`Read ${fmtDateTimeIst(fees.freshness.asOf)}`} /> : null}
      />
      {loading && !fees ? (
        <SkeletonRows rows={3} />
      ) : !fees || unavailable ? (
        <Unavailable body="The fee block could not be read this time (before the curve exists there are no fees)." />
      ) : (
        <>
          <KeyValueGrid cols={4}>
            <KeyValue label="Claimed for lenders" value={<Sol v={fees.toLenders.claimedSol} />} sub="in the lending pool as income" valueClassName="text-ep-accent" />
            <KeyValue label="Accruing for lenders" value={<Sol v={fees.toLenders.pendingSol} />} sub="still on Meteora" />
            <KeyValue
              label="Curve trading fees"
              value={<Sol v={fees.partner.tradingFeesSol.accrued} />}
              sub={`${fmtSolValue(fees.partner.tradingFeesSol.claimed)} claimed · ${fmtSolValue(fees.partner.tradingFeesSol.unclaimed)} to claim`}
              tip="Epoch's treasury is the curve's partner: it earns the trading fee after Meteora's protocol share."
            />
            <KeyValue
              label="Upfront to the validator"
              value={<Sol v={fees.creator.migrationFeeSol} />}
              sub={fees.creator.migrationFeeSol ? (fees.creator.migrationFeeWithdrawn ? "claimed by the validator" : "the validator has not claimed it yet") : "70% of the raise, at graduation"}
              tip="The migration fee: 70% of the raise, paid to the pool creator (the validator) when the curve graduates."
            />
            <KeyValue
              label="Locked LP fees"
              value={lp ? <Sol v={lp.claimedSol + lp.unclaimedSol} /> : "—"}
              sub={lp ? `${fmtPct(lp.lockedPct, 0)} locked · ${fmtSolValue(lp.unclaimedSol)} to claim` : "after graduation"}
              tip="The DAMM v2 position created at graduation is permanently locked with Epoch's treasury; its trading fees are claimable forever."
            />
            <KeyValue
              label="Unsold supply"
              value={fees.leftover.burned ? `${fmtTokens(fees.leftover.burnedTokens)} burned` : fees.leftover.withdrawn ? "Withdrawn" : fees.leftover.tokens ? fmtTokens(fees.leftover.tokens) : "—"}
              sub={fees.leftover.burned ? "burn_leftover by the program" : fees.leftover.withdrawn ? "by the leftover receiver, not burned" : "withdrawable after graduation"}
            />
            <KeyValue label="Where claimed SOL sits" value={<AddressLink address={fees.toLenders.holder} cluster={network === "mainnet" ? null : network} disabled={sample} />} sub="the lending pool's vault" />
            <KeyValue label="Treasury claims" value={fmtInt(feed?.treasury.totals.claims ?? claims.length)} sub={feed ? `${fmtSolValue(feed.treasury.totals.toLendersSol)} SOL · ${fmtTokens(feed.treasury.totals.tokensBurned)} burned` : "—"} />
          </KeyValueGrid>
          {claims.length ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-base font-semibold text-ep-text">Treasury claims through the Epoch program</h3>
              <DataTable columns={claimColumns} data={claims} getRowId={(r) => `${r.signature}-${r.kind}`} caption="Permissionless treasury claims, newest first" />
            </div>
          ) : null}
          {fees.history.length ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-base font-semibold text-ep-text">Claims and lifecycle events in the pools</h3>
              <ul className="divide-y divide-ep-line rounded-lg border border-ep-line">
                {fees.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                    <span className="min-w-48 text-ep-text-2">{HISTORY_WORDS[h.kind] ?? h.kind}</span>
                    <span className="num text-ep-text">
                      {h.solAmount ? `${fmtSolValue(h.solAmount)} SOL` : ""}
                      {h.solAmount && h.tokenAmount ? " · " : ""}
                      {h.tokenAmount ? `${fmtTokens(h.tokenAmount)} ${symbol}` : ""}
                    </span>
                    <span className="num text-xs text-ep-muted">{fmtDateTimeIst(h.t)}</span>
                    <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex size-8 items-center justify-center rounded-sm text-ep-muted hover:text-ep-accent" aria-label={`${HISTORY_WORDS[h.kind] ?? h.kind} on Solana Explorer`}>
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs leading-relaxed text-ep-muted">{fees.toLenders.note}</p>
        </>
      )}
    </section>
  );
}

// ── Revenue-token terms ─────────────────────────────────────────────────────────────────────────

export function TermsBlock({ page, sample }: { page: LaunchPage; sample: boolean }) {
  const rt = page.revenueToken;
  const registered = rt.registeredOnChain === true && rt.source === "program";
  const cluster = page.network === "mainnet" ? null : page.network;
  return (
    <section aria-labelledby="terms-title" className="flex flex-col gap-5">
      <SectionHeading
        id="terms-title"
        title="Revenue-token terms"
        action={
          <Badge variant="outline" className={cn("uppercase tracking-wider", registered ? "border-ep-accent-line bg-ep-accent-soft text-ep-accent" : "border-ep-line-strong text-ep-muted")}>
            {registered ? "Registered on chain" : "As announced"}
          </Badge>
        }
      />
      <p className="text-base leading-relaxed text-ep-text">
        {fmtBps(rt.shareBps)} of {page.launch.validator.name}&apos;s gross revenue for {fmtInt(rt.termEpochs)} epochs ({fmtEpoch(rt.startEpoch)}–{fmtEpoch(rt.endEpoch)}), bought back and burned every epoch.{" "}
        {registered ? (
          <>
            Registered on chain: <AddressLink address={rt.address} cluster={cluster} label="the RevenueToken account" disabled={sample} />.
          </>
        ) : (
          <span className="text-ep-text-2">Terms as announced; not registered with the program yet.</span>
        )}
      </p>
      {rt.note ? <p className="text-sm text-ep-muted">{rt.note}</p> : null}
      {registered ? (
        <KeyValueGrid cols={4}>
          <KeyValue label="Operator" value={<AddressLink address={rt.operator} cluster={cluster} disabled={sample} />} sub="registered it and paid its rent" />
          <KeyValue label="Registered" value={rt.registeredEpoch !== null ? `epoch ${fmtEpoch(rt.registeredEpoch)}` : "—"} sub="the term starts the epoch after" />
          <KeyValue
            label="Commission floor"
            value={rt.commissionFloorBps ? `${fmtBps(rt.commissionFloorBps.inflation)} · ${fmtBps(rt.commissionFloorBps.blockRevenue)}` : "—"}
            sub="inflation · block revenue"
            tip="Until the term ends, the validator cannot cut either commission below its value at registration."
          />
          <KeyValue
            label="Slices"
            value={rt.buybacks ? `${rt.buybacks.slicesPerEpoch} an epoch` : "—"}
            sub={rt.buybacks ? `in the first ${fmtInt(rt.buybacks.windowSlots)} slots` : undefined}
          />
          <KeyValue
            label="Protections"
            value={rt.buybacks ? `${fmtBps(rt.buybacks.maxImpactBps)} impact` : "—"}
            sub={rt.buybacks ? `${fmtBps(rt.buybacks.maxSlippageBps)} max slippage per slice` : undefined}
          />
          <KeyValue label="Buybacks" value={rt.buybacks ? (rt.buybacks.paused ? "Paused" : "Running") : "—"} sub={rt.buybacks ? (rt.buybacks.redeemOpen ? "redeem open" : "redeem closed") : undefined} />
          <KeyValue label="Escrowed" value={rt.totals ? <Sol v={rt.totals.escrowedSol} /> : "—"} sub={rt.totals ? `${fmtSolValue(rt.totals.spentSol)} SOL spent` : undefined} />
          <KeyValue label="Bought and burned" value={rt.totals ? fmtTokens(rt.totals.burnedTokens) : "—"} sub={rt.totals ? `${fmtTokens(rt.totals.redeemedTokens)} redeemed` : undefined} />
        </KeyValueGrid>
      ) : null}
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ep-text-2 marker:text-ep-muted">
        <li>
          <span className="text-ep-text">Who registers.</span> The validator&apos;s operator signs register_revenue_token for a pool whose fee claimer is Epoch&apos;s treasury; the launch script sends it as its last step.
        </li>
        <li>
          <span className="text-ep-text">Locked commission.</span> Until the term ends the validator cannot leave Epoch or cut its commission below the floor: Epoch holds its vote account&apos;s withdraw authority.
        </li>
        <li>
          <span className="text-ep-text">After the term.</span> The share stops; what is left in the escrow is still bought back, and holders can redeem tokens for their share of it. Then the escrow closes and the operator gets its rent back.
        </li>
      </ul>
    </section>
  );
}

// ── About and risks ─────────────────────────────────────────────────────────────────────────────

export function AboutBlock({ page }: { page: LaunchPage }) {
  const { launch, detail } = page;
  return (
    <section aria-labelledby="about-title" className="flex flex-col gap-4">
      <SectionHeading id="about-title" title={`About ${launch.symbol}`} />
      <p className="max-w-3xl text-sm leading-relaxed text-ep-text-2">
        {launch.name}: {launch.validator.name} sells {fmtBps(launch.shareBps)} of its gross revenue for {fmtInt(launch.termEpochs)} epochs as {launch.symbol}, a fixed supply of {fmtTokens(detail.token.supply)} tokens with no mint
        authority. The token launched on a Meteora Dynamic Bonding Curve with Epoch as the partner; after graduation it trades on a Meteora DAMM v2 pool. Every epoch of the term the Epoch program buys it back with the share and burns it.
        {launch.validator.vote ? (
          <>
            {" "}
            Vote account <span className="num">{shortKey(launch.validator.vote, 6, 6)}</span>.
          </>
        ) : null}
      </p>
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-ep-text">Risks</h3>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ep-text-2 marker:text-ep-warn">
          {detail.risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
