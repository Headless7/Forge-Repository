import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { activityEvents, cards, notifications } from "@/server/db/schema";
import { createUser, expectAppError, setupStudio, type Fixture, primaryDeliverable } from "@/test/helpers";
import * as cardService from "./cards";
import * as checklists from "./checklists";
import * as comments from "./comments";
import * as projects from "./projects";
import * as reviews from "./reviews";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

const create = (title: string, columnId = f.columns.vfx, actor = f.owner.actor) => cardService.createCard(actor, { projectId: f.projectId, columnId, title });
const order = async (columnId: string) =>
  (await db.select().from(cards).where(eq(cards.columnId, columnId))).filter((c) => !c.archivedAt).sort((a, b) => a.position - b.position).map((c) => c.title);

describe("creating cards", () => {
  it("numbers cards per project, appends to the column and records activity", async () => {
    const a = await create("Alpha");
    const b = await create("Bravo");
    expect(b.number).toBe(a.number + 1);
    expect(a.key).toMatch(/^[A-Z0-9]+-\d+$/);
    expect(b.position).toBeGreaterThan(a.position);
    expect(a.state).toBe("NOT_SUBMITTED");
    const events = await db.select().from(activityEvents).where(and(eq(activityEvents.cardId, a.id), eq(activityEvents.type, "card.created")));
    expect(events).toHaveLength(1);
  });

  it("adds default reviewers and notifies assignees", async () => {
    await projects.updateProject(f.owner.actor, { projectId: f.projectId, settings: { defaultReviewerIds: [f.manager.id] } });
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Assigned", assigneeIds: [f.member.id] });
    const detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.reviewerIds).toContain(f.manager.id);
    expect(detail.assigneeIds).toEqual([f.member.id]);
    const notes = await db.select().from(notifications).where(and(eq(notifications.userId, f.member.id), eq(notifications.cardId, card.id)));
    expect(notes.map((n) => n.type)).toContain("ASSIGNED");
    await projects.updateProject(f.owner.actor, { projectId: f.projectId, settings: { defaultReviewerIds: [] } });
  });

  it("rejects viewers, member assignment of others, and foreign columns", async () => {
    await expectAppError(create("Nope", f.columns.vfx, f.viewer.actor), "FORBIDDEN");
    await expectAppError(
      cardService.createCard(f.member.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "x", assigneeIds: [f.member2.id] }),
      "FORBIDDEN",
    );
    await expectAppError(cardService.createCard(f.owner.actor, { projectId: f.projectId, columnId: f.otherColumnId, title: "x" }), "NOT_FOUND");
  });
});

describe("moving cards", () => {
  it("reorders within a column using neighbour hints", async () => {
    const col = f.columns.ui;
    const one = await create("One", col);
    const two = await create("Two", col);
    const three = await create("Three", col);
    await cardService.moveCard(f.owner.actor, { cardId: three.id, toColumnId: col, beforeCardId: one.id });
    expect(await order(col)).toEqual(["Three", "One", "Two"]);
    await cardService.moveCard(f.owner.actor, { cardId: three.id, toColumnId: col, afterCardId: two.id });
    expect(await order(col)).toEqual(["One", "Two", "Three"]);
  });

  it("moves across columns and logs it in the card history", async () => {
    const card = await create("Traveller", f.columns.vfx);
    const result = await cardService.moveCard(f.owner.actor, { cardId: card.id, toColumnId: f.columns.ui, index: 0 });
    expect(result.columnId).toBe(f.columns.ui);
    expect((await order(f.columns.ui))[0]).toBe("Traveller");
    const [event] = await db.select().from(activityEvents).where(and(eq(activityEvents.cardId, card.id), eq(activityEvents.type, "card.moved")));
    expect(event?.data).toMatchObject({ fromName: "VFX", toName: "UI" });
  });

  it("rebalances positions when floating-point gaps run out", async () => {
    const project = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: "Rebalance", template: "empty" });
    const { createColumn } = await import("./board");
    const col = await createColumn(f.owner.actor, { projectId: project.id, name: "Col" });
    const a = await cardService.createCard(f.owner.actor, { projectId: project.id, columnId: col.id, title: "A" });
    const b = await cardService.createCard(f.owner.actor, { projectId: project.id, columnId: col.id, title: "B" });
    await db.update(cards).set({ position: 1 }).where(eq(cards.id, a.id));
    await db.update(cards).set({ position: 1 + 1e-9 }).where(eq(cards.id, b.id));
    const c = await cardService.createCard(f.owner.actor, { projectId: project.id, columnId: col.id, title: "C" });
    await cardService.moveCard(f.owner.actor, { cardId: c.id, toColumnId: col.id, afterCardId: a.id, beforeCardId: b.id });
    expect(await order(col.id)).toEqual(["A", "C", "B"]);
    const positions = (await db.select().from(cards).where(eq(cards.columnId, col.id))).map((x) => x.position).sort((x, y) => x - y);
    expect(new Set(positions).size).toBe(3);
  });

  it("lets members move only cards they created or are assigned to", async () => {
    const theirs = await create("Someone else's", f.columns.vfx, f.manager.actor);
    await expectAppError(cardService.moveCard(f.member.actor, { cardId: theirs.id, toColumnId: f.columns.ui }), "FORBIDDEN");
    const mine = await create("Mine", f.columns.vfx, f.member.actor);
    await expect(cardService.moveCard(f.member.actor, { cardId: mine.id, toColumnId: f.columns.ui })).resolves.toMatchObject({ columnId: f.columns.ui });
  });

  it("refuses to move a card into another project's column", async () => {
    const card = await create("Stay home");
    await expectAppError(cardService.moveCard(f.owner.actor, { cardId: card.id, toColumnId: f.otherColumnId }), "NOT_FOUND");
  });
});

describe("editing, archiving and duplication", () => {
  it("detects conflicting description edits instead of overwriting", async () => {
    const card = await create("Conflicted");
    await cardService.updateCard(f.owner.actor, { cardId: card.id, description: "first", base: { description: "" } });
    await expectAppError(cardService.updateCard(f.manager.actor, { cardId: card.id, description: "stale", base: { description: "" } }), "CONFLICT");
    const detail = await cardService.updateCard(f.manager.actor, { cardId: card.id, description: "merged", base: { description: "first" } });
    expect(detail.description).toBe("merged");
  });

  it("archives and restores; permanent delete needs archive, the key and an admin", async () => {
    const card = await create("Disposable");
    await expectAppError(cardService.deleteCardPermanently(f.owner.actor, { cardId: card.id, confirm: card.key }), "VALIDATION");
    await cardService.setCardArchived(f.owner.actor, { cardId: card.id, archived: true });
    await expectAppError(cardService.deleteCardPermanently(f.manager.actor, { cardId: card.id, confirm: card.key }), "FORBIDDEN");
    await expectAppError(cardService.deleteCardPermanently(f.admin.actor, { cardId: card.id, confirm: "WRONG-1" }), "VALIDATION");
    const restored = await cardService.setCardArchived(f.owner.actor, { cardId: card.id, archived: false });
    expect(restored.id).toBe(card.id);
    await cardService.setCardArchived(f.owner.actor, { cardId: card.id, archived: true });
    await cardService.deleteCardPermanently(f.admin.actor, { cardId: card.id, confirm: card.key.toLowerCase() });
    expect(await db.select().from(cards).where(eq(cards.id, card.id))).toHaveLength(0);
  });

  it("duplicates checklists and assignees but not comments or review history", async () => {
    const source = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Original", assigneeIds: [f.member.id] });
    await checklists.createChecklist(f.manager.actor, { cardId: source.id, title: "Steps", items: ["a", "b"] });
    await comments.createComment(f.manager.actor, { cardId: source.id, body: "hello" });
    await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(source.id) });
    const copy = await cardService.duplicateCard(f.manager.actor, { cardId: source.id, include: { assignees: true, labels: true, checklists: true, attachments: true } });
    const detail = await cardService.getCardDetail(f.manager.actor, copy.id);
    expect(detail.title).toBe("Original (copy)");
    expect(detail.state).toBe("NOT_SUBMITTED");
    expect(detail.assigneeIds).toEqual([f.member.id]);
    expect(detail.checklists[0]?.items.map((i) => i.text)).toEqual(["a", "b"]);
    expect(detail.comments).toHaveLength(0);
    expect(detail.reviews).toHaveLength(0);
  });

  it("creates cards with unique numbers under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => create(`Burst ${i}`)));
    expect(new Set(results.map((r) => r.number)).size).toBe(8);
  });

  it("assignment respects project membership", async () => {
    const stranger = await createUser("Stranger");
    const card = await create("People");
    await expectAppError(cardService.setAssignees(f.owner.actor, { cardId: card.id, add: [stranger.id] }), "VALIDATION");
    const self = await cardService.setAssignees(f.member.actor, { cardId: card.id, add: [f.member.id] });
    expect(self.assigneeIds).toContain(f.member.id);
  });
});
