"use client";

import { useEffect, type RefObject } from "react";

/**
 * Click-and-drag on empty space scrolls a sideways area (mouse and pen; touch already scrolls).
 * Empty space is the scroller itself or an element marked `data-pan-surface` — pressing on
 * anything inside those (a card, a column, a control) never pans. While there's something to
 * scroll the scroller gets `data-can-pan` (a grab cursor), and `data-panning` while dragging.
 */
export function useDragScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let drag: { x: number; left: number; pointerId: number } | null = null;

    const update = () => {
      if (el.scrollWidth > el.clientWidth + 1) el.dataset.canPan = "";
      else delete el.dataset.canPan;
    };
    // Content can grow without the scroller resizing (columns added): re-check when the pointer arrives too.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();

    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target !== el && !target.hasAttribute?.("data-pan-surface")) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      drag = { x: e.clientX, left: el.scrollLeft, pointerId: e.pointerId };
      el.setPointerCapture(e.pointerId);
      el.dataset.panning = "";
      // No text selection while dragging.
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      el.scrollLeft = drag.left - (e.clientX - drag.x);
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag = null;
      delete el.dataset.panning;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener("pointerenter", update);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      observer.disconnect();
      el.removeEventListener("pointerenter", update);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      delete el.dataset.canPan;
      delete el.dataset.panning;
    };
  }, [ref]);
}
