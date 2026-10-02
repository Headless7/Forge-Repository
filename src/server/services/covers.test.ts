import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { attachments, cards } from "@/server/db/schema";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import * as media from "./media";
import * as reviews from "./reviews";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

const newCard = (title: string) => cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id] });
const png = async (name: string, color: string) => ({ name, type: "image/png", buffer: await pngBuffer(320, 180, color) });
const cardRow = async (id: string) => (await db.select().from(cards).where(eq(cards.id, id)))[0]!;
const uploadRevision = async (cardId: string, name: string, color: string) => {
  const version = await media.createVersion(f.member.actor, { cardId });
  return upload(f.member.actor, cardId, await png(name, color), "version", version.id);
};

describe("card covers", () => {
  it("keeps a chosen cover through new revisions, submission, approval and re-derivation", async () => {
    const card = await newCard("Chosen cover");
    const v1 = await uploadRevision(card.id, "v1.png", "#ff0000");
    expect((await cardRow(card.id)).coverAttachmentId).toBe(v1.id); // automatic: the current revision
    const reference = await upload(f.member.actor, card.id, await png("key-art.png", "#00ff00"), "attachment");

    await media.setCover(f.manager.actor, { cardId: card.id, attachmentId: reference.id });
    expect(await cardRow(card.id)).toMatchObject({ coverMode: "MANUAL", coverPinnedId: reference.id, coverAttachmentId: reference.id });

    // A newer revision would have replaced an automatic cover; the chosen one stays.
    await uploadRevision(card.id, "v2.png", "#0000ff");
    const deliverableId = await primaryDeliverable(card.id);
    await reviews.submitForReview(f.member.actor, { deliverableId });
    await reviews.approve(f.manager.actor, { deliverableId });
    const after = await cardRow(card.id);
    expect(after.state).toBe("APPROVED");
    expect(after.coverAttachmentId).toBe(reference.id);
    const summary = (await cardService.getCardDetail(f.member.actor, card.id));
    expect(summary.coverMode).toBe("MANUAL");
    expect(summary.cover?.attachmentId).toBe(reference.id);
  });

  it("uploads a cover without creating a revision or changing review status", async () => {
    const card = await newCard("Cover upload");
    await uploadRevision(card.id, "v1.png", "#123456");
    const before = await cardService.getCardDetail(f.manager.actor, card.id);
    const cover = await upload(f.manager.actor, card.id, await png("cover.png", "#abcdef"), "cover");
    const after = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(cover.purpose).toBe("COVER");
    expect(after.versions).toHaveLength(before.versions.length);
    expect(after.state).toBe(before.state);
    expect(after.deliverables.map((d) => d.state)).toEqual(before.deliverables.map((d) => d.state));
    expect(after.cover?.attachmentId).toBe(cover.id);
    // Cover uploads aren't reference files.
    expect(after.attachments.find((a) => a.id === cover.id)?.purpose).toBe("COVER");

    // Replacing it retires the old cover upload (archived, not deleted).
    const replacement = await upload(f.manager.actor, card.id, await png("cover-2.png", "#fedcba"), "cover");
    const [old] = await db.select().from(attachments).where(eq(attachments.id, cover.id));
    expect(old!.archivedAt).not.toBeNull();
    expect((await cardRow(card.id)).coverAttachmentId).toBe(replacement.id);
  });

  it("goes back to automatic, or shows no cover, on request", async () => {
    const card = await newCard("Modes");
    const v1 = await uploadRevision(card.id, "v1.png", "#111111");
    await upload(f.manager.actor, card.id, await png("cover.png", "#222222"), "cover");
    await media.setCoverMode(f.manager.actor, { cardId: card.id, mode: "NONE" });
    expect(await cardRow(card.id)).toMatchObject({ coverMode: "NONE", coverAttachmentId: null, coverPinnedId: null });
    await uploadRevision(card.id, "v2.png", "#333333");
    expect((await cardRow(card.id)).coverAttachmentId).toBeNull(); // still none after a new revision
    await media.setCoverMode(f.manager.actor, { cardId: card.id, mode: "AUTO" });
    const auto = await cardRow(card.id);
    expect(auto.coverMode).toBe("AUTO");
    expect(auto.coverAttachmentId).not.toBe(v1.id); // the current (V2) revision's file
    expect(auto.coverAttachmentId).not.toBeNull();
  });

  it("falls back to the automatic cover when the chosen file is removed", async () => {
    const card = await newCard("Removed cover");
    const v1 = await uploadRevision(card.id, "v1.png", "#444444");
    const reference = await upload(f.member.actor, card.id, await png("ref.png", "#555555"), "attachment");
    await media.setCover(f.manager.actor, { cardId: card.id, attachmentId: reference.id });
    await media.archiveAttachment(f.manager.actor, { attachmentId: reference.id });
    const row = await cardRow(card.id);
    expect(row.coverMode).toBe("MANUAL");
    expect(row.coverAttachmentId).toBe(v1.id);
  });

  it("enforces permissions and refuses foreign or unsuitable files", async () => {
    const card = await newCard("Guarded");
    const other = await newCard("Someone else's");
    const mine = await upload(f.member.actor, card.id, await png("mine.png", "#666666"), "attachment");
    const theirs = await upload(f.member.actor, other.id, await png("theirs.png", "#777777"), "attachment");
    const doc = await upload(f.member.actor, card.id, { name: "notes.txt", type: "text/plain", buffer: Buffer.from("plain notes") }, "attachment");

    await expectAppError(media.setCover(f.viewer.actor, { cardId: card.id, attachmentId: mine.id }), "FORBIDDEN");
    await expectAppError(media.setCover(f.outsider.actor, { cardId: card.id, attachmentId: mine.id }), "NOT_FOUND");
    await expectAppError(media.setCoverMode(f.viewer.actor, { cardId: card.id, mode: "NONE" }), "FORBIDDEN");
    // A file from another card can't be borrowed, even by someone who can see both.
    await expectAppError(media.setCover(f.manager.actor, { cardId: card.id, attachmentId: theirs.id }), "NOT_FOUND");
    await expectAppError(media.setCover(f.manager.actor, { cardId: card.id, attachmentId: doc.id }), "VALIDATION");
    // Cover uploads: editors only, images and videos only.
    await expectAppError(media.createUpload(f.viewer.actor, { cardId: card.id, filename: "c.png", size: 10, contentType: "image/png", purpose: "cover" }), "FORBIDDEN");
    await expectAppError(media.createUpload(f.manager.actor, { cardId: card.id, filename: "c.mp3", size: 10, contentType: "audio/mpeg", purpose: "cover" }), "VALIDATION");
    expect((await cardRow(card.id)).coverMode).toBe("AUTO");
  });
});
