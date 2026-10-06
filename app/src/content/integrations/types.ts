// The shape of an integration showcase: what the sponsor product is used for, how the data flows, why it matters,
// and what has been verified. Rendered by components/integrations/showcase.tsx at the bottom of each page.

export type FlowNodeKind = "sponsor" | "ours" | "chain" | "page";

export interface FlowNode {
  title: string;
  detail: string;
  kind: FlowNodeKind;
}

/** A left-to-right chain: nodes with the label of each arrow between them (`edges.length === nodes.length - 1`). */
export interface Flow {
  title: string;
  nodes: FlowNode[];
  edges: string[];
}

export interface SourceLink {
  label: string;
  /** Repo-relative path (linked on GitHub). */
  path: string;
}

export interface ProductUse {
  /** The sponsor product or API, e.g. "Yellowstone gRPC". */
  product: string;
  /** What Epoch uses it for, in plain words. */
  use: string;
  /** Exact calls or methods, shown in mono. */
  calls?: string[];
  files: SourceLink[];
}

export interface VerifiedRun {
  title: string;
  /** IST, as written in the run's record. */
  when: string;
  /** e.g. "46 / 46 checks". */
  result: string;
  detail: string;
  link: SourceLink;
}

export interface Integration {
  id: "solami" | "panta" | "meteora";
  sponsor: string;
  track: string;
  prize: string;
  judgedOn: string[];
  /** The Epoch page built for the track. */
  page: { href: string; label: string };
  /** A short headline for the hub card. */
  headline: string;
  /** One line: what the integration is. */
  oneLiner: string;
  products: ProductUse[];
  flows: Flow[];
  why: { problem: string; unlocks: string[] };
  runs: VerifiedRun[];
  /** Honest next steps (what is not proven yet), shown under the runs. */
  next?: string;
  docs: SourceLink[];
}
