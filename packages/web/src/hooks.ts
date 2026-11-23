import { useEffect, useState, useSyncExternalStore } from "react";
import type { Source } from "./head.ts";

/** Re-render whenever the source (a task session, a head) changes; the number goes up each time. */
export function useSource(s: Source | null): number {
  const [store, setStore] = useState(() => make(s));
  useEffect(() => setStore(make(s)), [s]);
  return useSyncExternalStore(store.subscribe, store.get);
}

function make(s: Source | null) {
  let tick = 0;
  return {
    subscribe: (fn: () => void) => (s ? s.subscribe(() => (tick++, fn())) : () => {}),
    get: () => tick,
  };
}

/** "3 min ago", "yesterday", a date. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172_800) return "yesterday";
  return new Date(iso).toLocaleDateString();
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
