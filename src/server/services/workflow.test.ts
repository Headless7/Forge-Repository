/**
 * One card, several deliverables, different people: independent assignments and deadlines, the
 * working rights they grant, and the notifications each step sends — to the right people, once,
 * linking to the right place. Every fixture is created here (test database only).
 */
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { notifications } from "@/server/db/schema";
import type { NotificationType } from "@/lib/notifications";
import { createUser, expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture, type TestUser } from "@/test/helpers";
import * as cardService from "./cards";
import * as comments from "./comments";
import * as deliverables from "./deliverables";
import { runDueDateReminders } from "./due-dates";
import { getStudioHome } from "./home";
import * as media from "./media";
import * as notificationService from "./notifications";
import * as projects from "./projects";
import * as reviews from "./reviews";
import * as studios from "./studios";

let f: Fixture;
let dev3: TestUser;
let cardId: string;
let model: string; // D1, prerequisite of the others
let rig: string; // D2, requires D1
let anim: string; // D3, requires D1 and D2
let viewerOnly: TestUser;

/** Notifications a user received since `since`, newest first. */
async function inbox(user: TestUser, since: Date) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.createdAt));
  return rows.filter((n) => n.createdAt.getTime() >= since.getTime());
}
const types = async (user: TestUser, since: Date) => (await inbox(user, since)).map((n) => n.type as NotificationType);
const mark = () => new Date(Date.now() - 1);

async function submitRevision(actor: TestUser["actor"], deliverableId: string) {
  const version = await media.createVersion(actor, { deliverableId });
  await upload(actor, cardId, { name: "work.png", type: "image/png", buffer: await pngBuffer(16, 16) }, "version", version.id);
  await reviews.submitForReview(actor, { deliverableId });
  return version;
}

beforeAll(async () => {
  f = await setupStudio();
  dev3 = await createUser("Dev Three");
  viewerOnly = f.viewer;
  await db.insert((await import("@/server/db/schema")).studioMembers).values({ studioId: f.studioId, userId: dev3.id, role: "CONTRIBUTOR" });
  // The manager runs the card; each deliverable has its own developer, reviewer and deadline.
  const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Boss", assigneeIds: [f.manager.id] });
  cardId = card.id;
  model = await primaryDeliverable(cardId);
  await deliverables.updateDeliverable(f.manager.actor, { deliverableId: model, name: "Model", ownerId: f.member.id, reviewerId: f.admin.id, dueAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
  let detail = await deliverables.createDeliverable(f.manager.actor, {
    cardId,
    name: "Rig",
    ownerId: f.member2.id,
    contributorIds: [dev3.id],
    reviewerId: f.owner.id,
    dueAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
    linkFrom: { id: model, type: "DEPENDENCY" },
  });
  rig = detail.deliverables.find((d) => d.name === "Rig")!.id;
  detail = await deliverables.createDeliverable(f.manager.actor, { cardId, name: "Animation", ownerId: dev3.id, reviewerId: f.admin.id, linkFrom: { id: model, type: "DEPENDENCY" } });
  anim = detail.deliverables.find((d) => d.name === "Animation")!.id;
  await deliverables.linkDeliverables(f.manager.actor, { cardId, fromId: rig, toId: anim, type: "DEPENDENCY" });
});

describe("independent deliverable assignments", () => {
  it("keeps people, reviewers and deadlines per deliverable", async () => {
    const detail = await cardService.getCardDetail(f.manager.actor, cardId);
    const byName = new Map(detail.deliverables.map((d) => [d.name, d]));
    expect(byName.get("Model")).toMatchObject({ ownerId: f.member.id, contributorIds: [], reviewerId: f.admin.id });
    expect(byName.get("Rig")).toMatchObject({ ownerId: f.member2.id, contributorIds: [dev3.id], reviewerId: f.owner.id });
    expect(byName.get("Animation")).toMatchObject({ ownerId: dev3.id, reviewerId: f.admin.id, dueAt: null });
    expect(byName.get("Rig")!.blockedBy).toEqual([model]);
    expect(detail.deliverableAssigneeIds.sort()).toEqual([f.member.id, f.member2.id, dev3.id].sort());
    // Changing the card's deadline never overwrites a deliverable's own.
    await cardService.updateCard(f.manager.actor, { cardId, dueAt: new Date(Date.now() + 5 * 86400_000).toISOString() });
    const after = await cardService.getCardDetail(f.manager.actor, cardId);
    expect(after.deliverables.find((d) => d.id === model)!.dueAt).toBe(byName.get("Model")!.dueAt);
    expect(after.deliverables.find((d) => d.id === anim)!.dueAt).toBeNull();
  });

  it("lets each developer work on their own deliverable only", async () => {
    // member2 isn't a card assignee: they can work on the rig, not on the model.
    await expect(media.createVersion(f.member2.actor, { deliverableId: rig })).resolves.toBeTruthy();
    await expectAppError(media.createVersion(f.member2.actor, { deliverableId: model }), "FORBIDDEN");
    // A contributor works on it too.
    await expect(media.createVersion(dev3.actor, { deliverableId: rig })).resolves.toBeTruthy();
    const detail = await cardService.getCardDetail(f.member2.actor, cardId);
    expect(detail.deliverables.find((d) => d.id === rig)!.permissions).toMatchObject({ canUpload: true, canSubmit: true, canEdit: false });
    expect(detail.deliverables.find((d) => d.id === model)!.permissions).toMatchObject({ canUpload: false, canSubmit: false });
  });

  it("only assigns people who can do the work or review it", async () => {
    await expectAppError(deliverables.updateDeliverable(f.manager.actor, { deliverableId: anim, contributorIds: [viewerOnly.id] }), "VALIDATION");
    await expectAppError(deliverables.updateDeliverable(f.manager.actor, { deliverableId: anim, reviewerId: f.member.id }), "VALIDATION");
    await expectAppError(deliverables.updateDeliverable(f.manager.actor, { deliverableId: anim, reviewerId: dev3.id }), "VALIDATION"); // own work
    await expectAppError(deliverables.updateDeliverable(f.outsider.actor, { deliverableId: anim, ownerId: f.outsider.id }), "NOT_FOUND");
    await expectAppError(deliverables.updateDeliverable(f.member.actor, { deliverableId: anim, ownerId: f.member2.id }), "FORBIDDEN");
  });

  it("shows each developer their deliverables at home, with blockers and inherited deadlines", async () => {
    const home = await getStudioHome(dev3.actor, f.studioId);
    const mine = new Map(home.deliverables.map((d) => [d.deliverable.id, d]));
    expect(mine.get(rig)).toMatchObject({ role: "contributor", waitingOn: ["Model"], dueInherited: false });
    expect(mine.get(anim)).toMatchObject({ role: "responsible", dueInherited: true, waitingOn: ["Model", "Rig"] });
    expect(mine.has(model)).toBe(false);
  });
});

describe("production notifications", () => {
  it("tells people when they're put on or taken off work, once", async () => {
    const since = mark();
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: anim, ownerId: f.member.id, contributorIds: [dev3.id] });
    expect(await types(f.member, since)).toEqual(["ASSIGNED"]);
    // dev3 was responsible and is now a contributor: still on it, so not "removed".
    expect(await types(dev3, since)).toEqual([]);
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: anim, ownerId: dev3.id, contributorIds: [] });
    expect(await types(f.member, since)).toEqual(["UNASSIGNED", "ASSIGNED"]);
    expect(await types(dev3, since)).toEqual(["ASSIGNED"]);
    const [assigned] = await inbox(dev3, since);
    expect(assigned).toMatchObject({ deliverableId: anim, data: expect.objectContaining({ role: "responsible", deliverable: "Animation" }) });
    expect(await types(f.manager, since)).toEqual([]); // never told about their own action
  });

  it("routes the review loop to the deliverable's people and links to the revision", async () => {
    const since = mark();
    const v1 = await submitRevision(f.member.actor, model);
    expect(await types(f.admin, since)).toEqual(["REVIEW_REQUESTED"]); // the model's reviewer
    expect(await types(f.owner, since)).not.toContain("REVIEW_REQUESTED"); // reviews the rig, not the model
    expect(await types(f.member2, since)).not.toContain("REVIEW_REQUESTED");

    await reviews.requestChanges(f.admin.actor, { deliverableId: model, items: ["Fix the hands"] });
    expect(await types(f.member, since)).toEqual(["CHANGES_REQUESTED"]);
    // member2 watches the card (they uploaded to it): general updates, never the model's review outcome.
    expect(await types(f.member2, since)).not.toContain("CHANGES_REQUESTED");

    const v2 = await submitRevision(f.member.actor, model);
    const requests = (await inbox(f.admin, since)).filter((n) => n.type === "REVIEW_REQUESTED");
    expect(requests.map((n) => n.data.resubmission)).toEqual([true, false]);
    expect(requests[0]!.versionId).toBe(v2.id);
    expect(requests[1]!.versionId).toBe(v1.id);

    const list = await notificationService.listNotifications(f.admin.actor, { limit: 5 });
    const link = list.items.find((n) => n.type === "REVIEW_REQUESTED")!.href;
    expect(link).toMatch(/\?card=[A-Z0-9]+-\d+&d=1&v=2$/);
  });

  it("tells dependants apart: one prerequisite approved vs ready to start vs waiting again", async () => {
    const since = mark();
    await reviews.approve(f.admin.actor, { deliverableId: model });
    expect(await types(f.member, since)).toEqual(["APPROVED"]);
    // The rig needed only the model: ready. The animation still needs the rig.
    expect(await types(f.member2, since)).toEqual(["UNBLOCKED"]);
    const dev3Got = await inbox(dev3, since);
    expect(dev3Got.map((n) => n.type).sort()).toEqual(["PREREQUISITE_APPROVED", "UNBLOCKED"]);
    expect(dev3Got.find((n) => n.type === "PREREQUISITE_APPROVED")).toMatchObject({ deliverableId: anim, data: expect.objectContaining({ remaining: 1, prerequisite: "Model" }) });

    const rigDone = mark();
    await submitRevision(f.member2.actor, rig);
    await reviews.approve(f.owner.actor, { deliverableId: rig });
    expect((await inbox(dev3, rigDone)).filter((n) => n.type === "UNBLOCKED").map((n) => n.deliverableId)).toEqual([anim]);

    const reopened = mark();
    await reviews.setDeliverableState(f.admin.actor, { deliverableId: model, state: "IN_PROGRESS" });
    expect(await types(f.member2, reopened)).toEqual(["BLOCKED"]);
    expect((await inbox(dev3, reopened)).map((n) => n.type)).toEqual(["BLOCKED", "BLOCKED"]);
  });

  it("notifies feedback authors when their feedback is resolved", async () => {
    const detail = await cardService.getCardDetail(f.member.actor, cardId);
    const feedback = detail.comments.find((c) => c.kind === "FEEDBACK" && c.body === "Fix the hands")!;
    const since = mark();
    await comments.setFeedbackResolved(f.member.actor, { commentId: feedback.id, resolved: true });
    expect(await types(f.admin, since)).toEqual(["FEEDBACK_RESOLVED"]);
  });

  it("sends each deadline reminder once, follows moved deadlines and skips finished work", async () => {
    const since = mark();
    // Model: due in 3h (but reopened, so unfinished). Rig: 2 days overdue but approved. Animation: inherits the card.
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: anim, dueAt: new Date(Date.now() - 3600_000).toISOString() });
    const runs = await Promise.all([runDueDateReminders(), runDueDateReminders(), runDueDateReminders()]);
    expect(runs.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect((await types(f.member, since)).filter((t) => t === "DUE_SOON")).toHaveLength(1);
    expect((await types(dev3, since)).filter((t) => t === "OVERDUE")).toHaveLength(1);
    expect((await types(f.member2, since)).filter((t) => t === "OVERDUE")).toHaveLength(0); // the rig is approved
    await runDueDateReminders();
    expect((await types(f.member, since)).filter((t) => t === "DUE_SOON")).toHaveLength(1);

    const moved = mark();
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: model, dueAt: new Date(Date.now() + 2 * 3600_000).toISOString() });
    expect(await types(f.member, moved)).toEqual(["DUE_CHANGED"]);
    await runDueDateReminders();
    expect(await types(f.member, moved)).toEqual(["DUE_SOON", "DUE_CHANGED"]);
  });

  it("tells the people on work when it's restored (not when it's archived: that would point at hidden work)", async () => {
    const since = mark();
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: anim, archived: true });
    expect(await types(dev3, since)).not.toContain("WORK_ARCHIVED");
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: anim, archived: false });
    expect((await inbox(dev3, since)).filter((n) => n.type === "WORK_ARCHIVED").map((n) => n.data.restored)).toEqual([true]);
  });

  it("only notifies people who can still open the project", async () => {
    const freelancer = await createUser("Freelancer");
    const invite = await studios.createInvitation(f.admin.actor, { studioId: f.studioId, email: freelancer.email, role: "CONTRIBUTOR", access: "PROJECTS", projectIds: [f.projectId] });
    await studios.acceptInvitation(freelancer.actor, { token: invite.url.split("/invite/")[1]! });
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: anim, contributorIds: [freelancer.id] });
    await projects.setProjectMember(f.admin.actor, { projectId: f.projectId, userId: freelancer.id, member: false });
    const since = mark();
    await comments.createComment(f.manager.actor, { cardId, body: "Status?", deliverableId: anim });
    expect(await types(freelancer, since)).toEqual([]);
    expect(await types(dev3, since)).toEqual(["COMMENT"]);
  });

  it("pages through notifications created at the same instant without gaps or repeats", async () => {
    const reader = await createUser("Reader");
    await db.insert((await import("@/server/db/schema")).studioMembers).values({ studioId: f.studioId, userId: reader.id, role: "VIEWER" });
    const at = new Date();
    await db.insert(notifications).values(Array.from({ length: 35 }, (_, i) => ({ userId: reader.id, studioId: f.studioId, type: "WATCHED_CARD", data: { i }, createdAt: at })));
    const first = await notificationService.listNotifications(reader.actor, { limit: 20 });
    const second = await notificationService.listNotifications(reader.actor, { limit: 20, before: first.nextCursor! });
    const ids = [...first.items, ...second.items].map((n) => n.id);
    expect(new Set(ids).size).toBe(35);
    expect(second.nextCursor).toBeNull();
    expect(first.unreadCount).toBe(35);
    await notificationService.markNotificationsRead(reader.actor, { all: true });
    expect(await notificationService.unreadCount(reader.id)).toBe(0);
    await notificationService.markNotificationsRead(reader.actor, { ids: [ids[0]!], read: false });
    expect(await notificationService.unreadCount(reader.id)).toBe(1);
  });

  it("respects preferences per type", async () => {
    await notificationService.setNotificationPreference(f.member.actor, { type: "COMMENT", inApp: false });
    const since = mark();
    await comments.createComment(f.manager.actor, { cardId, body: "Looking good", deliverableId: model });
    expect(await types(f.member, since)).toEqual([]);
    await notificationService.setNotificationPreference(f.member.actor, { type: "COMMENT", inApp: true });
    const prefs = await notificationService.getNotificationPreferences(f.member.actor);
    expect(prefs.emailAvailable).toBe(false); // no email provider in tests
    await expectAppError(notificationService.setNotificationPreference(f.member.actor, { type: "COMMENT", email: true }), "VALIDATION");
    const [row] = await db.select().from(notifications).where(and(eq(notifications.userId, f.member.id), eq(notifications.type, "COMMENT")));
    expect(row).toBeUndefined();
  });
});
