'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useValidators } from '@/lib/data/useValidators';
import logos from './validator-logos.json';
function OperatorMark({ name }: { name: string }) {
  const [failed, setFailed] = useState(false);
  const match = Object.entries(logos).find(
    ([label]) => name.toLowerCase().includes(label.toLowerCase()) || label.toLowerCase().includes(name.toLowerCase()),
  );
  return match && !failed ? (
    <img src={match[1].src} alt="" width={32} height={32} loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span className="validator-monogram" aria-hidden="true">
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
export function ValidatorMarquee({ paused }: { paused: boolean }) {
  const query = useValidators();
  const [localPause, setLocalPause] = useState(false);
  const rows = query.data?.rows ?? [];
  return (
    <section className="validator-showcase" aria-label="Solana operators in the Epoch directory">
      <p className="chapter-index num">ONE NETWORK. MANY INDEPENDENT OPERATORS.</p>
      <h2>Meet the names behind the network.</h2>
      <div className="marquee-toolbar">
        <p>Operators in our directory. Not endorsements or partnerships.</p>
        <button
          onClick={() => setLocalPause(!localPause)}
          aria-label={localPause ? 'Resume validator strip' : 'Pause validator strip'}
        >
          {localPause ? <Play size={14} /> : <Pause size={14} />}
        </button>
      </div>
      {query.isError ? (
        <p>
          Operator directory unavailable. <button onClick={() => query.refetch()}>Retry</button>
        </p>
      ) : !rows.length ? (
        <p>Loading operators…</p>
      ) : (
        <div className="validator-marquee" data-paused={paused || localPause}>
          <div className="validator-track">
            {[0, 1].map((copy) => (
              <div className="validator-track-group" key={copy} aria-hidden={copy === 1 || undefined}>
                {rows.map((row) => (
                  <Link href={`/validators/${row.vote}`} key={row.vote} tabIndex={copy === 1 ? -1 : 0}>
                    <OperatorMark name={row.name} />
                    <span>{row.name}</span>
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      <Link className="launch-text-link" href="/validators">
        Explore all validators ↗
      </Link>
    </section>
  );
}
