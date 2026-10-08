'use client';
import Link from 'next/link';
import { ChevronDown, ArrowUpRight } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
const menus = [
  {
    name: 'Terminal',
    intro: 'See the whole network.',
    copy: 'Stake movement, operator economics and the context behind each epoch.',
    links: [
      ['Network overview', 'Stake, validators and network activity', '/terminal'],
      ['Stake arriving', 'Follow new delegation', '/terminal?flow=arriving'],
      ['Stake leaving', 'Understand deactivation', '/terminal?flow=leaving'],
      ['My Stake', 'Find the operators behind your SOL', '/me'],
    ],
  },
  {
    name: 'Validators',
    intro: 'Know the operator.',
    copy: 'Compare the people running Solana, then look inside their economics.',
    links: [
      ['Explore validators', 'Search and compare network operators', '/validators'],
      ['Validator watchlist', 'Return to your saved operators', '/validators?tab=watchlist'],
      ['Independent operators', 'Explore beyond the largest validators', '/validators?chips=hide-top18'],
    ],
  },
  {
    name: 'Vault',
    intro: 'Understand the capital.',
    copy: 'Explore the proposed advance model, repayment and lender risk.',
    links: [
      ['Vault overview', 'Senior and Junior capital', '/vault'],
      ['Protection & risks', 'Understand the loss order', '/vault?tab=protection'],
      ['Loan book', 'Inspect advances and repayments', '/vault?tab=loans'],
      ['Withdrawal queue', 'Review queued withdrawals', '/vault?tab=queue'],
      ['Protocol parameters', 'Inspect the model’s rules', '/vault?tab=params'],
    ],
  },
];
export function LandingNavigation() {
  return (
    <nav className="landing-product-nav" aria-label="Main navigation">
      {menus.map((menu) => (
        <DropdownMenu key={menu.name}>
          <DropdownMenuTrigger className="landing-menu-trigger">
            {menu.name}
            <ChevronDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="landing-mega-menu" sideOffset={18} align="center">
            <div className="menu-introduction">
              <span className="num">EPOCH / {menu.name.toUpperCase()}</span>
              <strong>{menu.intro}</strong>
              <p>{menu.copy}</p>
              {menu.name === 'Vault' && <small>Pre-alpha model · transactions unavailable</small>}
            </div>
            <div className="menu-destinations">
              {menu.links.map(([title, copy, href]) => (
                <DropdownMenuItem key={title} render={<Link href={href} />} className="landing-menu-link">
                  <span>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </span>
                  <ArrowUpRight size={16} />
                </DropdownMenuItem>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </nav>
  );
}
