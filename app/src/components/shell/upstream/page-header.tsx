import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Page title row: eyebrow (sponsor / track), H1 (32/40), one line under it, badges and actions on the right. */
export function PageHeader({
  eyebrow,
  title,
  description,
  badges,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between", className)}>
      <div className="flex min-w-0 flex-col gap-2">
        {eyebrow ? <p className="label-caps">{eyebrow}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-ep-text sm:text-4xl">{title}</h1>
          {badges}
        </div>
        {description ? <p className="max-w-3xl text-sm leading-relaxed text-ep-text-2 sm:text-base">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
