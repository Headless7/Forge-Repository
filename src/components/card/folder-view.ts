"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Which canvas folders each person has collapsed: their own view, never saved or shared, so one
 * person can keep a folder closed while another has it open. It lasts while the card is open
 * (the canvas and the list share it, and it survives opening a deliverable and coming back);
 * opening the card again starts with every folder expanded (see resetFolderView in CardModal).
 */
const collapsedByCard = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
const NONE: ReadonlySet<string> = new Set();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every folder on this card expanded again — called when the card is opened. */
export function resetFolderView(cardId: string | null | undefined) {
  if (cardId && collapsedByCard.delete(cardId)) emit();
}

/** The folders collapsed on this card in this browser, and a way to collapse or expand one. */
export function useCollapsedFolders(cardId: string): [ReadonlySet<string>, (folderId: string, collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribe,
    () => collapsedByCard.get(cardId) ?? NONE,
    () => NONE,
  );
  const setCollapsed = useCallback(
    (folderId: string, value: boolean) => {
      const current = collapsedByCard.get(cardId) ?? NONE;
      if (current.has(folderId) === value) return;
      const next = new Set(current);
      if (value) next.add(folderId);
      else next.delete(folderId);
      collapsedByCard.set(cardId, next);
      emit();
    },
    [cardId],
  );
  return [collapsed, setCollapsed];
}
