"use client";

import { useEffect, useRef } from "react";
import { isTypingTarget } from "@/lib/utils";

type Handler = (event: KeyboardEvent) => void;

/**
 * Keyboard shortcuts. Keys: "/", "c", "?", "mod+k", "escape", "arrowleft" …
 * Single-key shortcuts never fire while the user is typing in a field.
 */
export function useHotkeys(bindings: Record<string, Handler>, options: { enabled?: boolean } = {}) {
  const ref = useRef(bindings);
  ref.current = bindings;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const combo = mod ? `mod+${key}` : event.altKey ? `alt+${key}` : key;
      const handler = ref.current[combo];
      if (!handler) return;
      if (!mod && isTypingTarget(event.target)) return;
      handler(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
