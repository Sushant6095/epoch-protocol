'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import Lenis from 'lenis';
import NumberFlow from '@number-flow/react';
import { ArrowRight, ArrowUpRight, Code2, Database, Pause, Play, Radio, Scale } from 'lucide-react';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { EpochMark } from '@/components/epoch/epoch-mark';
import { compact, fmt, OperatorLogo } from '@/components/epoch/shared';
import { useNetwork } from '@/lib/data/useNetwork';
import { useValidators } from '@/lib/data/useValidators';
import { gsap, useGSAP, ScrollTrigger, withMotion } from '@/lib/gsap';
const HorizonScene = dynamic(() => import('@/components/landing/horizon-scene'), { ssr: false });
import { SiteHeader } from '@/components/landing/site-header';
import { TerminalShot } from '@/components/landing/terminal-shot';
import { ProductTour } from '@/components/landing/product-tour';
import { AdvanceCalculator } from '@/components/landing/advance-calculator';
import { NetworkHero } from '@/components/epoch/network-hero';
import { HeroWord } from '@/components/landing/hero-word';
import { OpenCards, EpochOrbit } from '@/components/landing/open-cards';
import { EarthVideo } from '@/components/landing/earth-video';
import { Intro } from '@/components/landing/intro';


const faq = [
  [
    'What is Epoch?',
    'The revenue desk for Solana validators. Operators can borrow SOL against revenue they will earn in the coming epochs, lenders fund those advances through a two-tranche Vault, and every staker gets a clear view of validator health in the Terminal.',
  ],
  [
    'Does my staked SOL move into the Vault?',
    'No. Native stake stays in your own stake account. Lending through the Vault is a separate deposit, and Vault SOL is not staked: unlent SOL earns nothing.',
  ],
  [
    'How is an advance repaid?',
    'At the source. Each epoch the program sweeps half of what the validator’s accounts collect until the advance and its flat fee are repaid. If revenue falls short, the validator’s bond absorbs the loss first, then Junior capital, then Senior.',
  ],
  [
    'Where does a lender’s return come from?',
    'From the fees validators pay on advances. Senior has a target rate that is paid first; Junior keeps everything above it and takes losses before Senior. A target is never a guarantee.',
  ],
  [
    'Can I deposit today?',
    'Not yet. Epoch is pre-alpha and unaudited. The Terminal uses a dated mainnet snapshot, and Vault and advance figures are labelled as samples until the program is live.',
  ],
];

function Stat({ value, label, note }: { value?: number | null; label: string; note: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold: 0.6 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="lx-stat">
      <strong className="num">{value == null ? '—' : <NumberFlow value={seen ? value : 0} />}</strong>
      <span>{label}</span>
      <small>{note}</small>
    </div>
  );
}

export default function Home() {
  const network = useNetwork();
  const validators = useValidators();
  const n = network.data;
  const root = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  // real footage when /earth/hero.mp4 plays; the live 3D Earth otherwise
  const [footage, setFootage] = useState(true);
  const noFootage = useCallback(() => setFootage(false), []);
  const scroll = useRef(0);
  const progress = n ? n.epoch.slotIndex / n.epoch.slotsInEpoch : 0.9;
  const history = n?.validatorCountHistory ?? [];
  const peak = history[0];
  const lost = peak && n ? Math.round((1 - n.validators.total / peak.count) * 100) : null;
  const operators = (validators.data?.rows ?? []).filter((r) => r.name && r.name !== 'Unnamed').slice(0, 26);

  // Lenis smooth scroll on the landing only, driven by GSAP's ticker so ScrollTrigger stays in sync.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const lenis = new Lenis({ lerp: 0.11, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    const tick = (t: number) => lenis.raf(t * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);

  useGSAP(
    () => {
      withMotion(() => {
        const waiting = document.documentElement.dataset.intro === 'on';
        const tl = gsap.timeline({ defaults: { ease: 'expo.out' }, paused: waiting });
        if (waiting) window.addEventListener('epoch:intro-done', () => tl.play(), { once: true });
        tl.from('.lx-hero-pill', { y: 12, autoAlpha: 0, duration: 0.9 }, 0.15)
          .from('.lx-hero h1 .lx-line > span', { yPercent: 110, duration: 1.2, stagger: 0.09 }, 0.22)
          .from('.lx-hero-sub, .lx-hero-ctas', { y: 16, autoAlpha: 0, duration: 1, stagger: 0.08 }, 0.6)
          .from('.lx-stage-inner', { y: 140, autoAlpha: 0, duration: 1.6 }, 0.55)
          .from('.lx-hero-bg', { autoAlpha: 0, duration: 2.2, ease: 'power2.out' }, 0);

        // Pinned zoom: the camera dollies into the horizon while the Terminal scales up to fill the view.
        const mm = gsap.matchMedia();
        mm.add('(min-width: 900px)', () => {
          const fit = () => {
            const shot = document.querySelector<HTMLElement>('.lx-stage-inner');
            if (!shot) return 1;
            const h = shot.offsetHeight;
            return Math.min(1, (window.innerHeight - 96) / h);
          };
          const pin = gsap.timeline({
            defaults: { ease: 'none' },
            scrollTrigger: {
              trigger: '.lx-hero',
              start: 'top top',
              end: '+=140%',
              pin: true,
              scrub: 0.7,
              invalidateOnRefresh: true,
              onUpdate: (self) => (scroll.current = self.progress),
            },
          });
          pin
            .to('.lx-hero-copy', { yPercent: -40, autoAlpha: 0, duration: 0.45 }, 0)
            .fromTo(
              '.lx-stage',
              { y: () => window.innerHeight * 0.9, scale: 0.72, rotateX: 26 },
              { y: () => (window.innerHeight - document.querySelector<HTMLElement>('.lx-stage-inner')!.offsetHeight * fit()) / 2 + 20, scale: () => fit(), rotateX: 0, duration: 1 },
              0,
            )
            .to('.lx-hero-bg', { autoAlpha: 0.12, duration: 0.6 }, 0.4);
        });
        mm.add('(max-width: 899px)', () => {
          scroll.current = 0;
        });
        gsap.utils.toArray<HTMLElement>('.lx-reveal').forEach((el) => {
          gsap.from(el, {
            y: 36,
            autoAlpha: 0,
            duration: 1.1,
            ease: 'expo.out',
            scrollTrigger: { trigger: el, start: 'top 88%', once: true },
          });
        });
        gsap.from('.lx-decline path.lx-decline-line', {
          drawSVG: '0%',
          duration: 1.6,
          ease: 'power2.inOut',
          scrollTrigger: { trigger: '.lx-decline', start: 'top 80%', once: true },
        });
      });
    },
    { scope: root },
  );

  useEffect(() => {
    root.current?.toggleAttribute('data-paused', paused);
  }, [paused]);

  return (
    <div ref={root} className="lx">
      <Intro epoch={n?.epoch.number} startSlot={n ? n.epoch.startSlot + n.epoch.slotIndex : undefined} />
      <a href="#main" className="lx-skip">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        {/* ── Hero ─────────────────────────────────────────── */}
        <section className="lx-hero" aria-labelledby="hero-title">
          <div className="lx-hero-bg" aria-hidden="true">
            {footage ? (
              <EarthVideo paused={paused} onFail={noFootage} />
            ) : (
              <HorizonScene scroll={scroll} paused={paused} total={n?.validators.total} belowBreakEven={n?.validators.belowBreakEven} />
            )}
          </div>
          <div className="lx-hero-copy">
            <Link href="/terminal" className="lx-hero-pill">
              <i className="lx-live" aria-hidden="true" />
              <span className="num">Epoch {n?.epoch.number ?? '—'}</span>
              <span className="lx-pill-sep" aria-hidden="true" />
              <span>{(progress * 100).toFixed(1)}% through · snapshot</span>
              <ArrowRight size={14} />
            </Link>
            <h1 id="hero-title">
              <span className="lx-line">
                <span>The revenue desk</span>
              </span>
              <span className="lx-line">
                <span>
                  for Solana <HeroWord paused={paused} />
                </span>
              </span>
            </h1>
            <p className="lx-hero-sub">
              Validators borrow SOL against the revenue they’ll earn next, repaid <em>at the source, every epoch</em>.
              Lenders and stakers see every number behind it.
            </p>
            <div className="lx-hero-ctas">
              <Link href="/terminal" className="lx-btn lx-btn-light">
                Open the Terminal <ArrowUpRight size={17} />
              </Link>
              <Link href="/vault" className="lx-btn lx-btn-ghost">
                Explore the Vault
              </Link>
            </div>
            {n && (
              <dl className="lx-hero-stats">
                <div>
                  <dt>Staked on Solana</dt>
                  <dd className="num">{compact(n.stake.totalSol)} SOL</dd>
                </div>
                <div>
                  <dt>Active validators</dt>
                  <dd className="num">{fmt(n.validators.total)}</dd>
                </div>
                <div>
                  <dt>Under break-even</dt>
                  <dd className="num" data-tone="amber">
                    {fmt(n.validators.belowBreakEven)}
                  </dd>
                </div>
                <div>
                  <dt>Median APY</dt>
                  <dd className="num">{fmt(n.stake.medianApyPct, 2)}%</dd>
                </div>
              </dl>
            )}
          </div>
          <div className="lx-stage" id="terminal">
            <div className="lx-stage-inner">
              <TerminalShot />
            </div>
          </div>
        </section>

        <div className="lx-light">
        {/* ── Operators strip ──────────────────────────────── */}
        <section className="lx-operators" aria-label="Validators in the Epoch directory">
          <p>
            Tracking the operators behind <b className="num">{compact(n?.stake.totalSol)} SOL</b> of stake
          </p>
          <div className="lx-marquee" aria-hidden="true">
            <div className="lx-marquee-track">
              {[0, 1].map((k) => (
                <div key={k} className="lx-marquee-set">
                  {operators.map((r) => (
                    <span key={`${k}-${r.vote}`} className="lx-op-mark">
                      <OperatorLogo name={r.name} vote={r.vote} size={30} />
                      {r.name}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <small>Directory listings, not endorsements or partnerships.</small>
        </section>

        {/* ── The problem ─────────────────────────────────── */}
        <section className="lx-section lx-problem" aria-labelledby="problem-title">
          <div className="lx-wrap">
            <div className="lx-problem-head lx-reveal">
              <p className="lx-eyebrow">The problem</p>
              <h2 id="problem-title">
                Solana’s validator set is shrinking.
                <span> Running one is paid in arrears.</span>
              </h2>
              <p className="lx-lede">
                Operators pay for hardware, bandwidth and roughly {fmt(n?.voteFeesPerEpochSol, 2)} SOL of vote fees every epoch
                before a single reward arrives. Their revenue is predictable, yet nobody on Solana lends against it.
              </p>
            </div>
            <div className="lx-problem-grid">
              <div className="lx-decline lx-reveal">
                <div className="lx-decline-head">
                  <span>Active validators</span>
                  {lost != null && <b className="num">−{lost}% since {peak?.date.slice(0, 4)}</b>}
                </div>
                <strong className="num">
                  {fmt(peak?.count)} <ArrowRight size={28} /> {fmt(n?.validators.total)}
                </strong>
                <svg viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M0 14 C 120 20, 200 86, 300 96 S 380 104, 400 106" className="lx-decline-line" />
                  <circle cx="400" cy="106" r="4" />
                </svg>
                <div className="lx-decline-axis num">
                  {history.map((h) => (
                    <span key={h.date}>
                      {h.date.slice(0, 7)} · {fmt(h.count)}
                    </span>
                  ))}
                </div>
              </div>
              <Stat
                value={n?.validators.belowBreakEven}
                label="earn less than their vote fees"
                note={`Break-even sits near ${compact(n?.breakEvenStakeSol)} SOL of stake`}
              />
              <Stat
                value={n?.validators.dependOnOneDelegator}
                label="depend on a single delegator"
                note="One withdrawal away from losing most of their stake"
              />
              <Stat
                value={n?.validators.dependOnFoundation}
                label="lean on Foundation delegation"
                note={`Out of ${fmt(n?.validators.total)} active validators`}
              />
            </div>
            <p className="lx-source">
              <Database size={13} /> {n?.source ?? 'Loading source'} · snapshot {n?.asOf?.slice(0, 10) ?? '—'}
            </p>
          </div>
        </section>

        {/* ── Network anatomy (technical) ────────────────────── */}
        {n && (
          <section className="lx-section" aria-labelledby="anatomy-title">
            <div className="lx-wrap">
              <div className="lx-anatomy-intro lx-reveal">
                <div>
                  <p className="lx-eyebrow">Built on Solana’s clock</p>
                  <h2 id="anatomy-title">Every number runs on the epoch.</h2>
                </div>
                <p className="lx-lede">
                  An epoch is {fmt(n.epoch.slotsInEpoch)} slots, about {fmt(n.epoch.hoursPerEpoch, 1)} hours. Rewards, stake changes,
                  the Fee Index and every repayment settle on that boundary, so the Terminal is built around it.
                </p>
              </div>
              <div className="lx-reveal">
                <NetworkHero n={n} title="The Terminal" headingLevel="h3" />
              </div>
              <div className="lx-anatomy-notes">
                <div className="lx-reveal">
                  <strong>Repaid from the vote account</strong>
                  <p>
                    An Epoch PDA holds the vote account’s withdraw authority, so the program sweeps <code>remit_bps</code> of
                    commission each epoch before the operator can move it.
                  </p>
                </div>
                <div className="lx-reveal">
                  <strong>Scored, then sized</strong>
                  <p>
                    Epoch Score combines vote performance, commission and tenure into one health signal. Below{' '}
                    <code>min_score</code> 60, no advance.
                  </p>
                </div>
                <div className="lx-reveal">
                  <strong>A public fee benchmark</strong>
                  <p>
                    The Fee Index is the stake-weighted median priority fee per epoch in µL/CU, proposed, disputable, then
                    final, and published on-chain.
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ── Product tour ─────────────────────────────────── */}
        <section className="lx-section" aria-labelledby="tour-title">
          <div className="lx-wrap">
            <div className="lx-split-head lx-reveal">
              <div>
                <p className="lx-eyebrow">One desk, three sides</p>
                <h2 id="tour-title">Stakers, operators and lenders, looking at the same numbers.</h2>
              </div>
              <p className="lx-lede">
                Epoch connects validator research, revenue-backed credit and a lending vault. Each side sees the data the
                other relies on.
              </p>
            </div>
            <div className="lx-reveal">
              <ProductTour paused={paused} />
            </div>
          </div>
        </section>

        {/* ── How an advance works ─────────────────────────── */}
        <section className="lx-section lx-how" aria-labelledby="how-title">
          <div className="lx-wrap">
            <div className="lx-how-grid">
              <div className="lx-how-copy lx-reveal">
                <p className="lx-eyebrow">How an advance works</p>
                <h2 id="how-title">Credit sized by revenue. Repaid by revenue.</h2>
                <ol className="lx-steps">
                  <li>
                    <span className="num">01</span>
                    <div>
                      <strong>Post a bond, get a limit</strong>
                      <p>The limit is the lower of a share of the last ten epochs’ revenue and a multiple of the bond.</p>
                    </div>
                  </li>
                  <li>
                    <span className="num">02</span>
                    <div>
                      <strong>Draw SOL from the Vault</strong>
                      <p>Funded by lenders, with a flat fee. Validators below an Epoch Score of 60 cannot borrow.</p>
                    </div>
                  </li>
                  <li>
                    <span className="num">03</span>
                    <div>
                      <strong>Repay at the source</strong>
                      <p>Each epoch, half of the collected revenue is swept to the Vault until the advance is clear.</p>
                    </div>
                  </li>
                </ol>
              </div>
              <div className="lx-reveal">
                <AdvanceCalculator />
              </div>
            </div>
          </div>
        </section>

        {/* ── Built in the open ────────────────────────────── */}
        <section className="lx-section" aria-labelledby="open-title">
          <div className="lx-wrap">
            <div className="lx-split-head lx-reveal">
              <div>
                <p className="lx-eyebrow">Built in the open</p>
                <h2 id="open-title">Every rule on-chain. Every number sourced.</h2>
              </div>
            </div>
            <OpenCards />
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────── */}
        <section className="lx-section lx-faq" aria-labelledby="faq-title">
          <div className="lx-wrap lx-faq-grid">
            <div className="lx-reveal">
              <p className="lx-eyebrow">Questions</p>
              <h2 id="faq-title">Straight answers.</h2>
              <EpochOrbit />
            </div>
            <Accordion className="lx-accordion lx-reveal">
              {faq.map(([q, a], i) => (
                <AccordionItem value={i} key={q}>
                  <AccordionTrigger>{q}</AccordionTrigger>
                  <AccordionContent>{a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        </div>
        {/* ── Closing ──────────────────────────────────────── */}
        <section className="lx-closing" aria-labelledby="closing-title">
          <div className="lx-closing-glow" aria-hidden="true" />
          <div className="lx-wrap lx-reveal">
            <EpochMark width={44} height={44} />
            <h2 id="closing-title">Every epoch, a clearer view.</h2>
            <p>Start with the network. Then look at the operator behind your stake.</p>
            <div className="lx-hero-ctas">
              <Link href="/terminal" className="lx-btn lx-btn-light">
                Open the Terminal <ArrowUpRight size={17} />
              </Link>
              <Link href="/me" className="lx-btn lx-btn-ghost">
                Check my stake
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="lx-footer">
        <div className="lx-wrap lx-footer-grid">
          <div className="lx-footer-brand">
            <Link href="/" className="lx-logo">
              <EpochMark width={24} height={24} />
              <span>epoch</span>
            </Link>
            <p>The revenue desk for Solana validators.</p>
            <small>Pre-alpha · unaudited. Historical returns and targets are not guarantees.</small>
          </div>
          {[
            ['Product', [['Terminal', '/terminal'], ['Validators', '/validators'], ['Vault', '/vault'], ['My Stake', '/me']]],
            ['Vault', [['Protection & risks', '/vault?tab=protection'], ['Loan book', '/vault?tab=loans'], ['Parameters', '/vault?tab=params']]],
            ['Developers', [['GitHub', 'https://github.com/Sushant6095/epoch-protocol'], ['Fee Index', '/terminal']]],
          ].map(([title, links]) => (
            <div key={title as string} className="lx-footer-col">
              <p>{title as string}</p>
              {(links as string[][]).map(([label, href]) => (
                <Link key={label} href={href}>
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </div>
        <div className="lx-wrap lx-footer-base">
          <span className="num">© 2026 Epoch · Solana mainnet snapshot {n?.asOf?.slice(0, 10) ?? ''}</span>
          <button
            type="button"
            className="lx-motion"
            onClick={() => setPaused(!paused)}
            aria-label={paused ? 'Resume animations' : 'Pause animations'}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
            {paused ? 'Resume motion' : 'Pause motion'}
          </button>
        </div>
      </footer>
    </div>
  );
}
