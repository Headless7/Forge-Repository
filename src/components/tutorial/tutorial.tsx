"use client";

import { Lightbulb, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { Popover as P, Slot } from "radix-ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { toast } from "sonner";
import { rpc } from "@/lib/rpc-client";
import { TIPS, type TipFacts, type TipId, type TutorialStateDTO } from "@/lib/tutorial";
import { Button } from "../ui/button";
import { PortalContainer } from "../ui/controls";
import { useUploads } from "../upload/upload-manager";
import { TutorialCoordinator, type TriggerOptions, type TutorialEvent, type TutorialSnapshot } from "./coordinator";

interface TutorialContextValue {
  coordinator: TutorialCoordinator;
  /** Where tips outside dialogs render: after the page content, so Tab reaches them. */
  layer: HTMLElement | null;
  announce: (text: string) => void;
}

const TutorialContext = createContext<TutorialContextValue | null>(null);

const OFF_SNAPSHOT: TutorialSnapshot = { enabled: false, activeTip: null, activeAnchor: null };
const noopSubscribe = () => () => {};

function isTextEntry(el: Element | null) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(el.type);
  return false;
}

function mediaPlaying() {
  for (const media of document.querySelectorAll("video, audio")) {
    const m = media as HTMLMediaElement;
    if (!m.paused && !m.ended) return true;
  }
  return false;
}

const REFRESH_MS = 60_000;

/** Contextual tips for the signed-in person. Progress comes with the page (no flash), then syncs. */
export function TutorialProvider({ initial, children }: { initial: TutorialStateDTO; children: ReactNode }) {
  const uploads = useUploads();
  const uploading = uploads.items.some((i) => i.status === "queued" || i.status === "uploading" || i.status === "processing");
  const uploadingRef = useRef(uploading);
  uploadingRef.current = uploading;
  const pointerDown = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const [coordinator] = useState(
    () =>
      new TutorialCoordinator(initial, {
        now: () => Date.now(),
        isBusy: () =>
          pointerDown.current ||
          uploadingRef.current ||
          isTextEntry(document.activeElement) ||
          // A confirmation is waiting for an answer.
          document.querySelector('[role="alertdialog"]') !== null ||
          mediaPlaying(),
        encounter: () => `${window.location.pathname}${window.location.search}`,
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (handle) => window.clearTimeout(handle as number),
        save: {
          dismiss: (tipId, version) => rpc("tutorial.dismiss", { tipId, version }),
          enabled: (enabled) => rpc("tutorial.setEnabled", { enabled }),
          reset: () => rpc("tutorial.reset", {}),
        },
        broadcast: (event) => channel.current?.postMessage(event),
      }),
  );

  // Things that make someone busy, and the moments they stop.
  useEffect(() => {
    let tick: number | null = null;
    const later = () => {
      if (tick !== null) return;
      tick = window.setTimeout(() => {
        tick = null;
        coordinator.evaluate();
      }, 0);
    };
    const down = () => {
      pointerDown.current = true;
    };
    const up = () => {
      pointerDown.current = false;
      later();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("focusout", later, true);
    for (const type of ["pause", "ended"]) document.addEventListener(type, later, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("focusout", later, true);
      for (const type of ["pause", "ended"]) document.removeEventListener(type, later, true);
      if (tick !== null) window.clearTimeout(tick);
    };
  }, [coordinator]);

  useEffect(() => {
    if (!uploading) coordinator.evaluate();
  }, [uploading, coordinator]);

  // Finished uploads are the meaningful moment for the upload-related tips.
  const statuses = useRef(new Map<string, string>());
  useEffect(() => {
    let version = false;
    let attachment = false;
    let cover = false;
    for (const item of uploads.items) {
      const before = statuses.current.get(item.id);
      statuses.current.set(item.id, item.status);
      if (item.status !== "done" || before === "done" || before === undefined) continue;
      if (item.purpose === "version") version = true;
      else if (item.purpose === "attachment") attachment = true;
      else if (item.purpose === "cover") cover = true;
    }
    if (uploads.items.some((i) => i.status !== "done" && i.status !== "error")) return;
    if (version) coordinator.trigger("card.upload-vs-submit");
    else if (attachment) coordinator.trigger("card.attachments", { place: "attachments" });
    else if (cover) coordinator.trigger("card.attachments", { place: "cover" });
  }, [uploads.items, coordinator]);

  // Leaving a page drops what was waiting to show there.
  const pathname = usePathname();
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    coordinator.navigated();
  }, [pathname, coordinator]);

  // Other tabs of this person, and other devices (refreshed when the tab comes back).
  useEffect(() => {
    if (typeof BroadcastChannel !== "undefined") {
      const bc = new BroadcastChannel("forge-tutorial");
      bc.onmessage = (e: MessageEvent<TutorialEvent>) => coordinator.applyEvent(e.data);
      channel.current = bc;
    }
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < REFRESH_MS) return;
      last = Date.now();
      rpc("tutorial.get", {})
        .then((state) => coordinator.applyServerState(state))
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      channel.current?.close();
      channel.current = null;
      coordinator.dispose();
    };
  }, [coordinator]);

  const clearAnnouncement = useRef<number | null>(null);
  const announce = useCallback((text: string) => {
    setAnnouncement(text);
    if (clearAnnouncement.current !== null) window.clearTimeout(clearAnnouncement.current);
    clearAnnouncement.current = window.setTimeout(() => setAnnouncement(""), 8000);
  }, []);

  const value = useMemo(() => ({ coordinator, layer, announce }), [coordinator, layer, announce]);
  return (
    <TutorialContext.Provider value={value}>
      {children}
      <div ref={setLayer} data-tutorial-layer="" />
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </TutorialContext.Provider>
  );
}

/** Offer tips after a meaningful interaction, and the person's tip preferences. */
export function useTutorial() {
  const ctx = useContext(TutorialContext);
  const snapshot = useSyncExternalStore(ctx?.coordinator.subscribe ?? noopSubscribe, () => ctx?.coordinator.getSnapshot() ?? OFF_SNAPSHOT, () => ctx?.coordinator.getSnapshot() ?? OFF_SNAPSHOT);
  return useMemo(
    () => ({
      available: Boolean(ctx),
      enabled: snapshot.enabled,
      trigger: (tips: TipId | TipId[], options?: TriggerOptions) => ctx?.coordinator.trigger(tips, options),
      setEnabled: (enabled: boolean) => ctx?.coordinator.setEnabled(enabled),
      reset: () => ctx?.coordinator.reset(),
    }),
    [ctx, snapshot.enabled],
  );
}

/** Offers tips once when `when` first becomes true for this mount (e.g. a feature the person just opened). */
export function useTipOnOpen(tips: TipId | TipId[], when = true, options?: TriggerOptions) {
  const { trigger } = useTutorial();
  const done = useRef(false);
  const key = Array.isArray(tips) ? tips.join() : tips;
  useEffect(() => {
    if (!when || done.current) return;
    done.current = true;
    trigger(tips, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [when, key]);
}

function focusTarget(el: HTMLElement): HTMLElement | null {
  if (el.matches("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")) return el;
  return el.querySelector<HTMLElement>("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
}

type AnchorProps<K extends TipId> = {
  tip: K;
  /** Context the tip's eligibility and copy depend on (from effective permissions). */
  facts: TipFacts[K];
  /** Distinguishes several places that can show the same tip. */
  place?: string;
  children: ReactElement;
  ref?: Ref<HTMLElement>;
} & HTMLAttributes<HTMLElement>;

/**
 * Marks the element a tip explains (its only child, which must accept a ref). Reports the tip's
 * facts and visibility to the coordinator, and shows the tip beside it when it's this anchor's turn.
 */
export function TipAnchor<K extends TipId>({ tip, facts, place, children, ref, ...rest }: AnchorProps<K>) {
  const ctx = useContext(TutorialContext);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const keyRef = useRef<number | null>(null);
  const visibleRef = useRef(false);
  const availableRef = useRef<(() => boolean) | undefined>(undefined);
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const factsKey = JSON.stringify(facts);

  const setRefs = useCallback(
    (node: HTMLElement | null) => {
      setEl(node);
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as { current: HTMLElement | null }).current = node;
    },
    [ref],
  );

  useEffect(() => {
    if (!ctx || !el) return;
    const coordinator = ctx.coordinator;
    // Behind an open modal (Radix hides everything outside it from assistive tech) the target isn't available.
    const available = () => !el.closest('[aria-hidden="true"], [inert]');
    availableRef.current = available;
    const key = coordinator.registerAnchor({ tip, place, facts: factsRef.current, visible: false, available });
    keyRef.current = key;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]!;
        const box = entry.boundingClientRect;
        const shown = entry.intersectionRect;
        // Enough of it on screen to point at (a sliver at an edge doesn't count).
        const visible = entry.isIntersecting && shown.height >= Math.min(box.height, 24) && shown.width >= Math.min(box.width, 24);
        if (visible === visibleRef.current) return;
        visibleRef.current = visible;
        coordinator.updateAnchor(key, { tip, place, facts: factsRef.current, visible, available });
      },
      { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      keyRef.current = null;
      visibleRef.current = false;
      coordinator.unregisterAnchor(key);
    };
  }, [ctx, el, tip, place]);

  useEffect(() => {
    if (!ctx || keyRef.current === null) return;
    ctx.coordinator.updateAnchor(keyRef.current, { tip, place, facts: factsRef.current, visible: visibleRef.current, available: availableRef.current });
  }, [ctx, factsKey, tip, place]);

  const snapshot = useSyncExternalStore(ctx?.coordinator.subscribe ?? noopSubscribe, () => ctx?.coordinator.getSnapshot() ?? OFF_SNAPSHOT, () => OFF_SNAPSHOT);
  const active = snapshot.activeAnchor !== null && snapshot.activeAnchor === keyRef.current;

  return (
    <>
      <Slot.Root ref={setRefs} {...rest}>
        {children}
      </Slot.Root>
      {active && el && ctx ? <TipPopover tip={tip} facts={facts} anchor={el} ctx={ctx} /> : null}
    </>
  );
}

function TipPopover<K extends TipId>({ tip, facts, anchor, ctx }: { tip: K; facts: TipFacts[K]; anchor: HTMLElement; ctx: TutorialContextValue }) {
  const def = TIPS[tip];
  const title = def.title(facts);
  const body = def.body(facts);
  const fullscreen = useContext(PortalContainer);
  // Inside a dialog the tip stays within its focus trap and stacking; otherwise it renders after the page.
  const container = fullscreen ?? (anchor.closest('[role="dialog"]') as HTMLElement | null) ?? ctx.layer ?? undefined;
  const titleId = useId();
  const bodyId = useId();
  const content = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);

  const { announce } = ctx;
  useEffect(() => {
    announce(`Tip: ${title}. ${body} Press Escape to dismiss.`);
  }, [announce, title, body]);

  const finish = (turnOff: boolean) => {
    const hadFocus = Boolean(content.current?.contains(document.activeElement));
    if (turnOff) {
      ctx.coordinator.setEnabled(false);
      toast("Tutorial tips are off.", {
        description: "Turn them back on from your account menu.",
        action: { label: "Undo", onClick: () => ctx.coordinator.setEnabled(true) },
      });
    } else {
      ctx.coordinator.dismiss();
    }
    if (hadFocus) {
      const target = returnFocus.current?.isConnected ? returnFocus.current : focusTarget(anchor);
      target?.focus({ preventScroll: true });
    }
  };

  return (
    <P.Root open modal={false} onOpenChange={(open) => !open && finish(false)}>
      <P.Anchor virtualRef={anchorRef} />
      <P.Portal container={container}>
        <P.Content
          ref={content}
          side={def.side}
          align={def.align}
          sideOffset={10}
          collisionPadding={12}
          hideWhenDetached
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          data-tutorial-tip={tip}
          // Never take focus: the person keeps working; Tab reaches the tip, Escape dismisses it.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Moving focus elsewhere (Tab) isn't a dismissal; Escape and clicking elsewhere are.
          onFocusOutside={(e) => e.preventDefault()}
          onFocusCapture={(e) => {
            const from = e.relatedTarget;
            if (from instanceof HTMLElement && !content.current?.contains(from)) returnFocus.current = from;
          }}
          className="z-[35] w-[min(20rem,calc(100vw-24px))] rounded-xl border border-border-strong bg-surface-2 p-3 text-fg shadow-lg outline-none data-[state=open]:motion-safe:animate-pop-in"
        >
          <div className="flex items-start gap-2.5">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <p id={titleId} className="text-[13px] font-semibold leading-snug">
                {title}
              </p>
              <p id={bodyId} className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                {body}
              </p>
            </div>
            <button
              type="button"
              aria-label="Dismiss tip"
              onClick={() => finish(false)}
              className="touch-target -mr-1 -mt-1 flex size-6 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-4 hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 pl-[26px]">
            <button type="button" onClick={() => finish(true)} className="min-h-6 text-[12px] text-fg-subtle underline-offset-2 hover:text-fg hover:underline">
              Turn off tips
            </button>
            <Button size="xs" variant="primary" onClick={() => finish(false)}>
              Got it
            </Button>
          </div>
          <P.Arrow width={14} height={7} className="fill-[var(--border-strong)]" />
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
