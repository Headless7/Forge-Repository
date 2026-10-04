/**
 * Decides which contextual tip (if any) is showing. Framework-free so its rules can be tested:
 *
 * - Tips are offered only by explicit triggers (a meaningful interaction), never by mounting,
 *   hovering or focusing alone. A trigger names candidate tips in priority order.
 * - One tip at a time. While one shows, triggers are ignored; after one is dismissed there's a
 *   short cooldown, so dismissing never chains straight into another tip.
 * - A candidate waits for its target (anchor) to mount, be eligible and be on screen, and for the
 *   person to stop typing, dragging, uploading or watching media. If the moment passes it's
 *   dropped — not marked seen.
 * - Only "Got it", close, Escape and an intentional click elsewhere retire a tip. A tip whose
 *   target disappears (navigation, permission change, scrolled away for a while) just steps aside
 *   and isn't offered again in the same place until the person comes back.
 */
import { TIPS, type TipId, type TutorialStateDTO } from "@/lib/tutorial";

export const TUTORIAL_TIMING = {
  /** Let the interaction finish (a dialog opening, a menu closing) before looking for the target. */
  settleMs: 450,
  /** How long a higher-priority tip waits for its target to mount before lower ones are considered. */
  anchorWaitMs: 1800,
  /** An unshown candidate is dropped after this: the moment has passed. */
  expiryMs: 10_000,
  /** No new tip right after one is dismissed: it takes a fresh interaction. */
  cooldownMs: 1500,
  /** A showing tip whose target stays out of view this long steps aside (it isn't retired). */
  offscreenMs: 4000,
  /** Re-check interval while waiting (busy, target off screen). */
  recheckMs: 500,
};

export type TutorialEvent = { type: "dismiss"; tip: TipId; version: number } | { type: "enabled"; enabled: boolean } | { type: "reset" };

export interface TutorialEnv {
  now(): number;
  /** Typing, dragging, uploading, a confirmation open, media playing… */
  isBusy(): boolean;
  /** Where the person is (path + query). A tip interrupted here isn't re-offered until they leave. */
  encounter(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  save: {
    dismiss(tip: TipId, version: number): Promise<unknown>;
    enabled(enabled: boolean): Promise<unknown>;
    reset(): Promise<unknown>;
  };
  /** Tells this person's other tabs. */
  broadcast?(event: TutorialEvent): void;
}

export interface AnchorState {
  tip: TipId;
  /** Distinguishes several places that can show the same tip. */
  place?: string;
  facts: unknown;
  visible: boolean;
  /** False while something modal covers the target (checked when choosing; e.g. a dialog opened over the board). */
  available?: () => boolean;
}

export interface TriggerOptions {
  /** Only anchors with this place. */
  place?: string;
  /** The interaction navigates: keep the candidate through one route change. */
  afterNavigation?: boolean;
}

export interface TutorialSnapshot {
  enabled: boolean;
  activeTip: TipId | null;
  activeAnchor: number | null;
}

interface Candidate {
  tips: TipId[];
  place?: string;
  at: number;
  afterNavigation: boolean;
  navigated: boolean;
}

const RETRY_MS = 3000;

export class TutorialCoordinator {
  private enabled: boolean;
  /** Confirmed saved progress (tip → dismissed version). */
  private seen: Map<string, number>;
  /** Dismissed here and suppressed at once, while (or if) saving hasn't confirmed. */
  private pending = new Map<string, number>();
  private enabledSaves = 0;
  private anchors = new Map<number, AnchorState & { order: number }>();
  private nextKey = 1;
  private order = 0;
  private active: { tip: TipId; anchor: number; encounter: string } | null = null;
  private candidate: Candidate | null = null;
  private interrupted = new Map<TipId, string>();
  private lastDismissAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private offscreenTimer: unknown = null;
  private listeners = new Set<() => void>();
  private snapshot: TutorialSnapshot;

  constructor(
    initial: TutorialStateDTO,
    private env: TutorialEnv,
  ) {
    this.enabled = initial.enabled;
    this.seen = new Map(Object.entries(initial.seen));
    this.snapshot = this.makeSnapshot();
  }

  // ── Subscription (React reads this through useSyncExternalStore) ──────────────────────────
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  private makeSnapshot(): TutorialSnapshot {
    return { enabled: this.enabled, activeTip: this.active?.tip ?? null, activeAnchor: this.active?.anchor ?? null };
  }
  private emit() {
    const next = this.makeSnapshot();
    if (next.enabled === this.snapshot.enabled && next.activeTip === this.snapshot.activeTip && next.activeAnchor === this.snapshot.activeAnchor) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  isEnabled() {
    return this.enabled;
  }

  /** Dismissed at the current version, here or (as last loaded) anywhere else. */
  hasSeen(tip: TipId) {
    const version = TIPS[tip].version;
    return (this.seen.get(tip) ?? 0) >= version || (this.pending.get(tip) ?? 0) >= version;
  }

  // ── Anchors ─────────────────────────────────────────────────────────────────────────────
  registerAnchor(state: AnchorState): number {
    const key = this.nextKey++;
    this.anchors.set(key, { ...state, order: this.order++ });
    this.evaluate();
    return key;
  }

  updateAnchor(key: number, state: AnchorState) {
    const entry = this.anchors.get(key);
    if (!entry) return;
    this.anchors.set(key, { ...state, order: entry.order });
    if (this.active?.anchor === key) {
      if (!this.eligible(state)) {
        this.stepAside();
      } else if (!state.visible) {
        if (this.offscreenTimer === null) {
          this.offscreenTimer = this.env.setTimer(() => {
            this.offscreenTimer = null;
            const current = this.active ? this.anchors.get(this.active.anchor) : undefined;
            if (current && !current.visible) this.stepAside();
          }, TUTORIAL_TIMING.offscreenMs);
        }
      } else {
        this.clearOffscreen();
      }
      return;
    }
    this.evaluate();
  }

  unregisterAnchor(key: number) {
    this.anchors.delete(key);
    if (this.active?.anchor === key) this.stepAside();
    else this.evaluate();
  }

  // ── Triggers ────────────────────────────────────────────────────────────────────────────
  trigger(tips: TipId | TipId[], options: TriggerOptions = {}) {
    if (!this.enabled || this.active) return;
    const at = this.env.now();
    if (at - this.lastDismissAt < TUTORIAL_TIMING.cooldownMs) return;
    const list = (Array.isArray(tips) ? tips : [tips]).filter((tip) => this.offerable(tip));
    if (!list.length) return;
    this.candidate = { tips: list, place: options.place, at, afterNavigation: Boolean(options.afterNavigation), navigated: false };
    this.schedule(TUTORIAL_TIMING.settleMs);
  }

  /** The route changed: pending triggers belong to the page that was left. */
  navigated() {
    const c = this.candidate;
    if (!c) return;
    if (c.afterNavigation && !c.navigated) c.navigated = true;
    else {
      this.candidate = null;
      this.clearTimer();
    }
  }

  /** Re-checks a waiting candidate (call when something that makes the person busy ends). */
  evaluate() {
    this.clearTimer();
    if (!this.enabled) {
      this.candidate = null;
      return;
    }
    if (this.active) return;
    const c = this.candidate;
    if (!c) return;
    const age = this.env.now() - c.at;
    if (age > TUTORIAL_TIMING.expiryMs) {
      this.candidate = null;
      return;
    }
    if (age < TUTORIAL_TIMING.settleMs) {
      this.schedule(TUTORIAL_TIMING.settleMs - age);
      return;
    }
    if (this.env.isBusy()) {
      this.schedule(TUTORIAL_TIMING.recheckMs);
      return;
    }
    for (const tip of c.tips) {
      if (!this.offerable(tip)) continue;
      const key = this.pickAnchor(tip, c.place);
      if (key !== null) {
        this.show(tip, key);
        return;
      }
      // Keep priority: a more important tip whose target hasn't mounted yet gets a moment.
      if (!this.hasAnchor(tip, c.place) && age < TUTORIAL_TIMING.anchorWaitMs) {
        this.schedule(Math.min(TUTORIAL_TIMING.recheckMs, TUTORIAL_TIMING.anchorWaitMs - age));
        return;
      }
    }
    this.schedule(Math.min(TUTORIAL_TIMING.recheckMs, TUTORIAL_TIMING.expiryMs - age + 1));
  }

  // ── Dismissal and preferences ───────────────────────────────────────────────────────────
  /** "Got it", close, Escape or an intentional click elsewhere: the tip is retired. */
  dismiss() {
    const active = this.active;
    if (!active) return;
    const version = TIPS[active.tip].version;
    this.pending.set(active.tip, Math.max(this.pending.get(active.tip) ?? 0, version));
    this.active = null;
    this.candidate = null;
    this.lastDismissAt = this.env.now();
    this.clearTimer();
    this.clearOffscreen();
    this.emit();
    this.env.broadcast?.({ type: "dismiss", tip: active.tip, version });
    void this.persist(() => this.env.save.dismiss(active.tip, version)).then((ok) => {
      if (!ok) return; // still suppressed for this session; saving is retried next time
      this.seen.set(active.tip, Math.max(this.seen.get(active.tip) ?? 0, version));
      this.pending.delete(active.tip);
    });
  }

  setEnabled(enabled: boolean, options: { broadcast?: boolean; save?: boolean } = {}) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.active = null;
      this.candidate = null;
      this.clearTimer();
      this.clearOffscreen();
    }
    this.emit();
    if (options.broadcast !== false) this.env.broadcast?.({ type: "enabled", enabled });
    if (options.save === false) return;
    this.enabledSaves++;
    void this.persist(() => this.env.save.enabled(enabled)).finally(() => this.enabledSaves--);
  }

  /** Forget dismissed tips and turn tips on. Nothing appears until features are used again. */
  reset(options: { broadcast?: boolean; save?: boolean } = {}) {
    this.seen.clear();
    this.pending.clear();
    this.interrupted.clear();
    this.enabled = true;
    this.active = null;
    this.candidate = null;
    this.lastDismissAt = Number.NEGATIVE_INFINITY;
    this.clearTimer();
    this.clearOffscreen();
    this.emit();
    if (options.broadcast !== false) this.env.broadcast?.({ type: "reset" });
    if (options.save !== false) void this.persist(() => this.env.save.reset());
  }

  /** Fresh progress from the server (another device may have dismissed tips or reset). */
  applyServerState(state: TutorialStateDTO) {
    if (this.enabledSaves === 0 && state.enabled !== this.enabled) {
      this.setEnabled(state.enabled, { broadcast: false, save: false });
    }
    // Local dismissals that haven't been confirmed stay in `pending`, so they still count.
    this.seen = new Map(Object.entries(state.seen));
    if (this.active && this.hasSeen(this.active.tip)) {
      this.active = null;
      this.emit();
    }
  }

  /** An update from another tab of this person. */
  applyEvent(event: TutorialEvent) {
    if (event.type === "dismiss") {
      this.seen.set(event.tip, Math.max(this.seen.get(event.tip) ?? 0, event.version));
      if (this.active?.tip === event.tip) {
        this.active = null;
        this.lastDismissAt = this.env.now();
        this.clearOffscreen();
        this.emit();
      }
      if (this.candidate) this.candidate.tips = this.candidate.tips.filter((tip) => tip !== event.tip);
    } else if (event.type === "enabled") {
      this.setEnabled(event.enabled, { broadcast: false, save: false });
    } else {
      this.reset({ broadcast: false, save: false });
    }
  }

  dispose() {
    this.clearTimer();
    this.clearOffscreen();
    this.listeners.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────
  private offerable(tip: TipId) {
    return this.enabled && !this.hasSeen(tip) && this.interrupted.get(tip) !== this.env.encounter();
  }

  private eligible(state: AnchorState) {
    return (TIPS[state.tip].eligible as (facts: unknown) => boolean)(state.facts);
  }

  private matches(entry: AnchorState, tip: TipId, place: string | undefined) {
    return entry.tip === tip && (place === undefined || entry.place === place);
  }

  private hasAnchor(tip: TipId, place: string | undefined) {
    for (const entry of this.anchors.values()) if (this.matches(entry, tip, place)) return true;
    return false;
  }

  /** The most recently mounted eligible, visible target for a tip. */
  private pickAnchor(tip: TipId, place: string | undefined): number | null {
    let best: { key: number; order: number } | null = null;
    for (const [key, entry] of this.anchors) {
      if (!this.matches(entry, tip, place) || !entry.visible || !this.eligible(entry) || entry.available?.() === false) continue;
      if (!best || entry.order > best.order) best = { key, order: entry.order };
    }
    return best?.key ?? null;
  }

  private show(tip: TipId, anchor: number) {
    this.active = { tip, anchor, encounter: this.env.encounter() };
    this.candidate = null;
    this.clearTimer();
    this.emit();
  }

  /** The target went away or the tip no longer applies: hide it without retiring it. */
  private stepAside() {
    if (!this.active) return;
    this.interrupted.set(this.active.tip, this.active.encounter);
    this.active = null;
    this.clearOffscreen();
    this.emit();
    this.evaluate();
  }

  private schedule(ms: number) {
    this.clearTimer();
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      this.evaluate();
    }, Math.max(0, ms));
  }

  private clearTimer() {
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
  }

  private clearOffscreen() {
    if (this.offscreenTimer !== null) this.env.clearTimer(this.offscreenTimer);
    this.offscreenTimer = null;
  }

  /** Saves quietly, retrying once; resolves to whether it was saved. */
  private persist(save: () => Promise<unknown>): Promise<boolean> {
    return save()
      .catch(
        () =>
          new Promise<unknown>((resolve, reject) => {
            this.env.setTimer(() => void save().then(resolve, reject), RETRY_MS);
          }),
      )
      .then(
        () => true,
        () => false,
      );
  }
}
