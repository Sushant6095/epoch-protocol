'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { gsap } from '@/lib/gsap';

/**
 * Opening sequence: sync counter → the Epoch mark draws itself → wordmark rises → an iris opens from the
 * mark onto the hero. Once per browser session, skippable (click, Esc, button), off for reduced motion.
 * Sets <html data-intro="on"> synchronously (child layout effects run before the page's) so the hero
 * choreography can wait for the reveal.
 */
export const INTRO_SECONDS = 3.1;

export function Intro({ epoch = 1044, startSlot = 451_403_700 }: { epoch?: number; startSlot?: number }) {
  const root = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(true);

  useLayoutEffect(() => {
    // the pre-paint script in the root layout decides whether the intro plays this session
    if (document.documentElement.dataset.intro !== 'on' || !root.current) {
      if (document.documentElement.dataset.intro === 'on') {
        delete document.documentElement.dataset.intro;
        window.dispatchEvent(new Event('epoch:intro-done'));
      }
      setShow(false);
      return;
    }
    document.documentElement.style.overflow = 'hidden';
    const el = root.current;
    const q = gsap.utils.selector(el);
    const count = { v: 0 };
    const pct = q('.it-pct')[0] as HTMLElement;
    const slot = q('.it-slot')[0] as HTMLElement;

    const finish = () => {
      try {
        sessionStorage.setItem('epoch.intro', '1');
      } catch {}
      document.documentElement.style.overflow = '';
      delete document.documentElement.dataset.intro;
      window.dispatchEvent(new Event('epoch:intro-done'));
      setShow(false);
    };

    const tl = gsap.timeline({ defaults: { ease: 'expo.out' }, onComplete: finish });
    tl.set(el, { '--hole': '0px' })
      .to(count, {
        v: 100,
        duration: 1.6,
        ease: 'power2.inOut',
        onUpdate: () => {
          pct.textContent = String(Math.round(count.v)).padStart(3, '0');
          slot.textContent = (startSlot + Math.round(count.v * 3)).toLocaleString('en-US');
        },
      }, 0)
      .to(q('.it-bar i'), { scaleX: 1, duration: 1.6, ease: 'power2.inOut' }, 0)
      .fromTo(q('.it-arc'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.9, stagger: 0.16, ease: 'power3.inOut' }, 0.15)
      .fromTo(q('.it-arrow'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.5, ease: 'power3.out' }, 0.75)
      .fromTo(q('.it-glow'), { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.2 }, 0.4)
      .fromTo(q('.it-word span'), { y: 0, yPercent: 110, opacity: 0 }, { y: 0, yPercent: 0, opacity: 1, duration: 0.8, stagger: 0.05 }, 0.9)
      .to(q('.it-meta, .it-bar, .it-skip'), { opacity: 0, duration: 0.3 }, 1.75)
      .to(q('.it-mark'), { scale: 1.25, duration: 0.6, ease: 'power3.in' }, 1.95)
      .to(q('.it-word'), { opacity: 0, y: -12, duration: 0.35 }, 1.95)
      .call(() => window.dispatchEvent(new Event('epoch:intro-reveal')), [], 2.1)
      .to(el, { '--hole': '150vmax', duration: 1.05, ease: 'expo.inOut' }, 2.15)
      .to(q('.it-mark'), { opacity: 0, scale: 2.2, duration: 0.7, ease: 'power2.in' }, 2.2);

    // ?intro replays the sequence on demand; ?freeze=<seconds> holds it at that moment (design review).
    const params = new URLSearchParams(location.search);
    const freeze = params.get('freeze');
    if (freeze && !Number.isNaN(+freeze)) tl.pause(+freeze);
    else if (params.has('intro')) history.replaceState(history.state, '', location.pathname + location.hash);
    const skip = () => tl.progress(1);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && skip();
    window.addEventListener('keydown', onKey);
    el.addEventListener('click', skip);
    return () => {
      window.removeEventListener('keydown', onKey);
      el.removeEventListener('click', skip);
      tl.kill();
      document.documentElement.style.overflow = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!show) return null;
  return (
    <div ref={root} className="it" role="presentation" aria-hidden="true">
      <div className="it-center">
        <span className="it-glow" />
        <svg className="it-mark" viewBox="0 0 40 40" fill="none">
          <path className="it-arc" d="M32.8 10.2a16 16 0 1 0 0 19.6" />
          <path className="it-arc" d="M28.1 14a10 10 0 1 0 0 12" />
          <path className="it-arc" d="M23.2 17.6a4 4 0 1 0 0 4.8" />
          <path className="it-arrow" d="M22 20h14M31 15l5 5-5 5" />
        </svg>
        <div className="it-word">
          {'epoch'.split('').map((c, i) => (
            <span key={i}>{c}</span>
          ))}
        </div>
      </div>
      <div className="it-meta it-meta-left num">
        <span>Syncing epoch {epoch}</span>
        <span>
          slot <b className="it-slot">{startSlot.toLocaleString('en-US')}</b>
        </span>
      </div>
      <div className="it-meta it-meta-right num">
        <b className="it-pct">000</b>
      </div>
      <div className="it-bar">
        <i />
      </div>
      <button type="button" className="it-skip">
        Skip intro
      </button>
    </div>
  );
}
