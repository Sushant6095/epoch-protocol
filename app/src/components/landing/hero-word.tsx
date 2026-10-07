'use client';
import { useEffect, useState } from 'react';

/** Ramp-style kinetic word: cycles who Epoch serves. Screen readers get the full static sentence. */
const WORDS = ['validators', 'stakers', 'lenders'];

export function HeroWord({ paused = false }: { paused?: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setI((x) => (x + 1) % WORDS.length), 2600);
    return () => clearInterval(id);
  }, [paused]);
  return (
    <span className="lx-word" aria-label="validators, stakers and lenders">
      <span className="lx-word-sizer" aria-hidden="true">
        validators
      </span>
      {WORDS.map((w, k) => (
        <span key={w} className="lx-word-item" data-state={k === i ? 'in' : k === (i + WORDS.length - 1) % WORDS.length ? 'out' : 'wait'} aria-hidden="true">
          {w}
        </span>
      ))}
    </span>
  );
}
