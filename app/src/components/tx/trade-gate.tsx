"use client";
// The calm gate before a wallet's first trade (Coinbase Advanced's gated ticket): 18+ and region, one button. It is
// asked once per wallet and per product, and remembered in local storage (`epoch.<scope>.gate.<wallet>`). Predict and
// Launch share it; each passes its own region line and note.

import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export function useTradeGate(scope: "predict" | "launch", wallet: string | null) {
  const key = wallet ? `epoch.${scope}.gate.${wallet}` : null;
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!key) return setOk(false);
    try {
      setOk(window.localStorage.getItem(key) === "1");
    } catch {
      setOk(false);
    }
  }, [key]);
  const pass = () => {
    setOk(true);
    try {
      if (key) window.localStorage.setItem(key, "1");
    } catch {
      /* private mode: asked again next time */
    }
  };
  return { ok, pass };
}

export function TradeGate({ id, regionLine, note, onPass }: { id: string; regionLine: string; note?: ReactNode; onPass: () => void }) {
  const [adult, setAdult] = useState(false);
  const [allowed, setAllowed] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-ep-line-strong bg-ep-inset p-4">
      <p className="text-sm font-medium text-ep-text">Before your first trade on this wallet</p>
      <label htmlFor={`${id}-adult`} className="flex cursor-pointer items-start gap-3 text-sm text-ep-text-2">
        <Checkbox id={`${id}-adult`} checked={adult} onCheckedChange={(v) => setAdult(v === true)} className="mt-0.5" />
        <span>I&apos;m 18 or older</span>
      </label>
      <label htmlFor={`${id}-region`} className="flex cursor-pointer items-start gap-3 text-sm text-ep-text-2">
        <Checkbox id={`${id}-region`} checked={allowed} onCheckedChange={(v) => setAllowed(v === true)} className="mt-0.5" />
        <span>{regionLine}</span>
      </label>
      {note ? <p className="text-xs leading-relaxed text-ep-muted">{note}</p> : null}
      <Button disabled={!adult || !allowed} onClick={onPass}>
        Continue
      </Button>
    </div>
  );
}
