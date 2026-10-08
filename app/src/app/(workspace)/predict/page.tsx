import type { Metadata } from "next";
import { Suspense } from "react";

import { IntegrationShowcase } from "@/components/integrations/showcase";
import { LiveProof } from "@/components/integrations/live-proof";
import { PredictPage } from "@/components/predict/predict-page";
import { panta } from "@/content/integrations";

export const metadata: Metadata = {
  title: "Predict · Fee Index markets on Panta",
  description: "Real-USDC YES/NO markets on the Solana Fee Index through Panta, a crowd forecast of block-space prices, and Panta's catalog.",
};

export default function Page() {
  return (
    <div className="page-gutter mx-auto flex max-w-screen-2xl flex-col gap-16 py-10">
      <Suspense>
        <PredictPage />
      </Suspense>
      <IntegrationShowcase integration={panta} liveProof={<LiveProof id="panta" />} />
    </div>
  );
}
