/**
 * A deliverable's files: adding to and removing from the revision being prepared, never from
 * submitted (or older) revisions, and what removing does to covers, "has files", readiness,
 * history and the archive. Every fixture is created here (test database only).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { activityEvents, attachments, deliverables as deliverablesTable } from "@/server/db/schema";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import * as deliverables from "./deliverables";
import * as media from "./media";
import * as reviews from "./reviews";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

const newCard = (title: string) => cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id] });
const png = async (name: string, color = "#7c6cf2") => ({ name, type: "image/png", buffer: await pngBuffer(96, 64, color) });
const add = async (actor: typeof f.member.actor, cardId: string, versionId: string, name: string, color?: string, addedToRevision = false) => {
  const file = await png(name, color);
  const intent = await media.createUpload(actor, { cardId, filename: name, size: file.buffer.length, contentType: "image/png", purpose: "version", versionId });
  const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
  const { storage } = await import("@/server/storage");
  await storage().put(row!.storageKey, file.buffer, "image/png");
  return media.completeUpload(actor, { attachmentId: intent.attachmentId, addedToRevision });
};
const detail = (cardId: string) => cardService.getCardDetail(f.manager.actor, cardId);
const history = async (cardId: string) => (await db.select().from(activityEvents).where(eq(activityEvents.cardId, cardId))).map((e) => ({ type: e.type, data: e.data }));
const deliverableRow = async (id: string) => (await db.select().from(deliverablesTable).where(eq(deliverablesTable.id, id)))[0]!;

describe("the revision being prepared", () => {
  it("takes more files and gives them up again, with history, covers and 'has files' following", async () => {
    const card = await newCard("Prepared revision");
    const d = await primaryDeliverable(card.id);
    const v1 = await media.createVersion(f.member.actor, { deliverableId: d });
    const front = await add(f.member.actor, card.id, v1.id, "front.png", "#ff0000");
    const side = await add(f.member.actor, card.id, v1.id, "side.png", "#00ff00", true);
    let now = await detail(card.id);
    expect(now.versions[0]!.attachmentIds).toEqual([front.id, side.id]);
    expect(await history(card.id)).toContainEqual({ type: "version.file_added", data: expect.objectContaining({ versionNumber: 1, filename: "side.png" }) });
    expect((await deliverableRow(d)).coverAttachmentId).toBe(front.id);

    // Removing the cover file: the automatic cover moves to the next file.
    await media.archiveAttachment(f.member.actor, { attachmentId: front.id });
    now = await detail(card.id);
    expect(now.versions[0]!.attachmentIds).toEqual([side.id]);
    expect(now.removedFiles).toEqual([expect.objectContaining({ id: front.id, filename: "front.png", versionId: v1.id, deliverableId: d })]);
    expect((await deliverableRow(d)).coverAttachmentId).toBe(side.id);
    expect(await history(card.id)).toContainEqual({ type: "attachment.removed", data: expect.objectContaining({ filename: "front.png", versionNumber: 1 }) });

    // Removing the last one: no files, no cover, nothing to submit.
    await media.archiveAttachment(f.member.actor, { attachmentId: side.id });
    now = await detail(card.id);
    expect(now.deliverables[0]!.hasFiles).toBe(false);
    expect(now.progress.withFiles).toBe(0);
    expect(now.cover).toBeNull();
    await expectAppError(reviews.submitForReview(f.member.actor, { deliverableId: d }), "VALIDATION");

    // Putting one back (undo, or from Archived items) restores it, and its cover.
    await media.restoreAttachment(f.member.actor, { attachmentId: side.id });
    now = await detail(card.id);
    expect(now.versions[0]!.attachmentIds).toEqual([side.id]);
    expect(now.deliverables[0]!.hasFiles).toBe(true);
    expect((await deliverableRow(d)).coverAttachmentId).toBe(side.id);
    expect(await history(card.id)).toContainEqual({ type: "attachment.restored", data: expect.objectContaining({ filename: "side.png" }) });
    await reviews.submitForReview(f.member.actor, { deliverableId: d });
  });

  it("is managed by the people who can upload to the deliverable, and no one else", async () => {
    const card = await newCard("Who manages files");
    const d = await primaryDeliverable(card.id);
    const second = (await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Rig", ownerId: f.member2.id })).deliverables.find((x) => x.name === "Rig")!.id;
    const v = await media.createVersion(f.member2.actor, { deliverableId: second });
    const file = await add(f.member2.actor, card.id, v.id, "rig.png");
    // Its responsible person can add and remove; viewers, outsiders and people not on it can't.
    await add(f.member2.actor, card.id, v.id, "rig-2.png", undefined, true);
    await expectAppError(media.archiveAttachment(f.viewer.actor, { attachmentId: file.id }), "FORBIDDEN");
    await expectAppError(media.archiveAttachment(f.developer.actor, { attachmentId: file.id }), "FORBIDDEN");
    await expectAppError(media.archiveAttachment(f.outsider.actor, { attachmentId: file.id }), "NOT_FOUND");
    await expectAppError(media.createUpload(f.viewer.actor, { cardId: card.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "version", versionId: v.id }), "FORBIDDEN");
    await media.archiveAttachment(f.member2.actor, { attachmentId: file.id });
    // Card editors can too.
    await media.restoreAttachment(f.manager.actor, { attachmentId: file.id });
    expect(d).not.toBe(second);
  });
});

describe("submitted and earlier revisions", () => {
  it("keep their files exactly as reviewed and explain what to do instead", async () => {
    const card = await newCard("Review history");
    const d = await primaryDeliverable(card.id);
    const v1 = await media.createVersion(f.member.actor, { deliverableId: d });
    const shot = await add(f.member.actor, card.id, v1.id, "v1.png");
    const doc = await upload(f.member.actor, card.id, { name: "notes.txt", type: "text/plain", buffer: Buffer.from("notes") }, "version", v1.id);
    await reviews.submitForReview(f.member.actor, { deliverableId: d });
    // Waiting for review: no adding, no removing (generic files included).
    await expect(media.createUpload(f.member.actor, { cardId: card.id, filename: "late.png", size: 10, contentType: "image/png", purpose: "version", versionId: v1.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Upload a new revision instead"),
    });
    await expectAppError(media.archiveAttachment(f.member.actor, { attachmentId: shot.id }), "CONFLICT");
    await expectAppError(media.archiveAttachment(f.member.actor, { attachmentId: doc.id }), "CONFLICT");
    // Withdrawn, it's being prepared again.
    await reviews.withdrawSubmission(f.member.actor, { deliverableId: d });
    await media.archiveAttachment(f.member.actor, { attachmentId: doc.id });
    await reviews.submitForReview(f.member.actor, { deliverableId: d });
    await reviews.requestChanges(f.manager.actor, { deliverableId: d, items: ["Brighter"] });
    await expectAppError(media.archiveAttachment(f.member.actor, { attachmentId: shot.id }), "CONFLICT");
    await expectAppError(media.restoreAttachment(f.member.actor, { attachmentId: doc.id }), "CONFLICT");
    // A new revision takes new files; the older one stays closed even though it's no longer current.
    const v2 = await media.createVersion(f.member.actor, { deliverableId: d });
    await add(f.member.actor, card.id, v2.id, "v2.png");
    await expect(media.createUpload(f.member.actor, { cardId: card.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "version", versionId: v1.id })).rejects.toMatchObject({ code: "CONFLICT" });
    const now = await detail(card.id);
    expect(now.versions.find((v) => v.id === v1.id)!.attachmentIds).toEqual([shot.id]);
  });

  it("keeps superseded revisions closed too", async () => {
    const card = await newCard("Superseded");
    const d = await primaryDeliverable(card.id);
    const v1 = await media.createVersion(f.member.actor, { deliverableId: d });
    const first = await add(f.member.actor, card.id, v1.id, "a.png");
    await reviews.submitForReview(f.member.actor, { deliverableId: d });
    // A new upload supersedes the pending submission (V1 goes back to draft, but it's history now).
    await media.createVersion(f.member.actor, { deliverableId: d });
    await expect(media.archiveAttachment(f.member.actor, { attachmentId: first.id })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("earlier revision") });
  });
});
