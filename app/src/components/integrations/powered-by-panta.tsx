// "Powered by Panta" (Panta Terms of Use §6): the exact words, legible, next to Panta-powered data, linked to
// https://panta.market (the payload's poweredByUrl). Never reworded, hidden or shrunk below 12 px.
import { cn } from "@/lib/utils";

export function PoweredByPanta({ className, href = "https://panta.market" }: { className?: string; href?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-ep-line-strong px-2.5 text-xs font-medium text-ep-text-2 transition-colors duration-200 hover:border-ep-field hover:text-ep-text",
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-ep-info" />
      Powered by Panta
    </a>
  );
}
