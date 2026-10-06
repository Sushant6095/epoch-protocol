// Data-flow diagrams for the integration showcases: sponsor product → our service → our API → this page.
// Built with HTML and inline SVG arrows instead of @xyflow/react: the kit keeps xyflow for the landing, these flows
// are static, and plain markup reflows to a vertical chain at 390 px and reads as text to screen readers.
// Every node names its kind in words (colour never carries meaning alone).

import type { Flow, FlowNodeKind } from "@/content/integrations";
import { cn } from "@/lib/utils";

const KIND: Record<FlowNodeKind, { tag: string; box: string; tagClass: string }> = {
  sponsor: { tag: "Sponsor", box: "border-ep-info-line bg-ep-info-soft", tagClass: "text-ep-info" },
  ours: { tag: "Epoch", box: "border-ep-line-strong bg-ep-surface", tagClass: "text-ep-muted" },
  chain: { tag: "On chain", box: "border-ep-line bg-ep-inset", tagClass: "text-ep-text-2" },
  page: { tag: "This page", box: "border-ep-accent-line bg-ep-accent-soft", tagClass: "text-ep-accent" },
};

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 px-1 py-1 md:w-24 md:flex-col md:gap-1 md:py-0" aria-hidden>
      <svg viewBox="0 0 64 12" className="hidden h-3 w-full md:block" preserveAspectRatio="none">
        <path d="M0 6 H58" stroke="var(--ep-line-strong)" strokeWidth="1.5" fill="none" strokeDasharray="3 3" />
        <path d="M56 2 L62 6 L56 10" stroke="var(--ep-muted)" strokeWidth="1.5" fill="none" />
      </svg>
      <svg viewBox="0 0 12 24" className="h-5 w-3 md:hidden">
        <path d="M6 0 V19" stroke="var(--ep-line-strong)" strokeWidth="1.5" fill="none" strokeDasharray="3 3" />
        <path d="M2 17 L6 23 L10 17" stroke="var(--ep-muted)" strokeWidth="1.5" fill="none" />
      </svg>
      <span className="text-center text-xs leading-tight text-ep-muted">{label}</span>
    </div>
  );
}

export function FlowDiagram({ flow, className }: { flow: Flow; className?: string }) {
  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      <figcaption className="label-caps">{flow.title}</figcaption>
      <ol className="flex flex-col items-stretch md:flex-row md:items-stretch">
        {flow.nodes.map((node, i) => (
          <li key={node.title} className="flex min-w-0 flex-1 flex-col items-stretch md:flex-row">
            <div className={cn("flex min-w-0 flex-1 flex-col gap-1 rounded-lg border p-3", KIND[node.kind].box)}>
              <span className={cn("label-caps", KIND[node.kind].tagClass)}>{KIND[node.kind].tag}</span>
              <span className="text-sm font-medium text-ep-text">{node.title}</span>
              <span className="text-xs leading-snug text-ep-text-2">{node.detail}</span>
              {i < flow.edges.length ? <span className="sr-only">Then, {flow.edges[i]}:</span> : null}
            </div>
            {i < flow.edges.length ? <Arrow label={flow.edges[i]} /> : null}
          </li>
        ))}
      </ol>
    </figure>
  );
}
