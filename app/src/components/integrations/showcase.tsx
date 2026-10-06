// The shared "integration showcase" at the bottom of each side-track page: How we integrate (flow diagrams, then
// each sponsor product with what we use it for and the code on GitHub), Why it matters, and Proof (a live number
// from the API, then the verified runs with their dates and check counts, and the docs).

import { ArrowUpRight, CheckCircle2, FileCode2 } from "lucide-react";
import type { ReactNode } from "react";

import type { Integration } from "@/content/integrations";
import { githubFile } from "@/lib/env";
import { cn } from "@/lib/utils";

import { FlowDiagram } from "./flow-diagram";

function GitHubLink({ label, path, className }: { label: string; path: string; className?: string }) {
  return (
    <a
      href={githubFile(path)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-sm text-xs text-ep-text-2 underline-offset-4 transition-colors duration-200 hover:text-ep-accent hover:underline pointer-coarse:min-h-11",
        className,
      )}
    >
      <FileCode2 className="size-3.5 shrink-0 text-ep-muted" aria-hidden />
      <span className="num break-all">{label}</span>
      <ArrowUpRight className="size-3 shrink-0 text-ep-muted" aria-hidden />
    </a>
  );
}

export function IntegrationShowcase({ integration: it, liveProof, className }: { integration: Integration; liveProof?: ReactNode; className?: string }) {
  const headingId = `integration-${it.id}`;
  return (
    <section id="integration" aria-labelledby={headingId} className={cn("scroll-mt-20 border-t border-ep-line pt-12", className)}>
      <div className="flex flex-col gap-2">
        <p className="label-caps text-ep-info">{it.track} · {it.prize}</p>
        <h2 id={headingId} className="text-2xl font-semibold text-ep-text sm:text-3xl">
          How Epoch uses {it.sponsor}
        </h2>
        <p className="max-w-3xl text-base text-ep-text-2">{it.oneLiner}</p>
      </div>

      {/* How we integrate */}
      <div className="mt-10 flex flex-col gap-8">
        <h3 className="text-xl font-semibold text-ep-text">How we integrate</h3>
        <div className="flex flex-col gap-8">
          {it.flows.map((flow) => (
            <FlowDiagram key={flow.title} flow={flow} />
          ))}
        </div>
        <ul className="grid gap-3 md:grid-cols-2">
          {it.products.map((p) => (
            <li key={p.product} className="flex flex-col gap-3 rounded-lg border border-ep-line bg-ep-surface p-5">
              <div className="flex items-center gap-2">
                <span className="label-caps text-ep-info">{it.sponsor}</span>
                <h4 className="text-base font-medium text-ep-text">{p.product}</h4>
              </div>
              <p className="text-sm leading-relaxed text-ep-text-2">{p.use}</p>
              {p.calls?.length ? (
                <ul className="flex flex-wrap gap-1.5" aria-label="Calls">
                  {p.calls.map((c) => (
                    <li key={c} className="num rounded-sm border border-ep-line bg-ep-inset px-2 py-1 text-xs text-ep-text-2">
                      {c}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 border-t border-ep-line pt-3">
                {p.files.map((f) => (
                  <GitHubLink key={f.path} label={f.label} path={f.path} />
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Why it matters */}
      <div className="mt-12 grid gap-6 lg:grid-cols-5">
        <div className="flex flex-col gap-3 lg:col-span-2">
          <h3 className="text-xl font-semibold text-ep-text">Why it matters</h3>
          <p className="text-base leading-relaxed text-ep-text-2">{it.why.problem}</p>
        </div>
        <ul className="flex flex-col gap-3 lg:col-span-3">
          {it.why.unlocks.map((u) => (
            <li key={u} className="flex gap-3 rounded-lg border border-ep-line bg-ep-surface p-4 text-sm leading-relaxed text-ep-text-2">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ep-accent" aria-hidden />
              <span>{u}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Proof */}
      <div className="mt-12 flex flex-col gap-6">
        <h3 className="text-xl font-semibold text-ep-text">Proof</h3>
        {liveProof ? (
          <div className="rounded-lg border border-ep-line bg-ep-surface p-5">
            <p className="label-caps mb-4">Live from the Epoch API</p>
            {liveProof}
          </div>
        ) : null}
        <ol className="grid gap-3 md:grid-cols-3">
          {it.runs.map((r) => (
            <li key={r.title} className="flex flex-col gap-2 rounded-lg border border-ep-line bg-ep-surface p-5">
              <span className="num text-2xl font-medium text-ep-accent">{r.result}</span>
              <span className="text-sm font-medium text-ep-text">{r.title}</span>
              <span className="num text-xs text-ep-muted">{r.when}</span>
              <span className="text-sm leading-relaxed text-ep-text-2">{r.detail}</span>
              <GitHubLink label={r.link.label} path={r.link.path} className="mt-auto pt-1" />
            </li>
          ))}
        </ol>
        {it.next ? <p className="max-w-3xl text-sm text-ep-muted">{it.next}</p> : null}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="label-caps">Docs</span>
          {it.docs.map((d) => (
            <GitHubLink key={d.path} label={d.label} path={d.path} />
          ))}
        </div>
      </div>
    </section>
  );
}
