import type { Metadata } from "next";
import { Suspense } from "react";

import { IntegrationShowcase } from "@/components/integrations/showcase";
import { LiveProof } from "@/components/integrations/live-proof";
import { TokenPage } from "@/components/launch/token-page";
import { meteora } from "@/content/integrations";

type Params = { params: Promise<{ mint: string }> };

const label = (key: string) => (key.length > 16 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { mint } = await params;
  return {
    title: `${label(decodeURIComponent(mint))} · Launch`,
    description: "A validator revenue token on Meteora: its price, the curve and graduation to DAMM v2, buybacks and burns, holders, fees and terms.",
  };
}

export default async function LaunchTokenPage({ params }: Params) {
  const { mint } = await params;
  return (
    <div className="page-gutter mx-auto flex max-w-screen-2xl flex-col gap-16 py-10">
      <Suspense>
        <TokenPage routeKey={decodeURIComponent(mint)} />
      </Suspense>
      <IntegrationShowcase integration={meteora} liveProof={<LiveProof id="meteora" />} />
    </div>
  );
}
