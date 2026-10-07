import type { SVGProps } from 'react';
/** Epoch orbit: three open cycles meeting at one decision point. */
export function EpochMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true" {...props}>
      <path
        d="M32.8 10.2a16 16 0 1 0 0 19.6M28.1 14a10 10 0 1 0 0 12M23.2 17.6a4 4 0 1 0 0 4.8"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M22 20h14M31 15l5 5-5 5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
