import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/shell/site-footer";
import { SiteHeader } from "@/components/shell/site-header";
import "@/styles/globals.css";

import { Providers } from "./providers";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["italic"], variable: "--font-instrument-serif" });

export const metadata: Metadata = {
  title: { default: "Epoch · the revenue desk for Solana validators", template: "%s · Epoch" },
  description:
    "Validators borrow against their future commission, lenders earn the fees, the Solana Fee Index prices block space, and validator revenue trades as tokens on Meteora.",
};

export const viewport: Viewport = {
  themeColor: "#050e0c",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="emerald" className={`dark ${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <Providers>
          <a
            href="#main"
            className="sr-only z-50 rounded-md bg-ep-accent px-3 py-2 text-ep-accent-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
          >
            Skip to content
          </a>
          <SiteHeader />
          <main id="main" className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
