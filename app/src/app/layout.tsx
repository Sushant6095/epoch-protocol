import type { ReactNode } from "react";

export const metadata = {
  title: "Epoch",
  description: "The revenue desk for Solana validators",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
