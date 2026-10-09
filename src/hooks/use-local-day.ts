"use client";

import { useSyncExternalStore } from "react";
import { localDay } from "@/lib/checklist";

// One shared minute timer, however many tiles and rows ask for the day.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let last = "";

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    last = localDay();
    // Past midnight the marks move on.
    timer = setInterval(() => {
      const day = localDay();
      if (day === last) return;
      last = day;
      for (const l of listeners) l();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * Today ("YYYY-MM-DD") in the viewer's own calendar — null during server rendering and hydration,
 * so "overdue" and "today" marks never differ between the server's HTML and the browser.
 */
export function useLocalDay(): string | null {
  return useSyncExternalStore(subscribe, localDay, () => null);
}
