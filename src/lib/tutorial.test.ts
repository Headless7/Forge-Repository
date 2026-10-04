import { describe, expect, it } from "vitest";
import { isTipId, TIP_IDS, TIPS, type TipFacts, type TipId } from "./tutorial";

/** Representative facts for each tip: what a capable person (full) and a viewer (none) would report. */
const full: { [K in TipId]: TipFacts[K] } = {
  "board.status": {},
  "board.my-work": { worksOnCount: 2 },
  "board.boards": { boardCount: 3 },
  "production.stages": { place: "card", relevant: true },
  "schedule.dates": { view: "calendar", canEditAny: true, ready: true },
  "dashboard.reading": {},
  "card.workspace": {},
  "card.deliverables": { deliverableCount: 3 },
  "card.canvas": { deliverableCount: 3 },
  "card.revisions": { revisionCount: 2 },
  "card.feedback": { canComment: true, media: "image" },
  "card.upload-vs-submit": { canSubmit: true, state: "IN_PROGRESS" },
  "card.review-decision": { canReview: true, state: "NEEDS_REVIEW", deliverableName: "Rig" },
  "card.resolve-feedback": { canResolveFeedback: true, canUpload: true, canSubmit: true, state: "CHANGES_REQUESTED", unresolved: 2 },
  "card.attachments": { place: "attachments", canUpload: true, canEdit: true },
  "card.pending-changes": { pendingCount: 1, status: "PUBLISHED", canPublish: true },
  "card.assignment": { canAssign: true, multi: true },
  "roblox.preview": {},
  "access.scope": { place: "studio", canManage: true },
};

const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
const body = <K extends TipId>(tip: K, facts: TipFacts[K]) => TIPS[tip].body(facts);
const eligible = <K extends TipId>(tip: K, facts: TipFacts[K]) => TIPS[tip].eligible(facts);

describe("tutorial tip definitions", () => {
  it("have a short title and one or two sentences of body for every variant", () => {
    for (const tip of TIP_IDS) {
      const f = full[tip] as never;
      const title = TIPS[tip].title(f);
      expect(title.length, tip).toBeGreaterThan(5);
      expect(title.length, tip).toBeLessThanOrEqual(48);
      expect(sentences(TIPS[tip].body(f)), tip).toBeLessThanOrEqual(2);
      expect(TIPS[tip].version).toBeGreaterThanOrEqual(1);
      expect(isTipId(tip)).toBe(true);
    }
    expect(sentences(body("schedule.dates", { view: "timeline", canEditAny: true, ready: true }))).toBeLessThanOrEqual(2);
    expect(sentences(body("card.feedback", { canComment: true, media: "timed" }))).toBeLessThanOrEqual(2);
    expect(isTipId("constructor")).toBe(false);
  });

  it("only offer actions people can take", () => {
    // Reviewing, submitting, resolving, assigning, managing access: only with the matching permission.
    expect(eligible("card.review-decision", { canReview: false, state: "NEEDS_REVIEW", deliverableName: null })).toBe(false);
    expect(eligible("card.review-decision", { canReview: true, state: "IN_PROGRESS", deliverableName: null })).toBe(false);
    expect(eligible("card.upload-vs-submit", { canSubmit: false, state: "IN_PROGRESS" })).toBe(false);
    expect(eligible("card.upload-vs-submit", { canSubmit: true, state: "NEEDS_REVIEW" })).toBe(false);
    expect(eligible("card.resolve-feedback", { canResolveFeedback: false, canUpload: false, canSubmit: false, state: "CHANGES_REQUESTED", unresolved: 3 })).toBe(false);
    expect(eligible("card.resolve-feedback", { canResolveFeedback: true, canUpload: true, canSubmit: true, state: "CHANGES_REQUESTED", unresolved: 0 })).toBe(false);
    expect(eligible("card.assignment", { canAssign: false, multi: true })).toBe(false);
    expect(eligible("card.attachments", { place: "cover", canUpload: true, canEdit: false })).toBe(false);
    expect(eligible("card.attachments", { place: "attachments", canUpload: false, canEdit: true })).toBe(false);
    expect(eligible("access.scope", { place: "studio", canManage: false })).toBe(false);
    expect(eligible("card.feedback", { canComment: false, media: "image" })).toBe(false);

    // Copy adapts: no dragging, uploading or recording for people who can't.
    expect(body("schedule.dates", { view: "timeline", canEditAny: false, ready: true })).not.toMatch(/drag|select it/i);
    expect(body("schedule.dates", { view: "timeline", canEditAny: true, ready: true })).toMatch(/Drag a bar/);
    expect(body("schedule.dates", { view: "calendar", canEditAny: false, ready: true })).not.toMatch(/change its dates/i);
    expect(body("card.resolve-feedback", { canResolveFeedback: true, canUpload: false, canSubmit: false, state: "CHANGES_REQUESTED", unresolved: 1 })).not.toMatch(/upload|resubmit/i);
    expect(body("card.resolve-feedback", { canResolveFeedback: true, canUpload: false, canSubmit: true, state: "CHANGES_REQUESTED", unresolved: 1 })).not.toMatch(/upload/i);
    expect(body("card.pending-changes", { pendingCount: 1, status: "COMPLETED", canPublish: false })).not.toMatch(/record them/i);
    expect(body("card.pending-changes", { pendingCount: 1, status: "COMPLETED", canPublish: false })).toMatch(/completed/);
  });

  it("show context-specific tips only where they apply", () => {
    expect(eligible("card.deliverables", { deliverableCount: 1 })).toBe(false); // only on multi-deliverable cards
    expect(eligible("card.canvas", { deliverableCount: 1 })).toBe(false);
    expect(eligible("card.revisions", { revisionCount: 1 })).toBe(false);
    expect(eligible("board.boards", { boardCount: 1 })).toBe(false);
    expect(eligible("board.my-work", { worksOnCount: 0 })).toBe(false);
    expect(eligible("card.pending-changes", { pendingCount: 0, status: "PUBLISHED", canPublish: true })).toBe(false);
    expect(eligible("production.stages", { place: "card", relevant: false })).toBe(false);
    expect(eligible("production.stages", { place: "board", relevant: false })).toBe(true);
    expect(eligible("schedule.dates", { view: "timeline", canEditAny: true, ready: false })).toBe(false); // copy settles first
    // Concepts for everyone (Viewers included) suggest nothing they can't do.
    for (const tip of ["board.status", "card.workspace", "card.deliverables", "card.canvas", "card.revisions", "roblox.preview", "production.stages"] as const) {
      expect(eligible(tip, full[tip] as never), tip).toBe(true);
      // No instruction to do something a Viewer can't (an imperative starting a sentence or clause).
      expect(TIPS[tip].body(full[tip] as never), tip).not.toMatch(/(^|[.;:—]\s)(Drag|Upload|Submit|Approve|Assign|Invite|Publish|Complete|Mark)\b/);
    }
  });

  it("names the deliverable a review decision applies to on multi-deliverable cards", () => {
    expect(body("card.review-decision", { canReview: true, state: "NEEDS_REVIEW", deliverableName: "Rig" })).toMatch(/only to Rig's submitted revision/);
    expect(body("card.review-decision", { canReview: true, state: "NEEDS_REVIEW", deliverableName: null })).not.toMatch(/only to/);
  });
});
