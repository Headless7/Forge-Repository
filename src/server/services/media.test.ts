import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { attachments, cards } from "@/server/db/schema";
import { storage } from "@/server/storage";
import { expectAppError, mp4Buffer, pngBuffer, setupStudio, upload, type Fixture, primaryDeliverable } from "@/test/helpers";
import * as cardService from "./cards";
import * as media from "./media";
import * as reviews from "./reviews";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

const newCard = (title: string) => cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id] });

describe("uploading versions", () => {
  it("verifies an image, extracts metadata, writes a thumbnail and sets the board cover", async () => {
    const card = await newCard("Screenshot");
    const version = await media.createVersion(f.member.actor, { cardId: card.id, notes: "v1" });
    const attachment = await upload(f.member.actor, card.id, { name: "UI.png", type: "image/png", buffer: await pngBuffer(640, 360) }, "version", version.id);
    expect(attachment).toMatchObject({ kind: "IMAGE", status: "READY", width: 640, height: 360, mimeType: "image/png", versionId: version.id });
    expect(attachment.thumbUrl).toMatch(/^\/api\/files\/.+thumb\.webp\?exp=\d+&sig=/);
    const [row] = await db.select().from(attachments).where(eq(attachments.id, attachment.id));
    expect(await storage().stat(row!.thumbnailKey!)).not.toBeNull();
    const [cardRow] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(cardRow?.coverAttachmentId).toBe(attachment.id);
    expect(cardRow?.state).toBe("IN_PROGRESS");
  });

  it("probes video duration and dimensions", async () => {
    const card = await newCard("Clip");
    const version = await media.createVersion(f.member.actor, { cardId: card.id });
    const video = await upload(f.member.actor, card.id, { name: "gojo_v1.mp4", type: "video/mp4", buffer: mp4Buffer(2) }, "version", version.id);
    expect(video.kind).toBe("VIDEO");
    expect(video.width).toBe(320);
    expect(video.height).toBe(180);
    expect(video.durationMs).toBeGreaterThanOrEqual(1900);
    expect(video.thumbUrl).not.toBeNull();
  });

  it("rejects content that doesn't match its type (HTML disguised as PNG)", async () => {
    const card = await newCard("Disguised");
    const html = Buffer.from("<!doctype html><script>alert(1)</script>".padEnd(400, " "));
    await expectAppError(upload(f.member.actor, card.id, { name: "innocent.png", type: "image/png", buffer: html }), "VALIDATION");
    const [row] = await db.select().from(attachments).where(eq(attachments.cardId, card.id));
    expect(row?.status).toBe("FAILED");
  });

  it("blocks executables and enforces size limits before upload", async () => {
    const card = await newCard("Blocked");
    await expectAppError(media.createUpload(f.member.actor, { cardId: card.id, filename: "tool.exe", size: 100, contentType: "application/octet-stream", purpose: "attachment" }), "VALIDATION");
    await expectAppError(
      media.createUpload(f.member.actor, { cardId: card.id, filename: "huge.png", size: 10 * 1024 ** 3, contentType: "image/png", purpose: "attachment" }),
      "PAYLOAD_TOO_LARGE",
    );
    await expectAppError(media.createUpload(f.viewer.actor, { cardId: card.id, filename: "a.png", size: 10, contentType: "image/png", purpose: "attachment" }), "FORBIDDEN");
    // Roblox model files are fine as reference attachments.
    // A file named .rbxm that isn't a Roblox file is rejected rather than stored as something it isn't.
    await expectAppError(upload(f.member.actor, card.id, { name: "Sukuna.rbxm", type: "application/octet-stream", buffer: Buffer.from("<roblox!".padEnd(64, "x")) }), "VALIDATION");
  });

  it("numbers versions, supersedes pending submissions and never deletes old versions", async () => {
    const card = await newCard("Iterations");
    const v1 = await media.createVersion(f.member.actor, { cardId: card.id });
    await upload(f.member.actor, card.id, { name: "a.png", type: "image/png", buffer: await pngBuffer() }, "version", v1.id);
    await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id) });
    const v2 = await media.createVersion(f.member.actor, { cardId: card.id });
    expect(v2.number).toBe(2);
    const detail = await cardService.getCardDetail(f.member.actor, card.id);
    expect(detail.versions.map((v) => [v.number, v.status])).toEqual([
      [1, "DRAFT"],
      [2, "DRAFT"],
    ]);
    expect(detail.state).toBe("IN_PROGRESS");
    expect(detail.reviews.at(-1)).toMatchObject({ action: "WITHDRAWN", note: "Superseded by V2" });
    expect(detail.attachments.filter((a) => a.versionId === v1.id)).toHaveLength(1);
    // Media on a submitted version is part of history and can't be removed.
    await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id), versionId: v1.id });
    const v1Media = detail.attachments.find((a) => a.versionId === v1.id)!;
    await expectAppError(media.archiveAttachment(f.member.actor, { attachmentId: v1Media.id }), "CONFLICT");
  });

  it("only the uploader can complete an upload, and only once", async () => {
    const card = await newCard("Ownership");
    const intent = await media.createUpload(f.member.actor, { cardId: card.id, filename: "x.png", size: 100, contentType: "image/png", purpose: "attachment" });
    await expectAppError(media.completeUpload(f.manager.actor, { attachmentId: intent.attachmentId }), "FORBIDDEN");
    await expectAppError(media.completeUpload(f.member.actor, { attachmentId: intent.attachmentId }), "VALIDATION");
  });
});

describe("demonstration clips", () => {
  it("go with a Roblox file in its revision, stay out of the file list and covers, and can be swapped after review", async () => {
    const { R, writeBinaryModel } = await import("@/server/roblox/writer");
    const card = await newCard("Shop UI");
    const version = await media.createVersion(f.member.actor, { cardId: card.id, notes: "v1" });
    const ui = writeBinaryModel([
      { className: "ScreenGui", props: { Name: R.str("Shop") }, children: [{ className: "Frame", props: { Name: R.str("Panel"), Size: R.udim2(0, 400, 0, 300) } }] },
    ]);
    const roblox = await upload(f.member.actor, card.id, { name: "shop.rbxm", type: "application/octet-stream", buffer: Buffer.from(ui) }, "version", version.id);
    expect(roblox.kind).toBe("ROBLOX");
    // Only videos, only for Roblox files, only by people who may upload to the deliverable.
    await expectAppError(media.createUpload(f.member.actor, { cardId: card.id, filename: "demo.png", size: 10, contentType: "image/png", purpose: "demo", demoOfId: roblox.id }), "VALIDATION");
    await expectAppError(media.createUpload(f.member.actor, { cardId: card.id, filename: "demo.mp4", size: 10, contentType: "video/mp4", purpose: "demo" }), "VALIDATION");
    await expectAppError(media.createUpload(f.viewer.actor, { cardId: card.id, filename: "demo.mp4", size: 10, contentType: "video/mp4", purpose: "demo", demoOfId: roblox.id }), "FORBIDDEN");
    const intent = await media.createUpload(f.member.actor, { cardId: card.id, filename: "demo.mp4", size: mp4Buffer(1).length, contentType: "video/mp4", purpose: "demo", demoOfId: roblox.id });
    const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
    await storage().put(row!.storageKey, mp4Buffer(1), "video/mp4");
    const demo = await media.completeUpload(f.member.actor, { attachmentId: intent.attachmentId });
    expect(demo).toMatchObject({ kind: "VIDEO", purpose: "VERSION", versionId: version.id, demoOfId: roblox.id });
    await expectAppError(media.createUpload(f.member.actor, { cardId: card.id, filename: "demo2.mp4", size: 10, contentType: "video/mp4", purpose: "demo", demoOfId: demo.id }), "VALIDATION");
    const detail = await cardService.getCardDetail(f.member.actor, card.id);
    const v1 = detail.versions.find((v) => v.id === version.id)!;
    expect(v1.attachmentIds).toEqual(expect.arrayContaining([roblox.id, demo.id]));
    expect(detail.attachments.find((a) => a.id === demo.id)?.demoOfId).toBe(roblox.id);
    const [cardRow] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(cardRow?.coverAttachmentId).not.toBe(demo.id);
    // Submitted work keeps its files, but the clip can still be replaced.
    await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id) });
    await expectAppError(media.archiveAttachment(f.member.actor, { attachmentId: roblox.id }), "CONFLICT");
    await media.archiveAttachment(f.member.actor, { attachmentId: demo.id });
    expect((await cardService.getCardDetail(f.member.actor, card.id)).attachments.some((a) => a.id === demo.id)).toBe(false);
  });
});
