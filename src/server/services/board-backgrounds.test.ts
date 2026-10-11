/**
 * A board's own background (a preset, the project's default, or an uploaded image) and deliverable
 * colours. Every fixture is created here (test database only).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { boards, storageDeletions } from "@/server/db/schema";
import { storage } from "@/server/storage";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, type Fixture } from "@/test/helpers";
import * as board from "./board";
import * as cardService from "./cards";
import * as deliverables from "./deliverables";
import { purge } from "./purge";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

const row = async (boardId: string) => (await db.select().from(boards).where(eq(boards.id, boardId)))[0]!;
const exists = async (key: string) => Boolean(await storage().stat(key));

describe("board backgrounds", () => {
  it("use the project's until a board picks a preset; an image wins and replaces the earlier one", async () => {
    const b = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: `Backgrounds ${Date.now()}` });
    let dto = await board.getBoard(f.manager.actor, f.projectId, b.id);
    expect(dto.background).toEqual({ preset: null, imageUrl: null });

    await board.setBoardBackground(f.manager.actor, { boardId: b.id, background: "aurora" });
    expect((await board.getBoard(f.member.actor, f.projectId, b.id)).background).toEqual({ preset: "aurora", imageUrl: null });

    const first = await board.setBoardBackgroundImage(f.manager.actor, b.id, await pngBuffer(1200, 600, "#335577"));
    const firstKey = (await row(b.id)).backgroundImageKey!;
    expect(firstKey).toMatch(/\/boards\/.+\/background-.+\.webp$/);
    expect(await exists(firstKey)).toBe(true);
    expect(first.imageUrl).toBeTruthy();
    dto = await board.getBoard(f.member.actor, f.projectId, b.id);
    expect(dto.background.preset).toBe("aurora");
    expect(dto.background.imageUrl).toBeTruthy();

    // A new image replaces (and deletes) the old one.
    await board.setBoardBackgroundImage(f.manager.actor, b.id, await pngBuffer(800, 400, "#775533"));
    const secondKey = (await row(b.id)).backgroundImageKey!;
    expect(secondKey).not.toBe(firstKey);
    expect(await exists(firstKey)).toBe(false);

    // Choosing a preset (or the project's) removes the image.
    await board.setBoardBackground(f.manager.actor, { boardId: b.id, background: null });
    expect(await row(b.id)).toMatchObject({ background: null, backgroundImageKey: null });
    expect(await exists(secondKey)).toBe(false);
  });

  it("are for people who manage boards, on active boards, with real images and known presets", async () => {
    const b = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: `Rules ${Date.now()}` });
    await expectAppError(board.setBoardBackground(f.member.actor, { boardId: b.id, background: "sunset" }), "FORBIDDEN");
    await expectAppError(board.setBoardBackgroundImage(f.member.actor, b.id, await pngBuffer(10, 10, "#000000")), "FORBIDDEN");
    await expectAppError(board.setBoardBackground(f.outsider.actor, { boardId: b.id, background: "sunset" }), "NOT_FOUND");
    await expectAppError(board.setBoardBackground(f.manager.actor, { boardId: b.id, background: "not-a-preset" }), "VALIDATION");
    await expectAppError(board.setBoardBackgroundImage(f.manager.actor, b.id, Buffer.from("not an image at all")), "VALIDATION");
    await board.setBoardArchived(f.manager.actor, { boardId: b.id, archived: true });
    await expectAppError(board.setBoardBackground(f.manager.actor, { boardId: b.id, background: "sunset" }), "VALIDATION");
  });

  it("delete the image file when the board is deleted permanently", async () => {
    const b = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: `Doomed ${Date.now()}` });
    await board.setBoardBackgroundImage(f.manager.actor, b.id, await pngBuffer(400, 200, "#123456"));
    const key = (await row(b.id)).backgroundImageKey!;
    await board.setBoardArchived(f.manager.actor, { boardId: b.id, archived: true });
    const result = await purge(f.owner.actor, { targets: [{ type: "board", id: b.id }] });
    expect(result.results[0]).toMatchObject({ status: "deleted" });
    expect((await db.select().from(storageDeletions).where(eq(storageDeletions.prefix, key))).length).toBe(1);
  });
});

describe("deliverable colours", () => {
  it("come from the palette, can be cleared, and are kept when a card is duplicated", async () => {
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: `Colours ${Date.now()}` });
    const d = await primaryDeliverable(card.id);
    let detail = await deliverables.updateDeliverable(f.manager.actor, { deliverableId: d, color: "#f87171" });
    expect(detail.deliverables.find((x) => x.id === d)!.color).toBe("#f87171");
    await expectAppError(deliverables.updateDeliverable(f.manager.actor, { deliverableId: d, color: "#123456" }), "VALIDATION");
    await expectAppError(deliverables.updateDeliverable(f.viewer.actor, { deliverableId: d, color: "#60a5fa" }), "FORBIDDEN");

    const copy = await cardService.duplicateCard(f.manager.actor, { cardId: card.id, include: { assignees: false, labels: false, checklists: false, attachments: false } });
    const copied = await cardService.getCardDetail(f.manager.actor, copy.id);
    expect(copied.deliverables[0]!.color).toBe("#f87171");

    detail = await deliverables.updateDeliverable(f.manager.actor, { deliverableId: d, color: null });
    expect(detail.deliverables.find((x) => x.id === d)!.color).toBeNull();
  });
});
