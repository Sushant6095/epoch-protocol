"use client";
// LP2: the explainer behind "How it works" on /launch and the token page. Esc, the scrim or Got it closes it and
// focus returns to the button (Base UI's dialog). The numbers are Epoch's preset (docs/pages/launch.md).

import { BookOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const STEPS: { title: string; body: string }[] = [
  {
    title: "A share for a term",
    body: "A validator sells a fixed share of its gross revenue (for example 5%) for a fixed term of epochs. It registers both with the Epoch program; neither can change, and the validator cannot leave Epoch or cut its commission below the registered floor until the term ends.",
  },
  {
    title: "A Meteora curve",
    body: "Epoch builds the token's Dynamic Bonding Curve from the validator's revenue: the price runs from 60% to 95% of the share's value, so the curve sells below what the share is expected to pay in.",
  },
  {
    title: "Graduation to DAMM v2",
    body: "When the raise reaches its target, the validator gets 70% of it as SOL, and 30% seeds a Meteora DAMM v2 pool whose liquidity is locked forever, so holders always have a market.",
  },
  {
    title: "Buybacks, then burns",
    body: "Every epoch of the term, the sweep pays the share into a buyback escrow off the top. The program spends it on the token in slices (12 by default) across the first hour of the epoch, with a price-impact cap, and burns what it buys.",
  },
  {
    title: "Redeem as a fallback",
    body: "After the term, or if the pool admin opens it, holders can burn tokens for their share of what is left in the escrow. The pools keep trading either way.",
  },
];

export function HowItWorksDialog({ className }: { className?: string }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" className={className} />}>
        <BookOpen aria-hidden /> How it works
      </DialogTrigger>
      <DialogContent className="max-h-11/12 overflow-y-auto border border-ep-line bg-ep-raised p-6 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-lg text-ep-text">How a revenue token works</DialogTitle>
          <DialogDescription className="text-ep-text-2">Validator revenue on a Meteora curve, bought back and burned by the Epoch program.</DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="num flex size-7 shrink-0 items-center justify-center rounded-full border border-ep-accent-line text-xs text-ep-accent" aria-hidden>
                {i + 1}
              </span>
              <div className="flex flex-col gap-1">
                <p className="font-medium text-ep-text">{s.title}</p>
                <p className="text-sm leading-relaxed text-ep-text-2">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="rounded-md border border-ep-warn-line bg-ep-warn-soft p-3 text-xs leading-relaxed text-ep-text-2">
          Devnet demo. Revenue tokens can be securities in many countries; nothing here is an offer. Buybacks depend on the validator&apos;s revenue and stop when the term ends.
        </p>
        <DialogFooter>
          <DialogClose render={<Button />}>Got it</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
