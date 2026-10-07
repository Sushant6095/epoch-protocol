import type { ReactNode } from 'react';
import { Bricolage_Grotesque, Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';
import { Providers } from '@/components/providers';
import '@/styles/globals.css';
const sans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display', axes: ['opsz', 'wdth'] });
const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: 'italic',
  variable: '--font-instrument-serif',
});
export const metadata = { title: 'Epoch', description: 'The revenue desk for Solana validators' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="horizon"
      className={`${sans.variable} ${mono.variable} ${serif.variable} ${display.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Decide before first paint whether the landing's opening sequence plays (once per session, never
            with reduced motion), so returning visitors never see a flash of the intro screen. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(location.pathname==='/'&&(/[?&](intro|freeze)/.test(location.search)||sessionStorage.getItem('epoch.intro')!=='1')&&!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.dataset.intro='on'}catch(e){}`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
