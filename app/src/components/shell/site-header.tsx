"use client";
// App header (64 px, sticky): Epoch mark → Live · Predict · Launch · Integrations → Connect. Phones get the same nav
// in a sheet. The current page's link carries aria-current="page" (SH2).

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ConnectButton, ConnectDialog } from "@/components/wallet/connect";
import { cn } from "@/lib/utils";

import { EpochMark } from "./epoch-mark";

export const NAV = [
  { href: "/live", label: "Live", sponsor: "Solami" },
  { href: "/predict", label: "Predict", sponsor: "Panta" },
  { href: "/launch", label: "Launch", sponsor: "Meteora" },
  { href: "/integrations", label: "Integrations", sponsor: null },
] as const;

function isCurrent(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader() {
  const pathname = usePathname() ?? "/";
  return (
    <header className="sticky top-0 z-40 h-16 border-b border-ep-line bg-ep-bg/90 backdrop-blur supports-[backdrop-filter]:bg-ep-bg/75">
      <div className="page-gutter mx-auto flex h-full max-w-screen-2xl items-center gap-6">
        <Link href="/" className="flex items-center gap-2 rounded-md font-semibold tracking-tight text-ep-text" aria-label="Epoch home">
          <EpochMark />
          <span className="text-base">Epoch</span>
        </Link>
        <nav aria-label="Main" className="hidden h-full items-center gap-1 md:flex">
          {NAV.map((item) => {
            const current = isCurrent(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex h-full items-center px-3 text-sm transition-colors duration-200",
                  current ? "text-ep-text" : "text-ep-muted hover:text-ep-text",
                  current && "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-ep-accent",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ConnectButton />
          <Sheet>
            <SheetTrigger render={<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open menu" />}>
              <Menu aria-hidden />
            </SheetTrigger>
            <SheetContent side="right" className="bg-ep-raised">
              <SheetHeader>
                <SheetTitle>Epoch</SheetTitle>
                <SheetDescription>The revenue desk for Solana validators.</SheetDescription>
              </SheetHeader>
              <nav aria-label="Main" className="flex flex-col px-4">
                {NAV.map((item) => {
                  const current = isCurrent(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "flex h-12 items-center justify-between border-b border-ep-line text-base",
                        current ? "text-ep-accent" : "text-ep-text",
                      )}
                    >
                      {item.label}
                      {item.sponsor ? <span className="text-xs text-ep-muted">{item.sponsor}</span> : null}
                    </Link>
                  );
                })}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
      <ConnectDialog />
    </header>
  );
}
