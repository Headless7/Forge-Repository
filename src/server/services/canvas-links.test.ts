/**
 * Links between cards (canvas link objects) and shared deliverables: permissions and "not found"
 * for anything outside the project, live data on both sides, what sharing counts toward (only
 * its own card; "needed" holds this card's completion), and what archiving, moving, duplicating
 * and deleting do. Every fixture is created here (test database only).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { LINK_NODE } from "@/lib/canvas-links";
import { rectsOverlap } from "@/lib/canvas-folders";
import { NODE_DEFAULT } from "@/lib/canvas-points";
import { db } from "@/server/db";
import { activityEvents, canvasLinks } from "@/server/db/schema";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as board from "./board";
import * as cardService from "./cards";
import * as links from "./canvas-links";
import * as groups from "./deliverable-groups";
import * as deliverables from "./deliverables";
import * as media from "./media";
import * as production from "./production";
import * as purge from "./purge";
import * as reviews from "./reviews";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

const newCard = (title: string, columnId = f.columns.vfx) => cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId, title, assigneeIds: [f.member.id] });
const detail = (cardId: string, actor = f.manager.actor) => cardService.getCardDetail(actor, cardId);
const history = async (cardId: string) => (await db.select().from(activityEvents).where(eq(activityEvents.cardId, cardId))).map((e) => ({ type: e.type, data: e.data }));
/** Uploads a revision of a deliverable (as the card's assignee) and returns the revision. */
const revise = async (cardId: string, deliverableId: string, color = "#7c6cf2") => {
  const version = await media.createVersion(f.member.actor, { deliverableId });
  await upload(f.member.actor, cardId, { name: `${color.slice(1)}.png`, type: "image/png", buffer: await pngBuffer(64, 64, color) }, "version", version.id);
  return version;
};
const approveWork = async (cardId: string, deliverableId: string) => {
  await revise(cardId, deliverableId);
  await reviews.submitForReview(f.member.actor, { deliverableId });
  await reviews.approve(f.manager.actor, { deliverableId });
};

describe("linking cards", () => {
  it("links another card, shows it live on this side and as 'linked from' on the other", async () => {
    const a = await newCard("Boss arena");
    const b = await newCard("Shrine tower prop", f.columns.ui);
    const after = await links.createLink(f.manager.actor, { cardId: a.id, targetCardId: b.id });
    expect(after.canvasLinks).toHaveLength(1);
    const link = after.canvasLinks[0]!;
    expect(link).toMatchObject({ deliverable: null, needed: false, groupId: null });
    expect(link.card).toMatchObject({ id: b.id, key: b.key, title: "Shrine tower prop", archived: false, column: { name: "UI" }, state: "NOT_SUBMITTED", productionStatus: "TODO" });
    expect(link.card.progress.total).toBe(1);
    expect(link.card.deliverables).toHaveLength(1);

    // The other side finds it too, and it stays current as that card changes.
    expect((await detail(b.id)).linkedFrom).toEqual([expect.objectContaining({ id: link.id, deliverableId: null, needed: false, card: expect.objectContaining({ id: a.id, key: a.key }) })]);
    await cardService.updateCard(f.manager.actor, { cardId: b.id, title: "Shrine tower (final)" });
    expect((await detail(a.id)).canvasLinks[0]!.card.title).toBe("Shrine tower (final)");

    // History on both cards.
    expect(await history(a.id)).toContainEqual({ type: "card.linked", data: expect.objectContaining({ cardKey: b.key }) });
    expect(await history(b.id)).toContainEqual({ type: "card.linked_from", data: expect.objectContaining({ cardKey: a.key }) });
  });

  it("refuses itself, duplicates, archived targets and anything outside the project", async () => {
    const a = await newCard("Guards");
    const b = await newCard("Guard rig");
    const archived = await newCard("Old prop");
    await cardService.setCardArchived(f.manager.actor, { cardId: archived.id, archived: true });
    const foreign = await cardService.createCard(f.outsider.actor, { projectId: f.otherProjectId, columnId: f.otherColumnId, title: "Elsewhere" });
    const foreignDeliverable = await primaryDeliverable(foreign.id);

    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: a.id }), "VALIDATION");
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: foreign.id }), "NOT_FOUND");
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: crypto.randomUUID() }), "NOT_FOUND");
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: b.id, targetDeliverableId: foreignDeliverable }), "NOT_FOUND");
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: archived.id }), "CONFLICT");
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: b.id, needed: true }), "VALIDATION");
    await links.createLink(f.manager.actor, { cardId: a.id, targetCardId: b.id });
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: b.id }), "CONFLICT");
    // The card's own deliverable and the card itself can be linked separately (once each).
    const shared = await primaryDeliverable(b.id);
    await links.createLink(f.manager.actor, { cardId: a.id, targetCardId: b.id, targetDeliverableId: shared });
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: b.id, targetDeliverableId: shared }), "CONFLICT");
    // A deliverable of one card named with another card is not found.
    const c = await newCard("Unrelated");
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: c.id, targetDeliverableId: shared }), "NOT_FOUND");
    // A folder of another card is not found either.
    await expectAppError(links.createLink(f.manager.actor, { cardId: a.id, targetCardId: c.id, groupId: crypto.randomUUID() }), "NOT_FOUND");
  });

  it("follows the card's edit permission; viewers see links but can't change them, outsiders get not found", async () => {
    const a = await newCard("Permissions");
    const b = await newCard("Target");
    await expectAppError(links.createLink(f.viewer.actor, { cardId: a.id, targetCardId: b.id }), "FORBIDDEN");
    // A contributor who isn't on the card can't arrange it.
    await expectAppError(links.createLink(f.member2.actor, { cardId: a.id, targetCardId: b.id }), "FORBIDDEN");
    await expectAppError(links.createLink(f.outsider.actor, { cardId: a.id, targetCardId: b.id }), "NOT_FOUND");
    // The assignee can.
    const made = await links.createLink(f.member.actor, { cardId: a.id, targetCardId: b.id });
    const linkId = made.canvasLinks[0]!.id;
    expect((await detail(a.id, f.viewer.actor)).canvasLinks.map((l) => l.id)).toEqual([linkId]);
    expect((await detail(b.id, f.viewer.actor)).linkedFrom.map((l) => l.id)).toEqual([linkId]);
    await expectAppError(links.removeLink(f.viewer.actor, { linkId }), "FORBIDDEN");
    await expectAppError(links.removeLink(f.outsider.actor, { linkId }), "NOT_FOUND");
    await expectAppError(links.removeLink(f.manager.actor, { linkId: crypto.randomUUID() }), "NOT_FOUND");
    await expectAppError(links.linkCandidates(f.outsider.actor, { cardId: a.id }), "NOT_FOUND");
    // Links only move with the card's edit permission, like deliverables.
    await expectAppError(deliverables.layoutDeliverables(f.viewer.actor, { cardId: a.id, positions: [{ id: linkId, x: 5, y: 5 }] }), "FORBIDDEN");
    // Removing it touches neither card's work; history says who did it on both sides.
    const after = await links.removeLink(f.manager.actor, { linkId });
    expect(after.canvasLinks).toEqual([]);
    expect((await detail(b.id)).linkedFrom).toEqual([]);
    expect(await history(a.id)).toContainEqual({ type: "card.unlinked", data: expect.objectContaining({ cardKey: b.key }) });
    expect(await history(b.id)).toContainEqual({ type: "card.unlinked_from", data: expect.objectContaining({ cardKey: a.key }) });
  });

  it("lists the project's active cards and their deliverables to link to, never this card or other projects", async () => {
    const a = await newCard("Picker");
    const b = await newCard("Pickable");
    await deliverables.createDeliverable(f.manager.actor, { cardId: b.id, name: "Extra" });
    const gone = await newCard("Archived one");
    await cardService.setCardArchived(f.manager.actor, { cardId: gone.id, archived: true });
    const result = await links.linkCandidates(f.viewer.actor, { cardId: a.id });
    const ids = result.cards.map((c) => c.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(gone.id);
    expect(result.cards.find((c) => c.id === b.id)?.deliverables.map((d) => d.name)).toEqual(["Pickable", "Extra"]);
    expect(result.boards.flatMap((x) => x.columns.map((c) => c.id))).toEqual(expect.arrayContaining([f.columns.vfx, f.columns.ui]));
  });

  it("places links clear of everything on the canvas, in folders too, and moves them like deliverables", async () => {
    const a = await newCard("Layout");
    const second = (await deliverables.createDeliverable(f.manager.actor, { cardId: a.id, name: "Rig", canvasX: 300, canvasY: 0 })).deliverables.find((d) => d.name === "Rig")!;
    const targets = await Promise.all([newCard("T1"), newCard("T2"), newCard("T3")]);
    for (const t of targets) await links.createLink(f.manager.actor, { cardId: a.id, targetCardId: t.id });
    // A deliverable asked for right where a link sits lands beside it instead.
    const firstLink = (await detail(a.id)).canvasLinks[0]!;
    await deliverables.createDeliverable(f.manager.actor, { cardId: a.id, name: "Late", canvasX: firstLink.canvasX, canvasY: firstLink.canvasY });
    const after = await detail(a.id);
    const rects = [
      ...after.deliverables.map((d) => ({ x: d.canvasX, y: d.canvasY, w: d.canvasW ?? NODE_DEFAULT.w, h: d.canvasH ?? NODE_DEFAULT.h })),
      ...after.canvasLinks.map((l) => ({ x: l.canvasX, y: l.canvasY, ...LINK_NODE })),
    ];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i]!, rects[j]!), `${i} overlaps ${j}`).toBe(false);

    // Folders hold links like deliverables: a folder with only a link stays; ungrouping moves it up.
    const [l1, l2] = after.canvasLinks;
    const grouped = await groups.createGroup(f.manager.actor, { cardId: a.id, name: "Refs", deliverableIds: [second.id], linkIds: [l1!.id] });
    const folder = grouped.deliverableGroups.find((g) => g.name === "Refs")!;
    expect(grouped.canvasLinks.find((l) => l.id === l1!.id)?.groupId).toBe(folder.id);
    const moved = await groups.moveToGroup(f.manager.actor, { cardId: a.id, deliverableIds: [second.id], targetGroupId: null });
    expect(moved.deliverableGroups.map((g) => g.id)).toContain(folder.id);
    await groups.moveToGroup(f.manager.actor, { cardId: a.id, linkIds: [l2!.id], targetGroupId: folder.id });
    // A link placed into a folder from outside the canvas lands beside what's there.
    const t4 = await newCard("T4");
    const placed = await links.createLink(f.manager.actor, { cardId: a.id, targetCardId: t4.id, groupId: folder.id });
    expect(placed.canvasLinks.find((l) => l.card.id === t4.id)?.groupId).toBe(folder.id);
    await groups.ungroup(f.manager.actor, { groupId: folder.id });
    const flat = await detail(a.id);
    expect(flat.deliverableGroups).toEqual([]);
    expect(flat.canvasLinks.every((l) => l.groupId === null)).toBe(true);

    // Removing the last thing in a folder removes the folder.
    const solo = await groups.createGroup(f.manager.actor, { cardId: a.id, name: "Solo", deliverableIds: [], linkIds: [l1!.id] });
    const soloId = solo.deliverableGroups.find((g) => g.name === "Solo")!.id;
    const removed = await links.removeLink(f.manager.actor, { linkId: l1!.id });
    expect(removed.deliverableGroups.map((g) => g.id)).not.toContain(soloId);

    // Layout saves link positions with deliverables; another card's link is not found.
    await deliverables.layoutDeliverables(f.manager.actor, { cardId: a.id, positions: [{ id: l2!.id, x: 1000, y: 40 }, { id: second.id, x: 640, y: 40 }] });
    const laid = await detail(a.id);
    expect(laid.canvasLinks.find((l) => l.id === l2!.id)).toMatchObject({ canvasX: 1000, canvasY: 40 });
    const other = await newCard("Other card");
    const foreignLink = (await links.createLink(f.manager.actor, { cardId: other.id, targetCardId: a.id })).canvasLinks[0]!;
    await expectAppError(deliverables.layoutDeliverables(f.manager.actor, { cardId: a.id, positions: [{ id: foreignLink.id, x: 0, y: 0 }] }), "NOT_FOUND");
    await expectAppError(groups.moveToGroup(f.manager.actor, { cardId: a.id, linkIds: [foreignLink.id], targetGroupId: null }), "NOT_FOUND");
  });
});

describe("shared deliverables", () => {
  it("count only on their own card; 'needed' holds this card's completion until they're approved", async () => {
    const home = await newCard("Guardian rig");
    const rig = await primaryDeliverable(home.id);
    const user = await newCard("Boss fight");
    const own = await primaryDeliverable(user.id);
    const shared = await links.createLink(f.manager.actor, { cardId: user.id, targetCardId: home.id, targetDeliverableId: rig });
    const link = shared.canvasLinks[0]!;
    expect(link.deliverable).toMatchObject({ id: rig, name: "Guardian rig", state: "NOT_SUBMITTED", archived: false, versionCount: 0 });
    expect(link.needed).toBe(false);
    // Neither card's progress or review state counts it twice.
    expect(shared.progress.total).toBe(1);
    expect((await detail(home.id)).progress.total).toBe(1);
    expect((await detail(home.id)).linkedFrom).toEqual([expect.objectContaining({ deliverableId: rig, needed: false })]);

    // Not needed: this card completes on its own work.
    await approveWork(user.id, own);
    expect((await detail(user.id)).readiness.ready).toBe(true);

    // Needed: it holds completion, with the reason and where it lives.
    const needed = await links.setLinkNeeded(f.manager.actor, { linkId: link.id, needed: true });
    expect(needed.readiness.ready).toBe(false);
    expect(needed.readiness.blockers).toEqual([expect.objectContaining({ deliverableId: rig, sharedFrom: home.key, reason: expect.stringContaining(`Shared from ${home.key}`) })]);
    expect(needed.state).toBe("APPROVED"); // its own review roll-up is unaffected
    expect(needed.progress.approved).toBe(1);
    await expectAppError(production.moveProduction(f.manager.actor, { cardId: user.id, status: "COMPLETED" }), "CONFLICT");
    expect((await detail(home.id)).linkedFrom[0]!.needed).toBe(true);
    // Only the card's editors decide it; a link to a whole card can't be needed.
    await expectAppError(links.setLinkNeeded(f.viewer.actor, { linkId: link.id, needed: false }), "FORBIDDEN");
    const cardLink = (await links.createLink(f.manager.actor, { cardId: user.id, targetCardId: (await newCard("Whole card")).id })).canvasLinks.find((l) => !l.deliverable)!;
    await expectAppError(links.setLinkNeeded(f.manager.actor, { linkId: cardLink.id, needed: true }), "VALIDATION");

    // Work and review happen on its own card, once; this card picks it up live.
    await approveWork(home.id, rig);
    const ready = await detail(user.id);
    expect(ready.canvasLinks.find((l) => l.id === link.id)?.deliverable).toMatchObject({ state: "APPROVED", approvedVersionNumber: 1, hasFiles: true, versionCount: 1 });
    expect(ready.readiness.ready).toBe(true);
    expect(ready.versions.filter((v) => v.deliverableId === rig)).toEqual([]); // nothing copied here

    // Completing records the shared revision; a newer revision there shows as pending here.
    await production.moveProduction(f.manager.actor, { cardId: user.id, status: "COMPLETED" });
    const completed = await detail(user.id);
    expect(completed.productionSnapshot).toContainEqual(expect.objectContaining({ deliverableId: rig, versionNumber: 1, sharedFrom: home.key }));
    expect(completed.readiness.pendingChanges).toEqual([]);
    await revise(home.id, rig, "#123456");
    const pending = await detail(user.id);
    expect(pending.readiness.pendingChanges).toEqual([expect.objectContaining({ deliverableId: rig, sharedFrom: home.key, detail: expect.stringContaining("V2") })]);
    expect(pending.pendingChanges).toBe(true);
    const tile = (await board.getBoard(f.manager.actor, f.projectId)).cards.find((c) => c.id === user.id)!;
    expect(tile.pendingChanges).toBe(true);
  });

  it("stop counting when archived, come back when restored, and go (with a note) when deleted for good", async () => {
    const home = await newCard("Lantern");
    const extra = (await deliverables.createDeliverable(f.manager.actor, { cardId: home.id, name: "Lantern glow VFX" })).deliverables.find((d) => d.name === "Lantern glow VFX")!;
    const user = await newCard("Festival");
    const own = await primaryDeliverable(user.id);
    await approveWork(user.id, own);
    const made = await links.createLink(f.manager.actor, { cardId: user.id, targetCardId: home.id, targetDeliverableId: extra.id, needed: true });
    const cardLink = await links.createLink(f.manager.actor, { cardId: user.id, targetCardId: home.id });
    expect(made.readiness.ready).toBe(false);

    // Archived on its own card: shown as archived here, and no longer holds this card.
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: extra.id, archived: true });
    let now = await detail(user.id);
    expect(now.canvasLinks.find((l) => l.deliverable)?.deliverable?.archived).toBe(true);
    expect(now.readiness.ready).toBe(true);
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: extra.id, archived: false });
    now = await detail(user.id);
    expect(now.readiness.ready).toBe(false);

    // The whole card archived: the links stay and say so; restoring brings them back to normal.
    await cardService.setCardArchived(f.manager.actor, { cardId: home.id, archived: true });
    now = await detail(user.id);
    expect(now.canvasLinks.every((l) => l.card.archived)).toBe(true);
    expect(now.readiness.ready).toBe(true);
    await cardService.setCardArchived(f.manager.actor, { cardId: home.id, archived: false });
    expect((await detail(user.id)).canvasLinks.every((l) => !l.card.archived)).toBe(true);

    // Moving the card to another board keeps the link, which shows the new board.
    const other = await board.createBoard(f.owner.actor, { projectId: f.projectId, name: "Assets" });
    const column = await board.createColumn(f.owner.actor, { projectId: f.projectId, boardId: other.id, name: "Props" });
    await cardService.moveCard(f.manager.actor, { cardId: home.id, toColumnId: column.id });
    expect((await detail(user.id)).canvasLinks.find((l) => !l.deliverable)?.card).toMatchObject({ board: { name: "Assets" }, column: { name: "Props" } });

    // Deleted for good: the shared deliverable's link goes, and the history says why.
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: extra.id, archived: true });
    const preview = await purge.previewPurge(f.owner.actor, { targets: [{ type: "deliverable", id: extra.id }] });
    expect(preview.totals.links).toBe(1);
    await purge.purge(f.owner.actor, { targets: [{ type: "deliverable", id: extra.id }] });
    now = await detail(user.id);
    expect(now.canvasLinks.map((l) => l.id)).toEqual([cardLink.canvasLinks.find((l) => !l.deliverable)!.id]);
    expect(await history(user.id)).toContainEqual({ type: "card.link_removed", data: expect.objectContaining({ cardKey: home.key, deliverable: "Lantern glow VFX" }) });

    // And the card itself.
    await cardService.setCardArchived(f.manager.actor, { cardId: home.id, archived: true });
    expect((await purge.previewPurge(f.owner.actor, { targets: [{ type: "card", id: home.id }] })).totals.links).toBe(1);
    await cardService.deleteCardPermanently(f.owner.actor, { cardId: home.id, confirm: home.key });
    expect((await detail(user.id)).canvasLinks).toEqual([]);
    expect(await history(user.id)).toContainEqual({ type: "card.link_removed", data: expect.objectContaining({ cardKey: home.key }) });
  });

  it("are copied with a duplicated card (same work, never a copy of it), folders included", async () => {
    const home = await newCard("Sword model");
    const user = await newCard("Sword VFX");
    const made = await links.createLink(f.manager.actor, { cardId: user.id, targetCardId: home.id, targetDeliverableId: await primaryDeliverable(home.id), needed: true });
    const linkId = made.canvasLinks[0]!.id;
    await groups.createGroup(f.manager.actor, { cardId: user.id, name: "From others", deliverableIds: [], linkIds: [linkId] });
    const copy = await cardService.duplicateCard(f.manager.actor, { cardId: user.id, include: { assignees: false, labels: false, checklists: false, attachments: false } });
    const copied = await detail(copy.id);
    expect(copied.canvasLinks).toHaveLength(1);
    expect(copied.canvasLinks[0]).toMatchObject({ needed: true, deliverable: { id: await primaryDeliverable(home.id) } });
    expect(copied.deliverableGroups.map((g) => g.name)).toEqual(["From others"]);
    expect(copied.canvasLinks[0]!.groupId).toBe(copied.deliverableGroups[0]!.id);
    expect((await detail(home.id)).linkedFrom.map((l) => l.card.id).sort()).toEqual([user.id, copy.id].sort());
    const rows = await db.select().from(canvasLinks).where(and(eq(canvasLinks.cardId, copy.id)));
    expect(rows[0]!.targetCardId).toBe(home.id);
  });
});
