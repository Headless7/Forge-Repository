/**
 * Images in descriptions: stored in Forge (never hotlinked), kept in step with the text, usable
 * as the cover, and falling back like any chosen cover when they go. Every fixture is created
 * here (test database only).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { descriptionImageIds, imageToken, looksLikeImageUrl, plainDescription } from "@/lib/description-images";
import { db } from "@/server/db";
import { attachments, deliverables as deliverablesTable } from "@/server/db/schema";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import * as deliverables from "./deliverables";
import * as media from "./media";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

const newCard = (title: string) => cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id] });
const png = async (name: string, color = "#7c6cf2") => ({ name, type: "image/png", buffer: await pngBuffer(96, 64, color) });
const descriptionImage = async (cardId: string, deliverableId: string | null, name: string, actor = f.manager.actor) => {
  const intent = await media.createUpload(actor, { cardId, filename: name, size: (await png(name)).buffer.length, contentType: "image/png", purpose: "description", deliverableId });
  const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
  const { storage } = await import("@/server/storage");
  await storage().put(row!.storageKey, (await png(name)).buffer, "image/png");
  return media.completeUpload(actor, { attachmentId: intent.attachmentId });
};
const deliverableRow = async (id: string) => (await db.select().from(deliverablesTable).where(eq(deliverablesTable.id, id)))[0]!;
const attachmentRow = async (id: string) => (await db.select().from(attachments).where(eq(attachments.id, id)))[0]!;

describe("description image markers", () => {
  it("find the images a text shows, and read as plain text elsewhere", () => {
    const a = "3f2a1b4c-1111-4222-8333-444455556666";
    const b = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000";
    const text = `Front:\n${imageToken("front view.png", a)}\nSide ${imageToken("side [2]", b)} and again ${imageToken("front", a)}`;
    expect(descriptionImageIds(text)).toEqual([a, b]);
    expect(plainDescription(text)).toBe("Front:\n[image]\nSide [image] and again [image]");
    expect(imageToken("side [2]", b)).toBe(`![side  2](image:${b})`);
    expect(looksLikeImageUrl("https://cdn.discordapp.com/attachments/1/2/shot.png?ex=6712&is=1&hm=abc")).toBe(true);
    expect(looksLikeImageUrl("https://media.discordapp.net/attachments/1/2/shot?format=webp&width=400")).toBe(true);
    expect(looksLikeImageUrl("https://example.com/page")).toBe(false);
    expect(looksLikeImageUrl("look at https://example.com/a.png")).toBe(false);
  });
});

describe("images in a deliverable's description", () => {
  it("are stored as its description images, and only card editors can add them", async () => {
    const card = await newCard("Description images");
    const d = await primaryDeliverable(card.id);
    const image = await descriptionImage(card.id, d, "ref.png");
    expect(image).toMatchObject({ purpose: "DESCRIPTION", deliverableId: d, kind: "IMAGE", versionId: null });
    await expectAppError(media.createUpload(f.viewer.actor, { cardId: card.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "description", deliverableId: d }), "FORBIDDEN");
    await expectAppError(media.createUpload(f.manager.actor, { cardId: card.id, filename: "x.mp4", size: 10, contentType: "video/mp4", purpose: "description", deliverableId: d }), "VALIDATION");
    const other = await newCard("Other");
    await expectAppError(media.createUpload(f.manager.actor, { cardId: card.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "description", deliverableId: await primaryDeliverable(other.id) }), "NOT_FOUND");
    await expectAppError(media.createUpload(f.outsider.actor, { cardId: card.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "description", deliverableId: d }), "NOT_FOUND");
    // Nothing becomes a revision or changes review state.
    const after = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(after.versions).toEqual([]);
    expect(after.deliverables[0]!.state).toBe("NOT_SUBMITTED");
  });

  it("can be the cover, which falls back to automatic when the image leaves the description and returns with it", async () => {
    const card = await newCard("Cover from description");
    const d = await primaryDeliverable(card.id);
    const version = await media.createVersion(f.member.actor, { deliverableId: d });
    const file = await upload(f.member.actor, card.id, await png("render.png", "#ff0000"), "version", version.id);
    const image = await descriptionImage(card.id, d, "concept.png");
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: d, description: `Match this:\n${imageToken("concept.png", image.id)}` });
    expect((await deliverableRow(d)).coverAttachmentId).toBe(file.id); // automatic: the current file

    await expectAppError(media.setDeliverableCover(f.viewer.actor, { deliverableId: d, attachmentId: image.id }), "FORBIDDEN");
    await media.setDeliverableCover(f.manager.actor, { deliverableId: d, attachmentId: image.id });
    expect(await deliverableRow(d)).toMatchObject({ coverMode: "MANUAL", coverPinnedId: image.id, coverAttachmentId: image.id });

    // Taken out of the description: archived, and the cover falls back to the automatic one.
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: d, description: "Match the concept (image removed)" });
    expect((await attachmentRow(image.id)).archivedAt).not.toBeNull();
    expect(await deliverableRow(d)).toMatchObject({ coverMode: "MANUAL", coverAttachmentId: file.id });
    let detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.attachments.some((a) => a.id === image.id)).toBe(false);

    // Put back (undo): shown again, and it's the cover again.
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: d, description: imageToken("concept.png", image.id) });
    expect((await attachmentRow(image.id)).archivedAt).toBeNull();
    expect((await deliverableRow(d)).coverAttachmentId).toBe(image.id);
    detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.deliverables[0]!.cover?.attachmentId).toBe(image.id);
  });

  it("are never borrowed by another deliverable or as the card's cover; the card's own description images can be", async () => {
    const card = await newCard("Borrowing");
    const first = await primaryDeliverable(card.id);
    const second = (await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Second" })).deliverables.find((x) => x.name === "Second")!.id;
    const image = await descriptionImage(card.id, first, "first.png");
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: first, description: imageToken("first.png", image.id) });
    await expectAppError(media.setDeliverableCover(f.manager.actor, { deliverableId: second, attachmentId: image.id }), "NOT_FOUND");
    await expectAppError(media.setCover(f.manager.actor, { cardId: card.id, attachmentId: image.id }), "NOT_FOUND");

    const cardImage = await descriptionImage(card.id, null, "card.png");
    await cardService.updateCard(f.manager.actor, { cardId: card.id, description: `Brief ${imageToken("card.png", cardImage.id)}` });
    await media.setCover(f.manager.actor, { cardId: card.id, attachmentId: cardImage.id });
    const detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.cover?.attachmentId).toBe(cardImage.id);
    // The card description's images are the card's: saving a deliverable's description leaves them alone.
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: first, description: "" });
    expect((await attachmentRow(cardImage.id)).archivedAt).toBeNull();
    expect((await attachmentRow(image.id)).archivedAt).not.toBeNull();
  });

  it("are copied with a duplicated card, and its text points at the copies", async () => {
    const card = await newCard("Duplicated description");
    const d = await primaryDeliverable(card.id);
    const image = await descriptionImage(card.id, d, "keep.png");
    const cardImage = await descriptionImage(card.id, null, "brief.png");
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: d, description: `See ${imageToken("keep.png", image.id)}` });
    await cardService.updateCard(f.manager.actor, { cardId: card.id, description: imageToken("brief.png", cardImage.id) });
    const copy = await cardService.duplicateCard(f.manager.actor, { cardId: card.id, include: { assignees: false, labels: false, checklists: false, attachments: false } });
    const detail = await cardService.getCardDetail(f.manager.actor, copy.id);
    const [copiedImage] = descriptionImageIds(detail.deliverables[0]!.description);
    const [copiedCardImage] = descriptionImageIds(detail.description);
    expect(copiedImage).toBeDefined();
    expect(copiedImage).not.toBe(image.id);
    expect(copiedCardImage).not.toBe(cardImage.id);
    expect(detail.attachments.find((a) => a.id === copiedImage)).toMatchObject({ purpose: "DESCRIPTION", deliverableId: detail.deliverables[0]!.id, filename: "keep.png" });
    expect(detail.attachments.find((a) => a.id === copiedCardImage)).toMatchObject({ purpose: "DESCRIPTION", deliverableId: null });
  });
});
