import { useCallback, useMemo, useRef, useState } from "react";

/**
 * A popover opened from a dropdown-menu item (e.g. "Icon & colour").
 *
 * Opening it from the item's onSelect races the menu: the closing menu returns focus to its
 * trigger, which the just-opened popover (anchored, not triggered) treats as focus moving outside
 * and dismisses itself. So the item only *requests* the popover; it opens when the menu has closed
 * and handed back focus, and closing it returns focus to the menu's trigger (unless the person
 * clicked elsewhere).
 */
export function useMenuPopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const requested = useRef(false);
  const interactedOutside = useRef(false);
  const triggerRef = useRef<T>(null);

  /** Call from the menu item's onSelect. */
  const request = useCallback(() => {
    requested.current = true;
  }, []);

  /** Pass to the menu content's onCloseAutoFocus. */
  const onMenuCloseAutoFocus = useCallback((event: Event) => {
    if (!requested.current) return;
    requested.current = false;
    event.preventDefault(); // focus moves into the popover instead
    interactedOutside.current = false;
    setOpen(true);
  }, []);

  /** Spread onto the popover content. */
  const contentProps = useMemo(
    () => ({
      onInteractOutside: () => {
        interactedOutside.current = true;
      },
      onCloseAutoFocus: (event: Event) => {
        event.preventDefault();
        if (!interactedOutside.current) triggerRef.current?.focus();
      },
    }),
    [],
  );

  return { open, setOpen, request, onMenuCloseAutoFocus, contentProps, triggerRef };
}
