"use client";
// The transaction stepper every trade, claim and redeem goes through:
//   1 quote → 2 review (explicit consent) → 3 build (Epoch's API) → 4 wallet sign → 5 submit → 6 confirmed (explorer)
// Built on ReUI's stepper (vendored in components/reui), shown as a vertical progress list (the Copperx flow's step
// list). It is a progress indicator, not navigation: the list is an <ol>, the current step carries
// aria-current="step", and a polite live region announces each change.

import { Check, ExternalLink, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";

import { Stepper, StepperDescription, StepperIndicator, StepperItem, StepperSeparator, StepperTitle } from "@/components/reui/stepper";
import { cn } from "@/lib/utils";

export const TX_STEPS = ["quote", "review", "build", "sign", "submit", "confirmed"] as const;
export type TxStep = (typeof TX_STEPS)[number];

const TITLES: Record<TxStep, string> = {
  quote: "Quote",
  review: "Review and consent",
  build: "Build",
  sign: "Sign in your wallet",
  submit: "Submit",
  confirmed: "Confirmed",
};

export interface TxStepperProps {
  /** The step in progress (or the one that failed). */
  current: TxStep;
  /** `working`: the current step is running; `error`: it failed; `done`: every step finished. */
  status: "idle" | "working" | "error" | "done";
  /** One line under each step (what it did or will do). */
  details?: Partial<Record<TxStep, ReactNode>>;
  error?: string | null;
  explorerUrl?: string | null;
  /** Override step titles (e.g. "Build the claim"). */
  titles?: Partial<Record<TxStep, string>>;
  className?: string;
}

export function TxStepper({ current, status, details, error, explorerUrl, titles, className }: TxStepperProps) {
  const index = TX_STEPS.indexOf(current);
  const active = status === "done" ? TX_STEPS.length + 1 : index + 1;
  const title = (s: TxStep) => titles?.[s] ?? TITLES[s];
  const announce =
    status === "done" ? "Confirmed." : status === "error" ? `${title(current)} failed. ${error ?? ""}` : `${title(current)}${status === "working" ? ", in progress" : ""}.`;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Stepper value={active} orientation="vertical" role="presentation" aria-orientation={undefined}>
        <ol className="flex w-full flex-col" aria-label="Transaction progress">
          {TX_STEPS.map((step, i) => {
            const n = i + 1;
            const failed = status === "error" && step === current;
            const working = status === "working" && step === current;
            const isCurrent = step === current && status !== "done";
            const done = status === "done" || n < active;
            return (
              <li key={step} className="relative pb-4 last:pb-0" aria-current={isCurrent ? "step" : undefined}>
                <StepperItem step={n} completed={done} loading={working} className="flex items-start justify-start gap-3">
                  <StepperIndicator
                    className={cn(
                      "size-6 border border-ep-line-strong bg-ep-inset text-ep-muted",
                      "data-[state=completed]:border-ep-accent-line data-[state=completed]:bg-ep-accent-soft data-[state=completed]:text-ep-accent",
                      "data-[state=active]:border-ep-accent data-[state=active]:bg-ep-accent data-[state=active]:text-ep-accent-ink",
                      failed && "border-ep-warn-line! bg-ep-warn-soft! text-ep-warn!",
                    )}
                  >
                    {failed ? (
                      <X className="size-3.5" aria-hidden />
                    ) : working ? (
                      <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                    ) : done ? (
                      <Check className="size-3.5" aria-hidden />
                    ) : (
                      <span className="num text-xs">{n}</span>
                    )}
                  </StepperIndicator>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <StepperTitle className={cn("text-sm", isCurrent || done ? "text-ep-text" : "text-ep-muted")}>
                      {title(step)}
                      <span className="sr-only">{done ? " (done)" : isCurrent ? " (current)" : ""}</span>
                    </StepperTitle>
                    {details?.[step] ? <StepperDescription className="mt-1 text-xs text-ep-muted">{details[step]}</StepperDescription> : null}
                    {failed && error ? <p className="mt-1 text-xs text-ep-warn">{error}</p> : null}
                    {step === "confirmed" && explorerUrl ? (
                      <a href={explorerUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-ep-accent underline-offset-4 hover:underline">
                        View on Solana Explorer <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : null}
                  </div>
                  {n < TX_STEPS.length ? (
                    <StepperSeparator className="absolute top-7 bottom-1 left-3 m-0 h-auto w-px -translate-x-1/2 rounded-none bg-ep-line data-[state=completed]:bg-ep-accent-line" />
                  ) : null}
                </StepperItem>
              </li>
            );
          })}
        </ol>
      </Stepper>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
