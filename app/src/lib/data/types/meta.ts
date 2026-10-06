// Mirrored from packages/api_app/src/types/Api.types.ts (the API's response types; docs/pages/*.md are the contract).
// Keep in sync when the API changes. Units live in field names; null means "not known yet" and renders as "—".

export interface FeeIndexPoint {
  epoch: number;
  /** Stake-weighted median priority fee, micro-lamports per compute unit. */
  value: number;
}

export type DataKind = 'real' | 'sample' | 'demo';

/** Every payload says where it came from and when. */
export interface Meta {
  schemaVersion: 1;
  kind: DataKind;
  /** ISO 8601 in IST, e.g. `2026-10-01T14:05:00+05:30`. */
  asOf: string;
  source: string;
  note?: string;
}

