'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  Code2,
  Eye,
  Gauge,
  Layers,
  ListOrdered,
  Menu,
  Rows3,
  ShieldCheck,
  Star,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { EpochMark } from '@/components/epoch/epoch-mark';

type Item = { icon: LucideIcon; title: string; copy: string; href: string };
type MenuDef = { name: string; lead: string; leadCopy: string; leadHref: string; items: Item[] };

const menus: MenuDef[] = [
  {
    name: 'Terminal',
    lead: 'See the whole network',
    leadCopy: 'Stake, validators, fees and protocol activity, one epoch at a time.',
    leadHref: '/terminal',
    items: [
      { icon: Activity, title: 'Network overview', copy: 'Stake, validators and activity', href: '/terminal' },
      { icon: ArrowDownLeft, title: 'Stake arriving', copy: 'Follow new delegation', href: '/terminal?flow=arriving' },
      { icon: ArrowUpRight, title: 'Stake leaving', copy: 'Understand deactivation', href: '/terminal?flow=leaving' },
      { icon: Wallet, title: 'My Stake', copy: 'Find the operators behind your SOL', href: '/me' },
    ],
  },
  {
    name: 'Validators',
    lead: 'Know the operator',
    leadCopy: 'Compare the people running Solana, then look inside their economics.',
    leadHref: '/validators',
    items: [
      { icon: Rows3, title: 'Explore validators', copy: 'Search, filter and compare', href: '/validators' },
      { icon: Star, title: 'Watchlist', copy: 'Return to your saved operators', href: '/validators?tab=watchlist' },
      { icon: Users, title: 'Independent operators', copy: 'Beyond the largest 18', href: '/validators?chips=hide-top18' },
      { icon: Gauge, title: 'Epoch Score', copy: 'How we rate validator health', href: '/validators' },
    ],
  },
  {
    name: 'Vault',
    lead: 'Lend with a risk order',
    leadCopy: 'Senior and Junior capital that funds validator advances. Pre-alpha model.',
    leadHref: '/vault',
    items: [
      { icon: Layers, title: 'Vault overview', copy: 'Senior and Junior tranches', href: '/vault' },
      { icon: ShieldCheck, title: 'Protection & risks', copy: 'Who absorbs a loss, in order', href: '/vault?tab=protection' },
      { icon: ListOrdered, title: 'Loan book', copy: 'Every advance and repayment', href: '/vault?tab=loans' },
      { icon: Eye, title: 'Protocol parameters', copy: 'The rules, read from the program', href: '/vault?tab=params' },
    ],
  },
];

function MenuPanel({ menu, onNavigate }: { menu: MenuDef; onNavigate: () => void }) {
  return (
    <div className="lx-menu-panel" role="menu" aria-label={menu.name}>
      <Link href={menu.leadHref} className="lx-menu-lead" role="menuitem" onClick={onNavigate}>
        <EpochMark width={22} height={22} />
        <strong>{menu.lead}</strong>
        <p>{menu.leadCopy}</p>
        <span>
          Open {menu.name} <ArrowRight size={14} />
        </span>
      </Link>
      <div className="lx-menu-items">
        {menu.items.map(({ icon: Icon, title, copy, href }) => (
          <Link key={title} href={href} className="lx-menu-item" role="menuitem" onClick={onNavigate}>
            <i>
              <Icon size={16} strokeWidth={1.75} />
            </i>
            <span>
              <strong>{title}</strong>
              <small>{copy}</small>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function SiteHeader() {
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(null);
        setMobile(false);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpen(null);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.overflow = mobile ? 'hidden' : '';
    return () => {
      document.documentElement.style.overflow = '';
    };
  }, [mobile]);

  const enter = (name: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(name);
  };
  const leave = () => {
    closeTimer.current = setTimeout(() => setOpen(null), 140);
  };

  return (
    <header className="lx-header" data-scrolled={scrolled || open !== null || undefined}>
      <div className="lx-header-inner">
        <Link href="/" className="lx-logo" aria-label="Epoch home">
          <EpochMark width={26} height={26} />
          <span>epoch</span>
        </Link>
        <nav ref={navRef} className="lx-nav" aria-label="Main">
          {menus.map((menu) => (
            <div
              key={menu.name}
              className="lx-nav-item"
              onPointerEnter={(e) => e.pointerType === 'mouse' && enter(menu.name)}
              onPointerLeave={(e) => e.pointerType === 'mouse' && leave()}
            >
              <button
                type="button"
                className="lx-nav-trigger"
                aria-expanded={open === menu.name}
                aria-haspopup="menu"
                onClick={() => setOpen(open === menu.name ? null : menu.name)}
              >
                {menu.name}
                <ChevronDown size={14} />
              </button>
              <div className="lx-menu-wrap" data-open={open === menu.name || undefined}>
                <MenuPanel menu={menu} onNavigate={() => setOpen(null)} />
              </div>
            </div>
          ))}
          <a
            className="lx-nav-trigger"
            href="https://github.com/Sushant6095/epoch-protocol"
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </a>
        </nav>
        <div className="lx-header-actions">
          <Link href="/me" className="lx-link-quiet">
            Check my stake
          </Link>
          <Link href="/terminal" className="lx-btn lx-btn-light lx-btn-sm">
            Launch app
          </Link>
          <button
            type="button"
            className="lx-burger"
            aria-label={mobile ? 'Close menu' : 'Open menu'}
            aria-expanded={mobile}
            onClick={() => setMobile(!mobile)}
          >
            {mobile ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      <div className="lx-drawer" data-open={mobile || undefined} aria-hidden={!mobile}>
        {menus.map((menu) => (
          <div key={menu.name} className="lx-drawer-group">
            <p>{menu.name}</p>
            {menu.items.map(({ icon: Icon, title, href }) => (
              <Link key={title} href={href} onClick={() => setMobile(false)} tabIndex={mobile ? 0 : -1}>
                <Icon size={17} strokeWidth={1.75} />
                {title}
              </Link>
            ))}
          </div>
        ))}
        <div className="lx-drawer-foot">
          <a href="https://github.com/Sushant6095/epoch-protocol" target="_blank" rel="noreferrer" tabIndex={mobile ? 0 : -1}>
            <Code2 size={17} /> Read the code
          </a>
          <a href="/terminal" className="lx-btn lx-btn-light" tabIndex={mobile ? 0 : -1}>
            Launch app <ArrowUpRight size={16} />
          </a>
        </div>
      </div>
    </header>
  );
}
