import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { attachments, notifications, projects } from "@/server/db/schema";
import { storage } from "@/server/storage";
import { ITEM_VIDEO_MAX_BYTES } from "@/lib/types";
import { expectAppError, mp4Buffer, pngBuffer, setupStudio, type Fixture, type TestUser } from "@/test/helpers";
import * as forums from "./forums";
import * as media from "./media";
import * as projectService from "./projects";

let f: Fixture;
let key: string;
let bugsForumId: string;
let qaForumId: string;
beforeAll(async () => {
  f = await setupStudio();
  const [p] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, f.projectId));
  key = p!.key;
  const list = await forums.listForumsFor(f.owner.actor, f.projectId);
  bugsForumId = list.find((x) => x.kind === "BUGS")!.id;
  qaForumId = list.find((x) => x.kind === "QA")!.id;
});

const report = (who: TestUser, input: Partial<forums.CreateItemInput> & { title: string }, forumId = bugsForumId) => forums.createItem(who.actor, { forumId, ...input });

/** Runs the real upload lifecycle on an item: create intent → write object → complete. */
async function uploadToItem(who: TestUser, itemId: string, file: { name: string; type: string; buffer: Buffer }) {
  const intent = await media.createUpload(who.actor, { itemId, filename: file.name, size: file.buffer.length, contentType: file.type, purpose: "item" });
  const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
  await storage().put(row!.storageKey, file.buffer, file.type);
  return media.completeUpload(who.actor, { attachmentId: intent.attachmentId });
}

const notes = (userId: string, itemId: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.itemId, itemId)));

describe("forums", () => {
  it("every project starts with Bugs and QA", async () => {
    const list = await forums.listForumsFor(f.member.actor, f.projectId);
    expect(list.map((x) => [x.slug, x.kind, x.keyPrefix, x.itemLabel])).toEqual([
      ["bugs", "BUGS", "B", "bug"],
      ["qa", "QA", "Q", "issue"],
    ]);
    const fresh = await projectService.createProject(f.owner.actor, { studioId: f.studioId, name: "Fresh", template: "empty" });
    expect((await forums.listForumsFor(f.owner.actor, fresh.id)).map((x) => x.name)).toEqual(["Bugs", "QA"]);
    await expectAppError(forums.listForumsFor(f.outsider.actor, f.projectId), "NOT_FOUND");
  });

  it("managers add custom forums with their own slug, prefix and noun; standard ones can't be archived", async () => {
    await expectAppError(forums.createForum(f.member.actor, { projectId: f.projectId, name: "Playtest" }), "FORBIDDEN");
    const playtest = await forums.createForum(f.manager.actor, { projectId: f.projectId, name: "Update 6.5 playtest", itemLabel: "finding", defaultReviewerId: f.manager.id });
    expect(playtest).toMatchObject({ slug: "update-6-5-playtest", kind: "CUSTOM", keyPrefix: "U65", itemLabel: "finding", settings: { defaultReviewerId: f.manager.id } });
    // A second forum with a clashing prefix gets a distinct one; a clashing name gets a distinct slug.
    const again = await forums.createForum(f.manager.actor, { projectId: f.projectId, name: "Update 6.5 playtest" });
    expect(again.slug).toBe("update-6-5-playtest-2");
    expect(again.keyPrefix).not.toBe(playtest.keyPrefix);
    await expectAppError(forums.updateForum(f.manager.actor, { forumId: again.id, keyPrefix: "B" }), "CONFLICT");
    const item = await report(f.member, { title: "Dash feels floaty" }, playtest.id);
    expect(item.key).toBe(`${key}-U651`);
    expect(item.reviewerId).toBe(f.manager.id);
    const renamed = await forums.updateForum(f.manager.actor, { forumId: again.id, name: "Spare", archived: true });
    expect(renamed).toMatchObject({ slug: "spare", archived: true });
    await expectAppError(report(f.member, { title: "Nope" }, again.id), "CONFLICT");
    await expectAppError(forums.updateForum(f.manager.actor, { forumId: bugsForumId, archived: true }), "VALIDATION");
    const view = await forums.getForumView(f.member.actor, playtest.id);
    expect(view.forums.some((x) => x.id === again.id)).toBe(false);
    expect(view.items.map((x) => x.id)).toEqual([item.id]);
  });

  it("numbers items per forum (UTD-B1, UTD-Q1) and starts them open with the forum's default reviewer", async () => {
    await forums.updateForum(f.owner.actor, { forumId: bugsForumId, defaultReviewerId: f.manager.id });
    const bug = await report(f.member, { title: "Lamps float above the ground", description: "Lobby, non-upgraded lamps only.", priority: "HIGH" });
    expect(bug).toMatchObject({ key: `${key}-B1`, number: 1, status: "OPEN", priority: "HIGH", reportedById: f.member.id, reviewerId: f.manager.id, assigneeId: null });
    const second = await report(f.member, { title: "Second" });
    expect(second.number).toBe(2);
    const check = await report(f.member, { title: "Mobile purchase flow" }, qaForumId);
    expect(check).toMatchObject({ key: `${key}-Q1`, number: 1, reviewerId: null });
    expect((await notes(f.manager.id, bug.id)).map((n) => n.type)).toContain("ITEM_REVIEWER_ASSIGNED");
  });

  it("lets reporters pick themselves but not other people", async () => {
    const own = await report(f.developer, { title: "Mine", assigneeId: f.developer.id });
    expect(own.assigneeId).toBe(f.developer.id);
    await expectAppError(report(f.developer, { title: "Theirs", assigneeId: f.member.id }), "FORBIDDEN");
    await expectAppError(report(f.developer, { title: "Theirs", reviewerId: f.member.id }), "FORBIDDEN");
    const assigned = await report(f.manager, { title: "Assigned", assigneeId: f.developer.id, reviewerId: f.owner.id });
    expect(assigned).toMatchObject({ assigneeId: f.developer.id, reviewerId: f.owner.id });
    expect((await notes(f.developer.id, assigned.id)).map((n) => n.type)).toContain("ITEM_ASSIGNED");
  });

  it("keeps viewers and outsiders out", async () => {
    await expectAppError(report(f.viewer, { title: "Nope" }), "FORBIDDEN");
    await expectAppError(forums.createItem(f.outsider.actor, { forumId: bugsForumId, title: "Nope" }), "NOT_FOUND");
    const item = await report(f.member, { title: "Private" });
    await expectAppError(forums.getItem(f.outsider.actor, item.id), "NOT_FOUND");
    await expectAppError(forums.getForumView(f.outsider.actor, bugsForumId), "NOT_FOUND");
    const view = await forums.getForumView(f.viewer.actor, bugsForumId);
    expect(view.items.some((b) => b.id === item.id)).toBe(true);
  });
});

describe("the workflow", () => {
  it("runs open → in progress → done → verified, and only the reviewer (or a manager) verifies", async () => {
    const item = await report(f.manager, { title: "Auto roll stops after 10", assigneeId: f.member.id, reviewerId: f.developer.id });
    const started = await forums.setItemStatus(f.member.actor, { itemId: item.id, status: "IN_PROGRESS" });
    expect(started.status).toBe("IN_PROGRESS");
    await expectAppError(forums.setItemStatus(f.member2.actor, { itemId: item.id, status: "FIXED" }), "FORBIDDEN");
    const fixed = await forums.setItemStatus(f.member.actor, { itemId: item.id, status: "FIXED" });
    expect(fixed).toMatchObject({ status: "FIXED", fixedById: f.member.id });
    expect(fixed.fixedAt).not.toBeNull();
    expect((await notes(f.developer.id, item.id)).map((n) => n.type)).toContain("ITEM_FIXED");
    // The assignee can't verify their own work; the item's reviewer (a Developer here) can.
    await expectAppError(forums.setItemStatus(f.member.actor, { itemId: item.id, status: "VERIFIED" }), "FORBIDDEN");
    const verified = await forums.setItemStatus(f.developer.actor, { itemId: item.id, status: "VERIFIED" });
    expect(verified).toMatchObject({ status: "VERIFIED", verifiedById: f.developer.id });
    expect((await notes(f.member.id, item.id)).map((n) => n.type)).toContain("ITEM_RESOLVED");
    const reopened = await forums.setItemStatus(f.member.actor, { itemId: item.id, status: "OPEN" });
    expect(reopened).toMatchObject({ status: "OPEN", fixedAt: null, verifiedAt: null, verifiedById: null });
  });

  it("lets a manager send work back, and stops a manager verifying what they did themselves", async () => {
    // The manager is also the Bugs forum's default reviewer: being named reviewer doesn't allow self-verification either.
    const item = await report(f.member, { title: "Trait index says skip" });
    expect(item.reviewerId).toBe(f.manager.id);
    const mine = await forums.setItemStatus(f.manager.actor, { itemId: item.id, status: "IN_PROGRESS" });
    expect(mine.assigneeId).toBe(f.manager.id);
    await forums.setItemStatus(f.manager.actor, { itemId: item.id, status: "FIXED" });
    await expectAppError(forums.setItemStatus(f.manager.actor, { itemId: item.id, status: "VERIFIED" }), "FORBIDDEN");
    const back = await forums.setItemStatus(f.admin.actor, { itemId: item.id, status: "IN_PROGRESS" });
    expect(back).toMatchObject({ status: "IN_PROGRESS", fixedAt: null });
    expect((await notes(f.manager.id, item.id)).map((n) => n.type)).toContain("ITEM_REOPENED");
    const verified = await forums.setItemStatus(f.admin.actor, { itemId: item.id, status: "VERIFIED" });
    expect(verified.status).toBe("VERIFIED");
  });

  it("lets workers take an unassigned item by starting on it", async () => {
    const item = await report(f.member, { title: "Curses don't drop in Summerween" });
    const taken = await forums.setItemStatus(f.developer.actor, { itemId: item.id, status: "IN_PROGRESS" });
    expect(taken.assigneeId).toBe(f.developer.id);
    await expectAppError(forums.updateItem(f.member2.actor, { itemId: item.id, assigneeId: f.member2.id }), "FORBIDDEN");
    await expectAppError(forums.setItemStatus(f.member2.actor, { itemId: item.id, status: "FIXED" }), "FORBIDDEN");
  });

  it("closes without doing it for a reason, by a manager or the reporter", async () => {
    const item = await report(f.member, { title: "Duplicate report", assigneeId: f.member.id });
    await expectAppError(forums.setItemStatus(f.member2.actor, { itemId: item.id, status: "CLOSED", resolution: "DUPLICATE" }), "FORBIDDEN");
    await expectAppError(forums.setItemStatus(f.member.actor, { itemId: item.id, status: "CLOSED" }), "VALIDATION");
    const closed = await forums.setItemStatus(f.member.actor, { itemId: item.id, status: "CLOSED", resolution: "DUPLICATE" });
    expect(closed).toMatchObject({ status: "CLOSED", resolution: "DUPLICATE", closedById: f.member.id });
    await expectAppError(forums.setItemStatus(f.manager.actor, { itemId: item.id, status: "FIXED" }), "VALIDATION");
    const reopened = await forums.setItemStatus(f.manager.actor, { itemId: item.id, status: "OPEN" });
    expect(reopened).toMatchObject({ status: "OPEN", resolution: null, closedAt: null });
  });
});

describe("editing, tags and updates", () => {
  it("edits fields with the right rights and records history", async () => {
    const { createMilestone } = await import("./labels");
    const update = await createMilestone(f.manager.actor, { projectId: f.projectId, name: "Update 6.0" });
    const item = await report(f.member, { title: "Typo", milestoneId: update.id });
    expect(item.milestoneId).toBe(update.id);
    await expectAppError(forums.updateItem(f.member2.actor, { itemId: item.id, title: "Hijacked" }), "FORBIDDEN");
    const edited = await forums.updateItem(f.member.actor, { itemId: item.id, title: "Typo in trait index", priority: "LOW", milestoneId: null, description: "Says skip instead of keep." });
    expect(edited).toMatchObject({ title: "Typo in trait index", priority: "LOW", milestoneId: null, description: "Says skip instead of keep." });
    const { listItemActivity } = await import("./activity");
    const types = (await listItemActivity(item.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["item.created", "item.renamed", "item.priority_changed", "item.milestone_changed", "item.description_changed"]));
    expect((await listItemActivity(item.id))[0]!.item).toMatchObject({ key: `${key}-B${item.number}`, forumSlug: "bugs", forumName: "Bugs" });
  });

  it("tags belong to one forum, are managed by managers, and only that forum's tags count", async () => {
    await expectAppError(forums.createTag(f.member.actor, { forumId: bugsForumId, name: "Lobby", color: "#60a5fa" }), "FORBIDDEN");
    const lobby = await forums.createTag(f.manager.actor, { forumId: bugsForumId, name: "Lobby", color: "#60a5fa" });
    const ui = await forums.createTag(f.manager.actor, { forumId: bugsForumId, name: "UI", color: "#a78bfa" });
    const qaTag = await forums.createTag(f.manager.actor, { forumId: qaForumId, name: "Lobby", color: "#60a5fa" });
    const item = await report(f.member, { title: "Tagged", tagIds: [lobby.id, qaTag.id] });
    expect(item.tagIds).toEqual([lobby.id]);
    const retagged = await forums.updateItem(f.member.actor, { itemId: item.id, tagIds: [ui.id, lobby.id] });
    expect(retagged.tagIds.sort()).toEqual([lobby.id, ui.id].sort());
    const view = await forums.getForumView(f.member.actor, bugsForumId);
    expect(view.tags.map((t) => t.name)).toEqual(expect.arrayContaining(["Lobby", "UI"]));
    expect(view.tags.some((t) => t.id === qaTag.id)).toBe(false);
    await forums.deleteTag(f.manager.actor, { tagId: ui.id });
    expect((await forums.getItem(f.member.actor, item.id)).tagIds).toEqual([lobby.id]);
  });
});

describe("pictures, clips and comments", () => {
  it("takes images and clips through the upload pipeline, counts them on the list, and removes them for good", async () => {
    const item = await report(f.member, { title: "Ground placement is inconsistent" });
    const image = await uploadToItem(f.member, item.id, { name: "portal.png", type: "image/png", buffer: await pngBuffer(640, 360) });
    expect(image).toMatchObject({ kind: "IMAGE", status: "READY", purpose: "ITEM", itemId: item.id, cardId: null, width: 640 });
    expect(image.thumbUrl).toMatch(/thumb\.webp/);
    const clip = await uploadToItem(f.member, item.id, { name: "repro.mp4", type: "video/mp4", buffer: mp4Buffer(1) });
    expect(clip.kind).toBe("VIDEO");
    const detail = await forums.getItem(f.member.actor, item.id);
    expect(detail.attachments.map((a) => a.id)).toEqual([image.id, clip.id]);
    const row = (await forums.getForumView(f.member.actor, bugsForumId)).items.find((b) => b.id === item.id)!;
    expect(row.counts.attachments).toBe(2);
    expect(row.cover?.attachmentId).toBe(image.id);
    await expectAppError(media.createUpload(f.member.actor, { itemId: item.id, filename: "notes.txt", size: 10, contentType: "text/plain", purpose: "item" }), "VALIDATION");
    // Videos stop at 10 MB: bigger ones are linked from Discord instead. Pictures aren't capped this way.
    await expect(media.createUpload(f.member.actor, { itemId: item.id, filename: "long.mp4", size: ITEM_VIDEO_MAX_BYTES + 1, contentType: "video/mp4", purpose: "item" })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: expect.stringContaining("Discord") });
    await media.createUpload(f.member.actor, { itemId: item.id, filename: "big.png", size: ITEM_VIDEO_MAX_BYTES + 1, contentType: "image/png", purpose: "item" });
    await expectAppError(media.createUpload(f.member2.actor, { itemId: item.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "item" }), "FORBIDDEN");
    await expectAppError(media.createUpload(f.outsider.actor, { itemId: item.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "item" }), "NOT_FOUND");
    await expectAppError(forums.removeItemAttachment(f.member2.actor, { attachmentId: image.id }), "FORBIDDEN");
    const after = await forums.removeItemAttachment(f.member.actor, { attachmentId: image.id });
    expect(after.attachments.map((a) => a.id)).toEqual([clip.id]);
    expect(await db.select().from(attachments).where(eq(attachments.id, image.id))).toHaveLength(0);
  });

  it("threads comments, notifies the people on the item and anyone @mentioned", async () => {
    const item = await report(f.member, { title: "Discuss", assigneeId: f.member.id });
    await expectAppError(forums.addComment(f.viewer.actor, { itemId: item.id, body: "hi" }), "FORBIDDEN");
    await expectAppError(forums.addComment(f.manager.actor, { itemId: item.id, body: "   " }), "VALIDATION");
    const withComment = await forums.addComment(f.manager.actor, { itemId: item.id, body: `Can't reproduce — @${f.developer.username} can you try on mobile?` });
    expect(withComment.comments).toHaveLength(1);
    expect((await notes(f.member.id, item.id)).map((n) => n.type)).toContain("ITEM_COMMENT");
    expect((await notes(f.developer.id, item.id)).map((n) => n.type)).toContain("MENTIONED");
    const id = withComment.comments[0]!.id;
    await expectAppError(forums.editComment(f.member.actor, { commentId: id, body: "mine now" }), "FORBIDDEN");
    const edited = await forums.editComment(f.manager.actor, { commentId: id, body: "Reproduced on mobile." });
    expect(edited.comments[0]).toMatchObject({ body: "Reproduced on mobile." });
    const removed = await forums.deleteComment(f.manager.actor, { commentId: id });
    expect(removed.comments[0]!.deletedAt).not.toBeNull();
    expect((await forums.getForumView(f.member.actor, bugsForumId)).items.find((b) => b.id === item.id)?.counts.comments).toBe(0);
  });
});

describe("deleting", () => {
  it("is for admins, and takes files with it", async () => {
    const item = await report(f.member, { title: "Mistake" });
    const image = await uploadToItem(f.member, item.id, { name: "oops.png", type: "image/png", buffer: await pngBuffer(64, 48) });
    await expectAppError(forums.deleteItem(f.manager.actor, { itemId: item.id }), "FORBIDDEN");
    await forums.deleteItem(f.admin.actor, { itemId: item.id });
    await expectAppError(forums.getItem(f.member.actor, item.id), "NOT_FOUND");
    expect(await db.select().from(attachments).where(eq(attachments.id, image.id))).toHaveLength(0);
  });
});
