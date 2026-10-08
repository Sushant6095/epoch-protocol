import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LiveProof } from "@/components/integrations/live-proof";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { integrations } from "@/content/integrations";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Integrations",
  description: "Solami, Panta and Meteora: what Epoch uses from each sponsor, why it matters, and the live proof.",
};

const SHORT: Record<string, string> = {
  solami: "/solami",
  panta: "/panta",
  meteora: "/meteora",
};

export default function IntegrationsPage() {
  return (
    <div className="page-gutter mx-auto flex max-w-screen-2xl flex-col gap-10 py-10">
      <PageHeader
        eyebrow="Side tracks"
        title="Integrations"
        description="Three sponsor tracks, one page built for each. Every card says what Epoch uses from the sponsor, shows one number read live from the Epoch API, and links to the page and the code."
      />
      <ol className="flex flex-col gap-4">
        {integrations.map((it, i) => {
          return (
            <li key={it.id}>
              <article aria-labelledby={`card-${it.id}`} className="overflow-hidden rounded-lg border border-ep-line bg-ep-surface">
                <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-12">
                  <div className="flex flex-col gap-3 lg:col-span-7">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num text-xs text-ep-muted">0{i + 1}</span>
                      <span className="label-caps text-ep-info">{it.sponsor}</span>
                      <span className="text-xs text-ep-muted">· {it.track} · {it.prize}</span>
                    </div>
                    <h2 id={`card-${it.id}`} className="text-xl font-semibold text-ep-text">
                      {it.headline}
                    </h2>
                    <p className="text-sm leading-relaxed text-ep-text-2">{it.oneLiner}</p>
                    <div className="flex flex-col gap-2">
                      <span className="label-caps">{it.sponsor} products and APIs used</span>
                      <ul className="flex flex-wrap gap-1.5">
                        {it.products.map((p) => (
                          <li key={p.product} className="rounded-sm border border-ep-info-line bg-ep-info-soft px-2 py-1 text-xs text-ep-text-2">
                            {p.product}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 lg:col-span-5 lg:border-l lg:border-ep-line lg:pl-6">
                    <span className="label-caps">Live proof</span>
                    <LiveProof id={it.id} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3 border-t border-ep-line bg-ep-inset px-5 py-3 sm:px-6">
                  <Link href={it.page.href} className={cn(buttonVariants({ size: "sm" }))}>
                    Open {it.page.label} <ArrowRight aria-hidden />
                  </Link>
                  <Link href={`${it.page.href}#integration`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                    How we integrate {it.sponsor}
                  </Link>
                  <span className="ml-auto text-xs text-ep-muted">
                    Short link <span className="num text-ep-text-2">{SHORT[it.id]}</span>
                  </span>
                </div>
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
