import type { Metadata } from "next";
import { Suspense } from "react";

import { IntegrationShowcase } from "@/components/integrations/showcase";
import { LiveProof } from "@/components/integrations/live-proof";
import { LaunchList } from "@/components/launch/launch-list";
import { meteora } from "@/content/integrations";

export const metadata: Metadata = {
  title: "Launch · validator revenue tokens on Meteora",
  description:
    "Validator revenue tokens on Meteora's Dynamic Bonding Curve, graduating to DAMM v2, bought back and burned every epoch by the Epoch program.",
};

export default function LaunchPage() {
  return (
    <div className="page-gutter mx-auto flex max-w-screen-2xl flex-col gap-16 py-10">
      <Suspense>
        <LaunchList />
      </Suspense>
      <IntegrationShowcase integration={meteora} liveProof={<LiveProof id="meteora" />} />
    </div>
  );
}
