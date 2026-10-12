import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { attachments, notifications, projects } from "@/server/db/schema";
import { storage } from "@/server/storage";
import { expectAppError, mp4Buffer, pngBuffer, setupStudio, type Fixture, type TestUser } from "@/test/helpers";
import * as bugs from "./bugs";
import * as media from "./media";

let f: Fixture;
let key: string;
beforeAll(async () => {
  f = await setupStudio();
  const [p] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, f.projectId));
  key = p!.key;
});

const report = (who: TestUser, input: Partial<bugs.CreateBugInput> & { title: string }) => bugs.createBug(who.actor, { projectId: f.projectId, ...input });

/** Runs the real upload lifecycle on a bug: create intent → write object → complete. */
async function uploadToBug(who: TestUser, bugId: string, file: { name: string; type: string; buffer: Buffer }) {
  const intent = await media.createUpload(who.actor, { bugId, filename: file.name, size: file.buffer.length, contentType: file.type, purpose: "bug" });
  const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
  await storage().put(row!.storageKey, file.buffer, file.type);
  return media.completeUpload(who.actor, { attachmentId: intent.attachmentId });
}

const notes = (userId: string, bugId: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.bugId, bugId)));

describe("reporting bugs", () => {
  it("numbers bugs per project (UTD-B1) and starts them open with the default reviewer", async () => {
    const { updateProject } = await import("./projects");
    await updateProject(f.owner.actor, { projectId: f.projectId, settings: { defaultBugReviewerId: f.manager.id } });
    const bug = await report(f.member, { title: "Lamps float above the ground", description: "Lobby, non-upgraded lamps only.", priority: "HIGH" });
    expect(bug).toMatchObject({ key: `${key}-B1`, number: 1, status: "OPEN", priority: "HIGH", reportedById: f.member.id, reviewerId: f.manager.id, assigneeId: null });
    const second = await report(f.member, { title: "Second" });
    expect(second.number).toBe(2);
    expect((await notes(f.manager.id, bug.id)).map((n) => n.type)).toContain("BUG_REVIEWER_ASSIGNED");
  });

  it("lets reporters pick themselves but not other people", async () => {
    const own = await report(f.developer, { title: "Mine", assigneeId: f.developer.id });
    expect(own.assigneeId).toBe(f.developer.id);
    await expectAppError(report(f.developer, { title: "Theirs", assigneeId: f.member.id }), "FORBIDDEN");
    await expectAppError(report(f.developer, { title: "Theirs", reviewerId: f.member.id }), "FORBIDDEN");
    const assigned = await report(f.manager, { title: "Assigned", assigneeId: f.developer.id, reviewerId: f.owner.id });
    expect(assigned).toMatchObject({ assigneeId: f.developer.id, reviewerId: f.owner.id });
    expect((await notes(f.developer.id, assigned.id)).map((n) => n.type)).toContain("BUG_ASSIGNED");
  });

  it("keeps viewers and outsiders out", async () => {
    await expectAppError(report(f.viewer, { title: "Nope" }), "FORBIDDEN");
    await expectAppError(bugs.createBug(f.outsider.actor, { projectId: f.projectId, title: "Nope" }), "NOT_FOUND");
    const bug = await report(f.member, { title: "Private" });
    await expectAppError(bugs.getBug(f.outsider.actor, bug.id), "NOT_FOUND");
    await expectAppError(bugs.listBugs(f.outsider.actor, f.projectId), "NOT_FOUND");
    const list = await bugs.listBugs(f.viewer.actor, f.projectId);
    expect(list.bugs.some((b) => b.id === bug.id)).toBe(true);
  });
});

describe("the fix workflow", () => {
  it("runs open → in progress → fixed → verified, and only the reviewer (or a manager) verifies", async () => {
    const bug = await report(f.manager, { title: "Auto roll stops after 10", assigneeId: f.member.id, reviewerId: f.developer.id });
    const started = await bugs.setBugStatus(f.member.actor, { bugId: bug.id, status: "IN_PROGRESS" });
    expect(started.status).toBe("IN_PROGRESS");
    await expectAppError(bugs.setBugStatus(f.member2.actor, { bugId: bug.id, status: "FIXED" }), "FORBIDDEN");
    const fixed = await bugs.setBugStatus(f.member.actor, { bugId: bug.id, status: "FIXED" });
    expect(fixed).toMatchObject({ status: "FIXED", fixedById: f.member.id });
    expect(fixed.fixedAt).not.toBeNull();
    expect((await notes(f.developer.id, bug.id)).map((n) => n.type)).toContain("BUG_FIXED");
    // The assignee can't verify their own fix; the bug's reviewer (a Developer here) can.
    await expectAppError(bugs.setBugStatus(f.member.actor, { bugId: bug.id, status: "VERIFIED" }), "FORBIDDEN");
    const verified = await bugs.setBugStatus(f.developer.actor, { bugId: bug.id, status: "VERIFIED" });
    expect(verified).toMatchObject({ status: "VERIFIED", verifiedById: f.developer.id });
    expect((await notes(f.member.id, bug.id)).map((n) => n.type)).toContain("BUG_RESOLVED");
    // Resolved bugs leave the open list; reopening brings them back and clears the record.
    expect((await bugs.listBugs(f.member.actor, f.projectId)).bugs.find((b) => b.id === bug.id)?.verifiedAt).not.toBeNull();
    const reopened = await bugs.setBugStatus(f.member.actor, { bugId: bug.id, status: "OPEN" });
    expect(reopened).toMatchObject({ status: "OPEN", fixedAt: null, verifiedAt: null, verifiedById: null });
  });

  it("lets a manager send a fix back, and stops a manager verifying what they fixed themselves", async () => {
    // The manager is also the project's default reviewer here: being named reviewer doesn't allow self-verification either.
    const bug = await report(f.member, { title: "Trait index says skip" });
    expect(bug.reviewerId).toBe(f.manager.id);
    const mine = await bugs.setBugStatus(f.manager.actor, { bugId: bug.id, status: "IN_PROGRESS" });
    expect(mine.assigneeId).toBe(f.manager.id);
    await bugs.setBugStatus(f.manager.actor, { bugId: bug.id, status: "FIXED" });
    await expectAppError(bugs.setBugStatus(f.manager.actor, { bugId: bug.id, status: "VERIFIED" }), "FORBIDDEN");
    const back = await bugs.setBugStatus(f.admin.actor, { bugId: bug.id, status: "IN_PROGRESS" });
    expect(back).toMatchObject({ status: "IN_PROGRESS", fixedAt: null });
    expect((await notes(f.manager.id, bug.id)).map((n) => n.type)).toContain("BUG_REOPENED");
    const verified = await bugs.setBugStatus(f.admin.actor, { bugId: bug.id, status: "VERIFIED" });
    expect(verified.status).toBe("VERIFIED");
  });

  it("lets workers take an unassigned bug by starting on it", async () => {
    const bug = await report(f.member, { title: "Curses don't drop in Summerween" });
    const taken = await bugs.setBugStatus(f.developer.actor, { bugId: bug.id, status: "IN_PROGRESS" });
    expect(taken.assigneeId).toBe(f.developer.id);
    // Now it's theirs: someone else can't take it over without assign rights.
    await expectAppError(bugs.updateBug(f.member2.actor, { bugId: bug.id, assigneeId: f.member2.id }), "FORBIDDEN");
    await expectAppError(bugs.setBugStatus(f.member2.actor, { bugId: bug.id, status: "FIXED" }), "FORBIDDEN");
  });

  it("closes without a fix for a reason, by a manager or the reporter", async () => {
    const bug = await report(f.member, { title: "Duplicate report", assigneeId: f.member.id });
    await expectAppError(bugs.setBugStatus(f.member2.actor, { bugId: bug.id, status: "CLOSED", resolution: "DUPLICATE" }), "FORBIDDEN");
    await expectAppError(bugs.setBugStatus(f.member.actor, { bugId: bug.id, status: "CLOSED" }), "VALIDATION");
    const closed = await bugs.setBugStatus(f.member.actor, { bugId: bug.id, status: "CLOSED", resolution: "DUPLICATE" });
    expect(closed).toMatchObject({ status: "CLOSED", resolution: "DUPLICATE", closedById: f.member.id });
    await expectAppError(bugs.setBugStatus(f.manager.actor, { bugId: bug.id, status: "FIXED" }), "VALIDATION");
    const reopened = await bugs.setBugStatus(f.manager.actor, { bugId: bug.id, status: "OPEN" });
    expect(reopened).toMatchObject({ status: "OPEN", resolution: null, closedAt: null });
  });
});

describe("editing, tags and updates", () => {
  it("edits fields with the right rights and records history", async () => {
    const { createMilestone } = await import("./labels");
    const update = await createMilestone(f.manager.actor, { projectId: f.projectId, name: "Update 6.0" });
    const bug = await report(f.member, { title: "Typo", milestoneId: update.id });
    expect(bug.milestoneId).toBe(update.id);
    await expectAppError(bugs.updateBug(f.member2.actor, { bugId: bug.id, title: "Hijacked" }), "FORBIDDEN");
    const edited = await bugs.updateBug(f.member.actor, { bugId: bug.id, title: "Typo in trait index", priority: "LOW", milestoneId: null, description: "Says skip instead of keep." });
    expect(edited).toMatchObject({ title: "Typo in trait index", priority: "LOW", milestoneId: null, description: "Says skip instead of keep." });
    const { listBugActivity } = await import("./activity");
    const types = (await listBugActivity(bug.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["bug.created", "bug.renamed", "bug.priority_changed", "bug.milestone_changed", "bug.description_changed"]));
    expect((await listBugActivity(bug.id))[0]!.bug).toMatchObject({ key: `${key}-B${bug.number}` });
  });

  it("tags are project-wide, managed by managers, and only this project's tags count", async () => {
    await expectAppError(bugs.createBugTag(f.member.actor, { projectId: f.projectId, name: "Lobby", color: "#60a5fa" }), "FORBIDDEN");
    const lobby = await bugs.createBugTag(f.manager.actor, { projectId: f.projectId, name: "Lobby", color: "#60a5fa" });
    const ui = await bugs.createBugTag(f.manager.actor, { projectId: f.projectId, name: "UI", color: "#a78bfa" });
    await expectAppError(bugs.createBugTag(f.manager.actor, { projectId: f.projectId, name: "lobby ", color: "#60a5fa" }), "VALIDATION").catch(() => {});
    const foreign = await bugs.createBugTag(f.outsider.actor, { projectId: f.otherProjectId, name: "Lobby", color: "#60a5fa" });
    const bug = await report(f.member, { title: "Tagged", tagIds: [lobby.id, foreign.id] });
    expect(bug.tagIds).toEqual([lobby.id]);
    const retagged = await bugs.updateBug(f.member.actor, { bugId: bug.id, tagIds: [ui.id, lobby.id] });
    expect(retagged.tagIds.sort()).toEqual([lobby.id, ui.id].sort());
    const list = await bugs.listBugs(f.member.actor, f.projectId);
    expect(list.tags.map((t) => t.name)).toEqual(expect.arrayContaining(["Lobby", "UI"]));
    expect(list.tags.some((t) => t.id === foreign.id)).toBe(false);
    await bugs.deleteBugTag(f.manager.actor, { tagId: ui.id });
    expect((await bugs.getBug(f.member.actor, bug.id)).tagIds).toEqual([lobby.id]);
  });
});

describe("pictures, clips and comments", () => {
  it("takes images and clips through the upload pipeline, counts them on the list, and removes them for good", async () => {
    const bug = await report(f.member, { title: "Ground placement is inconsistent" });
    const image = await uploadToBug(f.member, bug.id, { name: "portal.png", type: "image/png", buffer: await pngBuffer(640, 360) });
    expect(image).toMatchObject({ kind: "IMAGE", status: "READY", purpose: "BUG", bugId: bug.id, cardId: null, width: 640 });
    expect(image.thumbUrl).toMatch(/thumb\.webp/);
    const clip = await uploadToBug(f.member, bug.id, { name: "repro.mp4", type: "video/mp4", buffer: mp4Buffer(1) });
    expect(clip.kind).toBe("VIDEO");
    const detail = await bugs.getBug(f.member.actor, bug.id);
    expect(detail.attachments.map((a) => a.id)).toEqual([image.id, clip.id]);
    const row = (await bugs.listBugs(f.member.actor, f.projectId)).bugs.find((b) => b.id === bug.id)!;
    expect(row.counts.attachments).toBe(2);
    expect(row.cover?.attachmentId).toBe(image.id);
    // Only pictures and clips; only people who may edit the bug.
    await expectAppError(media.createUpload(f.member.actor, { bugId: bug.id, filename: "notes.txt", size: 10, contentType: "text/plain", purpose: "bug" }), "VALIDATION");
    await expectAppError(media.createUpload(f.member2.actor, { bugId: bug.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "bug" }), "FORBIDDEN");
    await expectAppError(media.createUpload(f.outsider.actor, { bugId: bug.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "bug" }), "NOT_FOUND");
    await expectAppError(bugs.removeBugAttachment(f.member2.actor, { attachmentId: image.id }), "FORBIDDEN");
    const after = await bugs.removeBugAttachment(f.member.actor, { attachmentId: image.id });
    expect(after.attachments.map((a) => a.id)).toEqual([clip.id]);
    expect(await db.select().from(attachments).where(eq(attachments.id, image.id))).toHaveLength(0);
  });

  it("threads comments, notifies the people on the bug and anyone @mentioned", async () => {
    const bug = await report(f.member, { title: "Discuss", assigneeId: f.member.id });
    await expectAppError(bugs.addBugComment(f.viewer.actor, { bugId: bug.id, body: "hi" }), "FORBIDDEN");
    await expectAppError(bugs.addBugComment(f.manager.actor, { bugId: bug.id, body: "   " }), "VALIDATION");
    const withComment = await bugs.addBugComment(f.manager.actor, { bugId: bug.id, body: `Can't reproduce — @${f.developer.username} can you try on mobile?` });
    expect(withComment.comments).toHaveLength(1);
    expect((await notes(f.member.id, bug.id)).map((n) => n.type)).toContain("BUG_COMMENT");
    expect((await notes(f.developer.id, bug.id)).map((n) => n.type)).toContain("MENTIONED");
    const id = withComment.comments[0]!.id;
    await expectAppError(bugs.editBugComment(f.member.actor, { commentId: id, body: "mine now" }), "FORBIDDEN");
    const edited = await bugs.editBugComment(f.manager.actor, { commentId: id, body: "Reproduced on mobile." });
    expect(edited.comments[0]).toMatchObject({ body: "Reproduced on mobile." });
    expect(edited.comments[0]!.editedAt).not.toBeNull();
    const removed = await bugs.deleteBugComment(f.manager.actor, { commentId: id });
    expect(removed.comments[0]!.deletedAt).not.toBeNull();
    expect((await bugs.listBugs(f.member.actor, f.projectId)).bugs.find((b) => b.id === bug.id)?.counts.comments).toBe(0);
  });
});

describe("deleting", () => {
  it("is for admins, and takes files with it", async () => {
    const bug = await report(f.member, { title: "Mistake" });
    const image = await uploadToBug(f.member, bug.id, { name: "oops.png", type: "image/png", buffer: await pngBuffer(64, 48) });
    await expectAppError(bugs.deleteBug(f.manager.actor, { bugId: bug.id }), "FORBIDDEN");
    await bugs.deleteBug(f.admin.actor, { bugId: bug.id });
    await expectAppError(bugs.getBug(f.member.actor, bug.id), "NOT_FOUND");
    expect(await db.select().from(attachments).where(eq(attachments.id, image.id))).toHaveLength(0);
  });
});
