import type { Metadata } from "next";
import { Suspense } from "react";

import { IntegrationShowcase } from "@/components/integrations/showcase";
import { LiveProof } from "@/components/integrations/live-proof";
import { LiveConsole } from "@/components/live/live-console";
import { solami } from "@/content/integrations";

export const metadata: Metadata = {
  title: "Live · the Solana Fee Index from mainnet",
  description: "The Solana Fee Index computed block by block from mainnet, streamed through Solami's Yellowstone gRPC.",
};

export default function LivePage() {
  return (
    <div className="page-gutter mx-auto flex max-w-screen-2xl flex-col gap-16 py-10">
      <Suspense>
        <LiveConsole />
      </Suspense>
      <IntegrationShowcase integration={solami} liveProof={<LiveProof id="solami" />} />
    </div>
  );
}
