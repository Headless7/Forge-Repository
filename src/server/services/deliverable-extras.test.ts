/**
 * Adding a deliverable that requires several others, and deliverable covers (automatic, chosen —
 * uploaded or picked from its files — or none). Every fixture is created here (test database only).
 */
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { activityEvents, attachments, cards, deliverables as deliverablesTable } from "@/server/db/schema";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import * as deliverables from "./deliverables";
import * as media from "./media";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

const newCard = (title: string) => cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id] });
const png = async (name: string, color: string) => ({ name, type: "image/png", buffer: await pngBuffer(320, 180, color) });
const byName = async (cardId: string, name: string) => (await cardService.getCardDetail(f.manager.actor, cardId)).deliverables.find((d) => d.name === name)!;
const row = async (deliverableId: string) => (await db.select().from(deliverablesTable).where(eq(deliverablesTable.id, deliverableId)))[0]!;
const revision = async (cardId: string, deliverableId: string, name: string, color: string) => {
  const version = await media.createVersion(f.member.actor, { deliverableId });
  return upload(f.member.actor, cardId, await png(name, color), "version", version.id);
};

describe("adding a deliverable that requires others", () => {
  it("links every chosen prerequisite to the new deliverable", async () => {
    const card = await newCard("Requires several");
    await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Model" });
    await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Rig" });
    const model = await byName(card.id, "Model");
    const rig = await byName(card.id, "Rig");
    const detail = await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Animation", requires: [model.id, rig.id, model.id] });
    const anim = detail.deliverables.find((d) => d.name === "Animation")!;
    const links = detail.deliverableLinks.filter((l) => l.toId === anim.id);
    expect(links.map((l) => [l.fromId, l.type]).sort()).toEqual([[model.id, "DEPENDENCY"], [rig.id, "DEPENDENCY"]].sort());
    expect(anim.blockedBy.sort()).toEqual([model.id, rig.id].sort());

    // "Add a deliverable that requires this" (linkFrom) and the same pick in requires: one link.
    const detail2 = await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "VFX", requires: [rig.id], linkFrom: { id: rig.id, type: "DEPENDENCY" } });
    const vfx = detail2.deliverables.find((d) => d.name === "VFX")!;
    expect(detail2.deliverableLinks.filter((l) => l.toId === vfx.id)).toHaveLength(1);
  });

  it("only links active deliverables of the same card, for people who can edit it", async () => {
    const card = await newCard("Requires rules");
    await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Old" });
    const old = await byName(card.id, "Old");
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: old.id, archived: true });
    await expectAppError(deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "New", requires: [old.id] }), "CONFLICT");
    const other = await newCard("Another card");
    const foreign = await primaryDeliverable(other.id);
    await expectAppError(deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "New", requires: [foreign] }), "NOT_FOUND");
    const primary = await primaryDeliverable(card.id);
    await expectAppError(deliverables.createDeliverable(f.viewer.actor, { cardId: card.id, name: "New", requires: [primary] }), "FORBIDDEN");
    // Nothing was half-created.
    expect((await cardService.getCardDetail(f.manager.actor, card.id)).deliverables.some((d) => d.name === "New")).toBe(false);
  });
});

describe("deliverable covers", () => {
  it("follow the current file until someone chooses one; a chosen cover survives new revisions", async () => {
    const card = await newCard("Deliverable covers");
    const d = await primaryDeliverable(card.id);
    const v1 = await revision(card.id, d, "v1.png", "#ff0000");
    expect(await row(d)).toMatchObject({ coverMode: "AUTO", coverAttachmentId: v1.id });

    // Uploaded just for the cover: pinned, no revision, no review change.
    const before = await cardService.getCardDetail(f.manager.actor, card.id);
    const cover = await upload(f.manager.actor, card.id, await png("key-art.png", "#00ff00"), "cover", undefined, d);
    expect(cover).toMatchObject({ purpose: "COVER", deliverableId: d });
    expect(await row(d)).toMatchObject({ coverMode: "MANUAL", coverPinnedId: cover.id, coverAttachmentId: cover.id });
    const after = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(after.versions).toHaveLength(before.versions.length);
    expect(after.deliverables.find((x) => x.id === d)).toMatchObject({ state: before.deliverables.find((x) => x.id === d)!.state, coverMode: "MANUAL", coverPinnedId: cover.id });
    // The card's automatic cover follows its first deliverable's cover.
    expect((await db.select().from(cards).where(eq(cards.id, card.id)))[0]!.coverAttachmentId).toBe(cover.id);

    await revision(card.id, d, "v2.png", "#0000ff");
    expect((await row(d)).coverAttachmentId).toBe(cover.id);

    // Picking one of its files instead retires the cover upload (archived, not deleted).
    await media.setDeliverableCover(f.manager.actor, { deliverableId: d, attachmentId: v1.id });
    expect(await row(d)).toMatchObject({ coverMode: "MANUAL", coverPinnedId: v1.id, coverAttachmentId: v1.id });
    expect((await db.select().from(attachments).where(eq(attachments.id, cover.id)))[0]!.archivedAt).not.toBeNull();

    await media.setDeliverableCoverMode(f.manager.actor, { deliverableId: d, mode: "NONE" });
    expect(await row(d)).toMatchObject({ coverMode: "NONE", coverPinnedId: null, coverAttachmentId: null });
    await media.setDeliverableCoverMode(f.manager.actor, { deliverableId: d, mode: "AUTO" });
    const auto = await row(d);
    expect(auto.coverMode).toBe("AUTO");
    expect(auto.coverAttachmentId).not.toBeNull();

    const log = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.cardId, card.id), eq(activityEvents.type, "deliverable.cover_changed")))
      .orderBy(asc(activityEvents.createdAt));
    expect(log.map((e) => (e.data as { mode: string }).mode)).toEqual(["MANUAL", "MANUAL", "NONE", "AUTO"]);
  });

  it("only use the deliverable's own images, for people who can edit the card", async () => {
    const card = await newCard("Cover rules");
    const d = await primaryDeliverable(card.id);
    const own = await revision(card.id, d, "own.png", "#111111");
    await expectAppError(media.setDeliverableCover(f.member2.actor, { deliverableId: d, attachmentId: own.id }), "FORBIDDEN");
    await expectAppError(upload(f.viewer.actor, card.id, await png("x.png", "#222222"), "cover", undefined, d), "FORBIDDEN");

    // Another card's file, and the card's own cover upload, aren't this deliverable's.
    const other = await newCard("Other card");
    const foreign = await revision(other.id, await primaryDeliverable(other.id), "foreign.png", "#333333");
    await expectAppError(media.setDeliverableCover(f.manager.actor, { deliverableId: d, attachmentId: foreign.id }), "NOT_FOUND");
    const cardCover = await upload(f.manager.actor, card.id, await png("card-cover.png", "#444444"), "cover");
    await expectAppError(media.setDeliverableCover(f.manager.actor, { deliverableId: d, attachmentId: cardCover.id }), "NOT_FOUND");

    // And a deliverable's cover upload isn't the card's to pick; changing the card's cover leaves it alone.
    const dCover = await upload(f.manager.actor, card.id, await png("d-cover.png", "#555555"), "cover", undefined, d);
    await expectAppError(media.setCover(f.manager.actor, { cardId: card.id, attachmentId: dCover.id }), "NOT_FOUND");
    await media.setCoverMode(f.manager.actor, { cardId: card.id, mode: "NONE" });
    expect((await db.select().from(attachments).where(eq(attachments.id, dCover.id)))[0]!.archivedAt).toBeNull();
    expect((await row(d)).coverAttachmentId).toBe(dCover.id);

    // Archived deliverables keep their cover as it is.
    await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Second" });
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: d, archived: true });
    await expectAppError(media.setDeliverableCoverMode(f.manager.actor, { deliverableId: d, mode: "NONE" }), "CONFLICT");
    await expectAppError(upload(f.manager.actor, card.id, await png("late.png", "#666666"), "cover", undefined, d), "CONFLICT");
  });
});

