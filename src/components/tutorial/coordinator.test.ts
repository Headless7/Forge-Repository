import { describe, expect, it } from "vitest";
import { TIPS, type TipId } from "@/lib/tutorial";
import { TUTORIAL_TIMING as T, TutorialCoordinator, type TutorialEnv, type TutorialEvent } from "./coordinator";

/** A coordinator with a manual clock, timers and recorded saves. */
function setup(initial: { enabled?: boolean; seen?: Record<string, number> } = {}) {
  let clock = 0;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  const state = { busy: false, encounter: "/studio/project", failSaves: 0 };
  const saved: Array<[string, ...unknown[]]> = [];
  const broadcasts: TutorialEvent[] = [];
  const env: TutorialEnv = {
    now: () => clock,
    isBusy: () => state.busy,
    encounter: () => state.encounter,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
    save: {
      dismiss: (tip, version) => {
        saved.push(["dismiss", tip, version]);
        return state.failSaves-- > 0 ? Promise.reject(new Error("offline")) : Promise.resolve();
      },
      enabled: (enabled) => {
        saved.push(["enabled", enabled]);
        return Promise.resolve();
      },
      reset: () => {
        saved.push(["reset"]);
        return Promise.resolve();
      },
    },
    broadcast: (e) => broadcasts.push(e),
  };
  const c = new TutorialCoordinator({ enabled: initial.enabled ?? true, seen: initial.seen ?? {} }, env);
  /** Moves the clock forward, firing due timers in order. */
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      clock = due.at;
      due.fn();
    }
    clock = end;
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const anchor = <K extends TipId>(tip: K, facts: unknown = {}, visible = true, place?: string) => c.registerAnchor({ tip, facts, visible, place });
  const active = () => c.getSnapshot().activeTip;
  return { c, env, state, saved, broadcasts, advance, flush, anchor, active };
}

const reviewer = { canReview: true, state: "NEEDS_REVIEW", deliverableName: null };

describe("tutorial coordinator", () => {
  it("shows a triggered tip once the interaction settles and its target is mounted, visible and eligible", () => {
    const t = setup();
    t.c.trigger("card.workspace");
    expect(t.active()).toBeNull();
    t.advance(T.settleMs - 1);
    expect(t.active()).toBeNull(); // the interaction finishes first
    t.anchor("card.workspace");
    t.advance(1);
    expect(t.active()).toBe("card.workspace");
  });

  it("is driven by interactions only: a mounted target alone shows nothing", () => {
    const t = setup();
    t.anchor("card.workspace");
    t.advance(60_000);
    expect(t.active()).toBeNull();
  });

  it("shows one tip at a time and ignores triggers while one is showing", () => {
    const t = setup();
    t.anchor("card.workspace");
    t.anchor("card.revisions", { revisionCount: 3 });
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    t.c.trigger("card.revisions");
    t.advance(T.expiryMs);
    expect(t.active()).toBe("card.workspace");
  });

  it("retires a dismissed tip, saves it, and needs a fresh interaction after a cooldown for the next", async () => {
    const t = setup();
    t.anchor("card.workspace");
    t.anchor("card.revisions", { revisionCount: 3 });
    t.c.trigger(["card.workspace", "card.revisions"]);
    t.advance(T.settleMs);
    t.c.dismiss();
    expect(t.active()).toBeNull();
    expect(t.c.hasSeen("card.workspace")).toBe(true); // suppressed at once, before the save lands
    // The click that dismissed it can't start another, and the rest of the first trigger doesn't follow on.
    t.c.trigger("card.revisions");
    t.advance(T.expiryMs);
    expect(t.active()).toBeNull();
    await t.flush();
    expect(t.saved).toContainEqual(["dismiss", "card.workspace", TIPS["card.workspace"].version]);
    expect(t.broadcasts).toContainEqual({ type: "dismiss", tip: "card.workspace", version: 1 });
  });

  it("allows the next tip on a new interaction after the cooldown, and never re-offers a retired one", () => {
    const t = setup();
    t.anchor("card.workspace");
    t.anchor("card.revisions", { revisionCount: 3 });
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    t.c.dismiss();
    t.advance(T.cooldownMs);
    t.c.trigger(["card.workspace", "card.revisions"]);
    t.advance(T.settleMs);
    expect(t.active()).toBe("card.revisions");
  });

  it("keeps priority: waits briefly for a more important target, then falls back", () => {
    const t = setup();
    t.anchor("card.deliverables", { deliverableCount: 3 });
    t.c.trigger(["card.workspace", "card.deliverables"]);
    t.advance(T.settleMs);
    expect(t.active()).toBeNull(); // card.workspace may still mount
    t.advance(T.anchorWaitMs);
    expect(t.active()).toBe("card.deliverables");

    const u = setup();
    u.anchor("card.deliverables", { deliverableCount: 3 });
    u.c.trigger(["card.workspace", "card.deliverables"]);
    u.advance(T.settleMs);
    u.anchor("card.workspace");
    expect(u.active()).toBe("card.workspace");
  });

  it("skips tips the context doesn't allow, using the anchor's effective-permission facts", () => {
    const t = setup();
    t.anchor("card.review-decision", { ...reviewer, canReview: false });
    t.anchor("card.upload-vs-submit", { canSubmit: false, state: "IN_PROGRESS" });
    t.c.trigger(["card.review-decision", "card.upload-vs-submit"]);
    t.advance(T.expiryMs + 1);
    expect(t.active()).toBeNull();
    expect(t.c.hasSeen("card.review-decision")).toBe(false);
  });

  it("re-evaluates when permissions change: an ineligible tip steps aside without being retired", async () => {
    const t = setup();
    const key = t.anchor("card.review-decision", reviewer);
    t.c.trigger("card.review-decision");
    t.advance(T.settleMs);
    expect(t.active()).toBe("card.review-decision");
    t.c.updateAnchor(key, { tip: "card.review-decision", facts: { ...reviewer, canReview: false }, visible: true });
    expect(t.active()).toBeNull();
    await t.flush();
    expect(t.saved).toEqual([]);
    expect(t.c.hasSeen("card.review-decision")).toBe(false);
  });

  it("hides a tip whose target goes away, doesn't repeat it in the same place, and allows it on a later visit", () => {
    const t = setup();
    const key = t.anchor("card.workspace");
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    expect(t.active()).toBe("card.workspace");
    t.c.unregisterAnchor(key); // e.g. the card closed
    expect(t.active()).toBeNull();
    expect(t.c.hasSeen("card.workspace")).toBe(false);
    t.anchor("card.workspace"); // remounts in the same place
    t.c.trigger("card.workspace");
    t.advance(T.expiryMs);
    expect(t.active()).toBeNull();
    t.state.encounter = "/studio/project?card=PRJ-2"; // a new encounter
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    expect(t.active()).toBe("card.workspace");
  });

  it("steps aside when its target stays out of view, and only shows targets that are on screen", () => {
    const t = setup();
    const key = t.anchor("card.workspace");
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    t.c.updateAnchor(key, { tip: "card.workspace", facts: {}, visible: false });
    t.advance(T.offscreenMs - 1);
    expect(t.active()).toBe("card.workspace"); // a quick scroll away and back doesn't lose it
    t.advance(1);
    expect(t.active()).toBeNull();

    const u = setup();
    const k2 = u.anchor("card.workspace", {}, false);
    u.c.trigger("card.workspace");
    u.advance(T.settleMs + 100);
    expect(u.active()).toBeNull();
    u.c.updateAnchor(k2, { tip: "card.workspace", facts: {}, visible: true });
    expect(u.active()).toBe("card.workspace");
  });

  it("waits while the person is busy and drops the moment (unseen) when it passes", () => {
    const t = setup();
    t.anchor("card.feedback", { canComment: true, media: "image" });
    t.state.busy = true; // typing, dragging, uploading, media playing…
    t.c.trigger("card.feedback");
    t.advance(T.settleMs + 2000);
    expect(t.active()).toBeNull();
    t.state.busy = false;
    t.c.evaluate();
    expect(t.active()).toBe("card.feedback");

    const u = setup();
    u.anchor("card.feedback", { canComment: true, media: "image" });
    u.state.busy = true;
    u.c.trigger("card.feedback");
    u.advance(T.expiryMs + 1);
    u.state.busy = false;
    u.c.evaluate();
    expect(u.active()).toBeNull();
    expect(u.c.hasSeen("card.feedback")).toBe(false);
  });

  it("drops pending triggers on navigation, except one that navigates on purpose", () => {
    const t = setup();
    t.c.trigger("card.workspace");
    t.c.navigated();
    t.anchor("card.workspace");
    t.advance(T.settleMs);
    expect(t.active()).toBeNull();

    const u = setup();
    u.c.trigger("board.boards", { afterNavigation: true });
    u.c.navigated(); // the board switch itself
    u.anchor("board.boards", { boardCount: 3 });
    u.advance(T.settleMs);
    expect(u.active()).toBe("board.boards");
  });

  it("doesn't choose a target covered by something modal (e.g. the board behind an open card)", () => {
    const t = setup();
    let covered = true;
    const behind = t.c.registerAnchor({ tip: "production.stages", place: "board", facts: { place: "board", relevant: true }, visible: true, available: () => !covered });
    t.c.trigger("production.stages");
    t.advance(T.settleMs + 500);
    expect(t.active()).toBeNull();
    covered = false;
    t.c.evaluate();
    expect(t.c.getSnapshot().activeAnchor).toBe(behind);
  });

  it("chooses the anchor for the requested place", () => {
    const t = setup();
    t.anchor("card.attachments", { place: "attachments", canUpload: true, canEdit: true }, true, "attachments");
    const cover = t.anchor("card.attachments", { place: "cover", canUpload: true, canEdit: true }, true, "cover");
    t.c.trigger("card.attachments", { place: "cover" });
    t.advance(T.settleMs);
    expect(t.c.getSnapshot().activeAnchor).toBe(cover);
  });

  it("turning tips off closes the active tip and clears candidates at once; reset re-enables without showing anything", async () => {
    const t = setup();
    t.anchor("card.workspace");
    t.anchor("card.revisions", { revisionCount: 2 });
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    t.c.setEnabled(false);
    expect(t.active()).toBeNull();
    t.c.trigger("card.revisions");
    t.advance(T.expiryMs);
    expect(t.active()).toBeNull();
    await t.flush();
    expect(t.saved).toContainEqual(["enabled", false]);
    expect(t.c.hasSeen("card.workspace")).toBe(false); // turning off isn't "seen"

    t.c.reset();
    expect(t.c.isEnabled()).toBe(true);
    t.advance(T.expiryMs);
    expect(t.active()).toBeNull(); // no tour: nothing until the next interaction
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    expect(t.active()).toBe("card.workspace");
    await t.flush();
    expect(t.saved).toContainEqual(["reset"]);
  });

  it("starts from saved progress, so retired tips never flash on load", () => {
    const t = setup({ seen: { "card.workspace": 1 } });
    t.anchor("card.workspace");
    t.c.trigger("card.workspace");
    t.advance(T.expiryMs);
    expect(t.active()).toBeNull();
    const off = setup({ enabled: false });
    off.anchor("card.workspace");
    off.c.trigger("card.workspace");
    off.advance(T.expiryMs);
    expect(off.active()).toBeNull();
  });

  it("re-shows a tip whose version was bumped (a changed workflow), but not a copy edit", () => {
    const t = setup({ seen: { "card.workspace": 0 } });
    expect(t.c.hasSeen("card.workspace")).toBe(false);
    const u = setup({ seen: { "card.workspace": TIPS["card.workspace"].version } });
    expect(u.c.hasSeen("card.workspace")).toBe(true);
  });

  it("merges a server refresh with dismissals that haven't been saved yet, and follows other tabs", async () => {
    const t = setup();
    t.state.failSaves = 10; // offline
    t.anchor("card.workspace");
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    t.c.dismiss();
    t.c.applyServerState({ enabled: true, seen: { "card.revisions": 1 } });
    expect(t.c.hasSeen("card.workspace")).toBe(true); // still suppressed locally
    expect(t.c.hasSeen("card.revisions")).toBe(true); // dismissed on another device

    const u = setup();
    u.anchor("card.workspace");
    u.c.trigger("card.workspace");
    u.advance(T.settleMs);
    u.c.applyEvent({ type: "dismiss", tip: "card.workspace", version: 1 }); // dismissed in another tab
    expect(u.active()).toBeNull();
    expect(u.c.hasSeen("card.workspace")).toBe(true);
    u.c.applyEvent({ type: "enabled", enabled: false });
    expect(u.c.isEnabled()).toBe(false);
    u.c.applyEvent({ type: "reset" });
    expect(u.c.isEnabled()).toBe(true);
    expect(u.c.hasSeen("card.workspace")).toBe(false);
    expect(u.saved).toEqual([]); // events from other tabs aren't saved again
  });

  it("handles a failed save quietly: the tip stays suppressed this session and the save is retried once", async () => {
    const t = setup();
    t.state.failSaves = 1;
    t.anchor("card.workspace");
    t.c.trigger("card.workspace");
    t.advance(T.settleMs);
    t.c.dismiss();
    await t.flush();
    expect(t.saved.filter((s) => s[0] === "dismiss")).toHaveLength(1);
    t.advance(3000);
    await t.flush();
    expect(t.saved.filter((s) => s[0] === "dismiss")).toHaveLength(2);
    expect(t.c.hasSeen("card.workspace")).toBe(true);
  });
});
