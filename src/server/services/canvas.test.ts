/**
 * Deliverable canvas: node sizes, connection points (stable, remapped on shrink without changing
 * meaning), concurrent layout edits, and descriptions — with permissions and read-only rules.
 * Every fixture is created here (test database only).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { availablePoints, clampSize, NODE_DEFAULT, NODE_MIN, pointLabel, pointsAlong, remapPoint } from "@/lib/canvas-points";
import { db } from "@/server/db";
import { deliverableLinks, deliverables as deliverablesTable } from "@/server/db/schema";
import { expectAppError, primaryDeliverable, setupStudio, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import * as deliverables from "./deliverables";

describe("connection points", () => {
  it("grow with the edge and keep stable ids", () => {
    expect(pointsAlong(150)).toEqual([50]);
    expect(pointsAlong(236)).toEqual([25, 50, 75]);
    expect(pointsAlong(480)).toEqual([12, 25, 37, 50, 62, 75, 87]);
    expect(availablePoints(NODE_DEFAULT)).toEqual(["t-25", "t-50", "t-75", "r-50", "b-25", "b-50", "b-75", "l-50"]);
    expect(pointLabel("t-25")).toMatch(/^Top, towards the left/);
  });

  it("move to the nearest point on the same side when a node shrinks", () => {
    expect(remapPoint("t-87", { w: 480, h: 120 }, "r-50")).toBe("t-87");
    expect(remapPoint("t-87", { w: 236, h: 120 }, "r-50")).toBe("t-75");
    expect(remapPoint("t-12", { w: 236, h: 120 }, "r-50")).toBe("t-25");
    expect(remapPoint("r-25", { w: 236, h: 120 }, "r-50")).toBe("r-50");
    expect(remapPoint(null, NODE_DEFAULT, "l-50")).toBe("l-50");
    expect(clampSize(10, 10_000)).toEqual({ w: NODE_MIN.w, h: 560 });
  });
});

let f: Fixture;
let cardId: string;
let a: string;
let b: string;
let c: string;

beforeAll(async () => {
  f = await setupStudio();
  const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Canvas", assigneeIds: [f.member.id] });
  cardId = card.id;
  a = await primaryDeliverable(cardId);
  const withB = await deliverables.createDeliverable(f.manager.actor, { cardId, name: "Rig" });
  b = withB.deliverables.find((d) => d.name === "Rig")!.id;
  const withC = await deliverables.createDeliverable(f.manager.actor, { cardId, name: "Animation" });
  c = withC.deliverables.find((d) => d.name === "Animation")!.id;
});

const row = async (id: string) => (await db.select().from(deliverablesTable).where(eq(deliverablesTable.id, id)))[0]!;

describe("canvas layout", () => {
  it("keeps sizes, starting from the default for existing nodes", async () => {
    expect(await row(a)).toMatchObject({ canvasW: null, canvasH: null });
    await deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: a, x: 10, y: 20, w: 480, h: 260 }] });
    expect(await row(a)).toMatchObject({ canvasX: 10, canvasY: 20, canvasW: 480, canvasH: 260 });
    const detail = await cardService.getCardDetail(f.manager.actor, cardId);
    expect(detail.deliverables.find((d) => d.id === a)).toMatchObject({ canvasW: 480, canvasH: 260 });
    // Out-of-range sizes are clamped.
    await deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: b, w: 20, h: 9000 }] });
    expect(await row(b)).toMatchObject({ canvasW: NODE_MIN.w, canvasH: 560 });
    await deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: b, w: null, h: null }] });
    expect(await row(b)).toMatchObject({ canvasW: null, canvasH: null });
  });

  it("never lets unrelated edits overwrite each other", async () => {
    // Two people at once: one moves A, the other resizes A and moves B.
    await Promise.all([
      deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: a, x: 300, y: 40 }] }),
      deliverables.layoutDeliverables(f.member.actor, { cardId, positions: [{ id: a, w: 400, h: 200 }, { id: b, x: 700, y: 90 }] }),
    ]);
    expect(await row(a)).toMatchObject({ canvasX: 300, canvasY: 40, canvasW: 400, canvasH: 200 });
    expect(await row(b)).toMatchObject({ canvasX: 700, canvasY: 90 });
  });

  it("attaches arrows to chosen points, keeps them through moves, and remaps them on shrink", async () => {
    await deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: a, w: 480, h: 260 }] });
    await deliverables.linkDeliverables(f.manager.actor, { cardId, fromId: a, toId: b, type: "DEPENDENCY", fromPoint: "b-87", toPoint: "t-50" });
    const [link] = await db.select().from(deliverableLinks).where(eq(deliverableLinks.fromId, a));
    expect(link).toMatchObject({ fromPoint: "b-87", toPoint: "t-50", type: "DEPENDENCY", fromId: a, toId: b });
    await deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: a, x: 999, y: 999 }] });
    expect((await db.select().from(deliverableLinks).where(eq(deliverableLinks.id, link!.id)))[0]).toMatchObject({ fromPoint: "b-87" });
    // Shrinking A removes the eighth points: the arrow moves to the nearest, the dependency stays.
    await deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: a, w: 236, h: 112 }] });
    expect((await db.select().from(deliverableLinks).where(eq(deliverableLinks.id, link!.id)))[0]).toMatchObject({ fromPoint: "b-75", toPoint: "t-50", type: "DEPENDENCY", fromId: a, toId: b });
    // Re-attaching an end, and reversing (points travel with their deliverables).
    await deliverables.updateLink(f.manager.actor, { linkId: link!.id, toPoint: "l-50" });
    await deliverables.updateLink(f.manager.actor, { linkId: link!.id, reverse: true });
    expect((await db.select().from(deliverableLinks).where(eq(deliverableLinks.id, link!.id)))[0]).toMatchObject({ fromId: b, toId: a, fromPoint: "l-50", toPoint: "b-75" });
    await deliverables.updateLink(f.manager.actor, { linkId: link!.id, reverse: true });
    await expectAppError(deliverables.updateLink(f.manager.actor, { linkId: link!.id, fromPoint: "x-99" }), "VALIDATION");
  });

  it("keeps the existing relationship rules", async () => {
    await expectAppError(deliverables.linkDeliverables(f.manager.actor, { cardId, fromId: a, toId: b, type: "DEPENDENCY", fromPoint: "t-50" }), "CONFLICT"); // duplicate
    await deliverables.linkDeliverables(f.manager.actor, { cardId, fromId: b, toId: c, type: "DEPENDENCY", fromPoint: "r-50", toPoint: "l-50" });
    await expectAppError(deliverables.linkDeliverables(f.manager.actor, { cardId, fromId: c, toId: a, type: "DEPENDENCY", fromPoint: "t-25" }), "CONFLICT"); // loop
    await deliverables.linkDeliverables(f.manager.actor, { cardId, fromId: c, toId: a, type: "ASSOCIATION", fromPoint: "t-25", toPoint: "b-50" });
  });

  it("copies sizes and points with the card", async () => {
    const copy = await cardService.duplicateCard(f.manager.actor, { cardId, include: { assignees: false, labels: false, checklists: false, attachments: false } });
    const detail = await cardService.getCardDetail(f.manager.actor, copy.id);
    const copyA = detail.deliverables.find((d) => d.number === 1)!;
    expect(copyA).toMatchObject({ canvasW: 236, canvasH: 112 });
    expect(detail.deliverableLinks.find((l) => l.type === "DEPENDENCY" && l.fromId === copyA.id)).toMatchObject({ fromPoint: "b-75", toPoint: "l-50" });
  });

  it("is read-only for people who can't edit the card, and for archived work", async () => {
    await expectAppError(deliverables.layoutDeliverables(f.viewer.actor, { cardId, positions: [{ id: a, w: 300 }] }), "FORBIDDEN");
    await expectAppError(deliverables.layoutDeliverables(f.member2.actor, { cardId, positions: [{ id: a, x: 1 }] }), "FORBIDDEN"); // not on the card
    await expectAppError(deliverables.updateDeliverable(f.viewer.actor, { deliverableId: a, description: "nope" }), "FORBIDDEN");
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: c, archived: true });
    await expectAppError(deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: c, w: 300 }] }), "CONFLICT");
    await expectAppError(deliverables.updateDeliverable(f.manager.actor, { deliverableId: c, description: "nope" }), "CONFLICT");
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: c, archived: false });
    await cardService.setCardArchived(f.manager.actor, { cardId, archived: true });
    await expectAppError(deliverables.layoutDeliverables(f.manager.actor, { cardId, positions: [{ id: a, x: 5 }] }), "FORBIDDEN");
    await cardService.setCardArchived(f.manager.actor, { cardId, archived: false });
  });
});

describe("deliverable descriptions", () => {
  it("can be added, edited (multiline) and cleared by people who can edit, stored as plain text", async () => {
    const text = "Requirements:\n- 2k tris max\n- <b>no</b> scripts";
    await deliverables.updateDeliverable(f.member.actor, { deliverableId: b, description: text });
    expect((await row(b)).description).toBe(text);
    const detail = await cardService.getCardDetail(f.viewer.actor, cardId);
    expect(detail.deliverables.find((d) => d.id === b)!.description).toBe(text);
    await deliverables.updateDeliverable(f.member.actor, { deliverableId: b, description: "" });
    expect((await row(b)).description).toBe("");
  });
});
