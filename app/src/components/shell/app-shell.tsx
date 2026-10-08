'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, BookOpen, Search, Server, Vault, Wallet, ExternalLink, Target, Code2, Radio, Rocket, Blocks } from 'lucide-react';
import { EpochRing } from '@/components/epoch/epoch-ring';
import { ArrowRight } from 'lucide-react';
const fmtNum = (v: number) => v.toLocaleString('en-US');
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EpochMark } from '@/components/epoch/epoch-mark';
import { ConnectButton, ConnectDialog } from '@/components/wallet/connect';
import { useNetwork } from '@/lib/data/useNetwork';
import { useSession } from '@/lib/data/resources';
import { useValidators } from '@/lib/data/useValidators';
const navigation = [
  { group: 'Network', items: [
    { label: 'Terminal', href: '/terminal', icon: Activity, hint: 'Stake, fees, epochs' },
    { label: 'Validators', href: '/validators', icon: Server, hint: 'Operators and health' },
  ] },
  { group: 'Capital', items: [
    { label: 'Vault', href: '/vault', icon: Vault, hint: 'Senior and Junior' },
    { label: 'My Stake', href: '/me', icon: Wallet, hint: 'Your stake accounts' },
  ] },
  { group: 'Side tracks', items: [
    { label: 'Live', href: '/live', icon: Radio, hint: 'Fee Index · Solami' },
    { label: 'Predict', href: '/predict', icon: Target, hint: 'Markets · Panta' },
    { label: 'Launch', href: '/launch', icon: Rocket, hint: 'Revenue tokens · Meteora' },
    { label: 'Integrations', href: '/integrations', icon: Blocks, hint: 'Sponsor proof' },
  ] },
];
const titles: Record<string, string> = {
  '/live': 'Live',
  '/launch': 'Launch',
  '/integrations': 'Integrations',
  '/terminal': 'Terminal',
  '/validators': 'Validators',
  '/vault': 'Vault',
  '/me': 'My Stake',
  '/predict': 'Predict',
};
function Navigation({ items }: { items: (typeof navigation)[number]['items'] }) {
  const path = usePathname();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {items.map(({ label, href, icon: Icon }) => (
        <SidebarMenuItem key={href}>
          <SidebarMenuButton
            render={<Link href={href} />}
            isActive={path.startsWith(href)}
            aria-current={path.startsWith(href) ? 'page' : undefined}
            onClick={() => setOpenMobile(false)}
          >
            <Icon />
            <span>{label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const journey = pathname.startsWith('/validators')
    ? { text: 'Understand the operators behind the network.', next: 'Explore validator financing', href: '/vault' }
    : pathname === '/vault'
      ? { text: 'Explore capital, repayment and lender risk.', next: 'Review the operators', href: '/validators' }
      : pathname === '/me'
        ? { text: 'Connect your stake to the validators behind it.', next: 'Compare validators', href: '/validators' }
        : pathname === '/terminal'
          ? {
              text: 'Start with the network. Then inspect an operator.',
              next: 'Compare validators',
              href: '/validators',
            }
          : null;
  const params = useSearchParams();
  const session = useSession();
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const epochTrigger = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [epochOpen, setEpochOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const router = useRouter();
  const network = useNetwork();
  const validators = useValidators();
  const n = network.data;
  const progress = n ? (n.epoch.slotIndex / n.epoch.slotsInEpoch) * 100 : 0;
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('epoch.recent') || '[]');
      if (Array.isArray(stored)) setRecent(stored.filter((x): x is string => typeof x === 'string').slice(0, 5));
    } catch {}
    const handle = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,[contenteditable=true]')) return;
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || event.key === '/') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
  function go(vote: string) {
    const next = [vote, ...recent.filter((x) => x !== vote)].slice(0, 5);
    setRecent(next);
    try {
      localStorage.setItem('epoch.recent', JSON.stringify(next));
    } catch {}
    setSearchOpen(false);
    setQuery('');
    router.push(`/validators/${encodeURIComponent(vote)}`);
  }
  const rows = validators.data?.rows ?? [];
  const term = query.trim();
  const matches = term
    ? rows.filter((r) => `${r.name} ${r.vote}`.toLowerCase().includes(term.toLowerCase()))
    : recent.flatMap((v) => rows.filter((r) => r.vote === v));
  const wallet = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(term);
  const transaction = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(term);
  if (pathname === '/me' && !params.get('address') && params.get('demo') !== '1' && !session.data)
    return <main id="main-content">{children}</main>;
  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Sidebar collapsible="offcanvas" className="ep-sidebar">
        <SidebarHeader className="h-16 justify-center px-5">
          <Link href="/" className="flex items-center gap-3 text-[17px] font-semibold tracking-tight">
            <EpochMark className="size-7" />
            <span>epoch</span>
            <span className="ep-net-chip ml-auto">
              <i /> Mainnet
            </span>
          </Link>
        </SidebarHeader>
        <SidebarContent className="px-1">
          {navigation.map((g) => (
            <SidebarGroup key={g.group}>
              <SidebarGroupLabel>{g.group}</SidebarGroupLabel>
              <Navigation items={g.items} />
            </SidebarGroup>
          ))}
          <SidebarGroup>
            <SidebarGroupLabel>Build</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={
                    <a
                      href="https://github.com/Sushant6095/epoch-protocol/tree/main/docs"
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  <BookOpen />
                  <span>Documentation</span>
                  <ExternalLink className="ml-auto opacity-60" />
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<a href="https://github.com/Sushant6095/epoch-protocol" target="_blank" rel="noreferrer" />}
                >
                  <Code2 />
                  <span>Program source</span>
                  <ExternalLink className="ml-auto opacity-60" />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="p-3">
          {n ? (
            <button type="button" className="ep-clock" onClick={() => setEpochOpen(true)} aria-label={`Epoch ${n.epoch.number}, ${progress.toFixed(1)}% complete at capture`}>
              <EpochRing progress={progress / 100} size={64} stroke={6} ticks={false} tone="ink" />
              <span className="ep-clock-text">
                <strong className="num">Epoch {n.epoch.number}</strong>
                <span className="num">{progress.toFixed(1)}% · slot {(n.epoch.startSlot + n.epoch.slotIndex).toLocaleString('en-US')}</span>
                <span>
                  {fmtNum(n.tps.total)} TPS · {n.finalitySeconds}s finality
                </span>
                <em>Snapshot {new Date(n.asOf!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}</em>
              </span>
            </button>
          ) : (
            <Skeleton className="h-20" />
          )}
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <div className="ep-ambient" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <header className="ep-topbar sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 px-4 lg:px-8">
          <SidebarTrigger className="size-11 shrink-0 md:hidden" />
          <div className="hidden min-w-0 items-center gap-2 text-sm lg:flex">
            <span className="text-muted-foreground">Epoch</span>
            <span className="text-muted-foreground">/</span>
            <span className="font-medium">{titles['/' + pathname.split('/')[1]] ?? 'Workspace'}</span>
          </div>
          <Button
            variant="outline"
            ref={searchTrigger}
            onClick={() => setSearchOpen(true)}
            className="ep-search min-w-0 flex-1 justify-start text-muted-foreground lg:ml-6 lg:max-w-md"
          >
            <Search />
            <span className="truncate">Search validators, wallets, signatures</span>
            <kbd className="ml-auto hidden text-xs num sm:inline">⌘K</kbd>
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="ep-epoch-chip hidden lg:inline-flex"
              ref={epochTrigger}
              onClick={() => setEpochOpen(true)}
            >
              <EpochRing progress={progress / 100} size={22} stroke={3} ticks={false} />
              <span className="num">E{n?.epoch.number ?? '—'}</span>
              <span className="num text-muted-foreground">{progress.toFixed(1)}%</span>
            </button>
            <span
              className="ep-price-chip hidden num xl:inline-flex"
              title={n ? `${n.source} · ${n.asOf} (historical snapshot)` : 'Loading snapshot'}
            >
              SOL <b>{n ? `$${n.price.solUsd?.toFixed(2) ?? '—'}` : '—'}</b>
            </span>
            <ConnectButton />
          </div>
        </header>
        <main id="main-content" className="ep-main flex min-w-0 flex-1 flex-col gap-6 p-4 lg:p-8">
          {children}
          {journey && (
            <Link className="ep-next" href={journey.href}>
              <span>{journey.text}</span>
              <strong>
                {journey.next} <ArrowRight className="size-4" />
              </strong>
            </Link>
          )}
        </main>
      </SidebarInset>
      <CommandDialog
        finalFocus={searchTrigger}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search Epoch"
        description="Search the historical validator snapshot, view a wallet, or open a transaction."
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Validator name, vote account, wallet or signature"
          />
          <CommandList>
            <CommandEmpty>
              {validators.isPending ? 'Loading validators…' : 'No match. Paste a vote account, wallet or signature.'}
            </CommandEmpty>
            <CommandGroup heading={term ? 'Validators' : 'Recent'}>
              {matches.map((r) => (
                <CommandItem key={r.vote} value={r.vote} onSelect={() => go(r.vote)}>
                  <Server />
                  <span className="min-w-0 truncate" title={r.name}>
                    {r.name}
                  </span>
                  <span className="ml-auto shrink-0 text-xs num text-muted-foreground">{r.voteShort}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {wallet && (
              <CommandGroup heading="Wallet">
                <CommandItem
                  value="wallet"
                  onSelect={() => {
                    setSearchOpen(false);
                    router.push(`/me?address=${encodeURIComponent(term)}`);
                  }}
                >
                  View address in read-only mode
                </CommandItem>
              </CommandGroup>
            )}
            {transaction && (
              <CommandGroup heading="Transaction">
                <CommandItem
                  value="transaction"
                  onSelect={() => {
                    window.open(`https://orbmarkets.io/tx/${term}`, '_blank', 'noopener,noreferrer');
                    setSearchOpen(false);
                  }}
                >
                  Open transaction on Orb <ExternalLink />
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
      <ConnectDialog />
      <Dialog open={epochOpen} onOpenChange={setEpochOpen}>
        <DialogContent finalFocus={epochTrigger}>
          <DialogHeader>
            <DialogTitle>Epoch {n?.epoch.number ?? '—'}</DialogTitle>
            <DialogDescription>
              This is the handover’s historical mainnet snapshot, not a live connection. The epoch progress is frozen at
              its capture time.
            </DialogDescription>
          </DialogHeader>
          <p className="num">{n ? `${progress.toFixed(1)}% complete at capture` : 'Snapshot loading…'}</p>
          <p className="text-sm text-muted-foreground">
            {n?.source}
            <br />
            {n?.asOf}
          </p>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
