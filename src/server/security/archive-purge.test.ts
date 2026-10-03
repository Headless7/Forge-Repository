/**
 * Project lifecycle is the owner's; permanent deletion of archived content reclaims storage
 * without touching active work or files other cards still use. All fixtures are created here.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getProjectAccess } from "@/server/access";
import { db } from "@/server/db";
import { attachments, auditLogs, cards as cardsTable, projects as projectsTable, robloxResources, storageDeletions } from "@/server/db/schema";
import { appRouter } from "@/server/rpc/router";
import * as board from "@/server/services/board";
import * as cards from "@/server/services/cards";
import type { Actor } from "@/server/services/context";
import * as deliverables from "@/server/services/deliverables";
import * as media from "@/server/services/media";
import * as projects from "@/server/services/projects";
import { previewPurge, processStorageDeletions, purge, storageUnits } from "@/server/services/purge";
import { studioStorageUsed } from "@/server/services/storage-quota";
import * as studios from "@/server/services/studios";
import { storage } from "@/server/storage";
import { createUser, expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";

async function call<N extends keyof typeof appRouter>(name: N, actor: Actor, input: unknown) {
  const procedure = appRouter[name];
  const handler = procedure.handler as (ctx: unknown, input: unknown) => Promise<unknown>;
  return handler({ actor, user: { id: actor.userId } }, procedure.input.parse(input));
}

const exists = async (key: string) => Boolean(await storage().stat(key));

describe("project lifecycle belongs to the owner", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setupStudio();
  });

  it("lets only the owner archive, restore and delete; admins keep inviting and managing", async () => {
    await expectAppError(projects.setProjectArchived(f.admin.actor, { projectId: f.projectId, archived: true }), "FORBIDDEN");
    await expectAppError(call("project.archive", f.manager.actor, { projectId: f.projectId, archived: true }), "FORBIDDEN");
    // A project-level admin role doesn't grant it either.
    await projects.setProjectMember(f.admin.actor, { projectId: f.projectId, userId: f.member.id, member: true, role: "ADMIN" });
    expect((await getProjectAccess(f.member.id, f.projectId))?.role).toBe("ADMIN");
    await expectAppError(projects.setProjectArchived(f.member.actor, { projectId: f.projectId, archived: true }), "FORBIDDEN");

    await expect(studios.createInvitation(f.admin.actor, { studioId: f.studioId, email: `invitee_${Date.now()}@test.dev`, role: "CONTRIBUTOR" })).resolves.toBeTruthy();
    await expect(projects.updateProject(f.admin.actor, { projectId: f.projectId, description: "Admin can still edit settings" })).resolves.toBeTruthy();

    const doomed = await projects.createProject(f.admin.actor, { studioId: f.studioId, name: `Doomed ${Date.now()}`, template: "empty" });
    await expectAppError(projects.deleteProject(f.owner.actor, { projectId: doomed.id, confirm: doomed.name }), "VALIDATION"); // archive first
    await projects.setProjectArchived(f.owner.actor, { projectId: doomed.id, archived: true });
    await projects.setProjectArchived(f.owner.actor, { projectId: doomed.id, archived: false });
    await projects.setProjectArchived(f.owner.actor, { projectId: doomed.id, archived: true });
    await expectAppError(projects.deleteProject(f.admin.actor, { projectId: doomed.id, confirm: doomed.name }), "FORBIDDEN");
    await expect(purge(f.admin.actor, { targets: [{ type: "project", id: doomed.id }] })).resolves.toMatchObject({ results: [{ status: "skipped" }] });
    await projects.deleteProject(f.owner.actor, { projectId: doomed.id, confirm: doomed.name });
    expect(await db.select().from(projectsTable).where(eq(projectsTable.id, doomed.id))).toHaveLength(0);
    // The audit log still says which project each step was about after it's gone.
    const log = await db.select().from(auditLogs).where(eq(auditLogs.targetId, doomed.id)).orderBy(auditLogs.createdAt);
    expect(log.map((e) => [e.action, e.data.name])).toEqual(
      ["project.created", "project.archived", "project.restored", "project.archived", "project.deleted"].map((action) => [action, doomed.name]),
    );
  });
});

describe("bulk deletion of archived content", () => {
  let f: Fixture;
  const png = () => pngBuffer(16, 16);
  async function cardWithFile(title: string, columnId: string) {
    const card = await cards.createCard(f.owner.actor, { projectId: f.projectId, columnId, title, assigneeIds: [f.owner.id] });
    const deliverableId = await primaryDeliverable(card.id);
    const version = await media.createVersion(f.owner.actor, { deliverableId });
    const file = await upload(f.owner.actor, card.id, { name: `${title}.png`, type: "image/png", buffer: await png() }, "version", version.id, deliverableId);
    const [row] = await db.select().from(attachments).where(eq(attachments.id, file.id));
    return { card, file: row! };
  }

  beforeAll(async () => {
    f = await setupStudio();
  });
  afterEach(() => vi.restoreAllMocks());

  it("previews the exact scope, keeps active work out of it and counts shared files once", async () => {
    const archivedColumn = await board.createColumn(f.owner.actor, { projectId: f.projectId, name: "Old ideas" });
    const inOldColumn = await cardWithFile("Old concept", archivedColumn.id);
    await cards.setCardArchived(f.owner.actor, { cardId: inOldColumn.card.id, archived: true });
    await board.setColumnArchived(f.owner.actor, { columnId: archivedColumn.id, archived: true });

    const busyColumn = await board.createColumn(f.owner.actor, { projectId: f.projectId, name: "Busy" });
    const active = await cardWithFile("Still in progress", busyColumn.id);
    await board.setColumnArchived(f.owner.actor, { columnId: busyColumn.id, archived: true });

    const original = await cardWithFile("Shared sword", f.columns.vfx);
    const copy = await cards.duplicateCard(f.owner.actor, { cardId: original.card.id, include: { assignees: false, labels: false, checklists: false, attachments: true } });
    await cards.setCardArchived(f.owner.actor, { cardId: original.card.id, archived: true });

    const preview = await previewPurge(f.admin.actor, {
      targets: [
        { type: "column", id: archivedColumn.id },
        { type: "card", id: inOldColumn.card.id },
        { type: "column", id: busyColumn.id },
        { type: "card", id: active.card.id },
        { type: "card", id: original.card.id },
      ],
    });
    const byId = new Map(preview.items.map((i) => [i.id, i]));
    expect(byId.get(archivedColumn.id)).toMatchObject({ eligible: true, counts: { cards: 1, files: 1 } });
    expect(byId.get(inOldColumn.card.id)?.includedIn?.id).toBe(archivedColumn.id);
    expect(byId.get(busyColumn.id)).toMatchObject({ eligible: false, reason: expect.stringContaining("1 active card") });
    expect(byId.get(active.card.id)).toMatchObject({ eligible: false, reason: "The card isn't archived." });
    // The archived original shares its file with an active duplicate: nothing to reclaim there.
    expect(byId.get(original.card.id)).toMatchObject({ eligible: true, bytes: 0 });
    expect(preview.totals).toMatchObject({ items: 2, files: 2, sharedFiles: 1, bytes: inOldColumn.file.sizeBytes });

    const usedBefore = await studioStorageUsed(f.studioId);
    const result = await purge(f.admin.actor, { targets: preview.items.map((i) => ({ type: i.type, id: i.id })) });
    const status = new Map(result.results.map((r) => [r.id, r.status]));
    expect(status.get(archivedColumn.id)).toBe("deleted");
    expect(status.get(inOldColumn.card.id)).toBe("deleted");
    expect(status.get(busyColumn.id)).toBe("skipped");
    expect(status.get(active.card.id)).toBe("skipped");
    expect(status.get(original.card.id)).toBe("deleted");
    expect(result.bytes).toBe(inOldColumn.file.sizeBytes);
    expect(await studioStorageUsed(f.studioId)).toBe(usedBefore - inOldColumn.file.sizeBytes);

    // Active work is untouched; the duplicate still has its (shared) file.
    expect(await db.select().from(cardsTable).where(eq(cardsTable.id, active.card.id))).toHaveLength(1);
    expect(await db.select().from(cardsTable).where(eq(cardsTable.id, copy.id))).toHaveLength(1);
    await processStorageDeletions();
    expect(await exists(inOldColumn.file.storageKey)).toBe(false);
    expect(await exists(original.file.storageKey)).toBe(true);
    expect(await exists(active.file.storageKey)).toBe(true);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.studioId, f.studioId), eq(auditLogs.action, "column.deleted")));
    expect(audit.map((a) => a.targetId)).toContain(archivedColumn.id);

    // Asking again reports what's already gone instead of failing.
    const again = await purge(f.admin.actor, { targets: [{ type: "column", id: archivedColumn.id }] });
    expect(again.results[0]).toMatchObject({ status: "skipped", reason: "Already deleted" });
  });

  it("deletes archived deliverables and files, but not shared Roblox resources", async () => {
    const { card, file } = await cardWithFile("Multi", f.columns.ui);
    const detail = await deliverables.createDeliverable(f.owner.actor, { cardId: card.id, name: "Extra" });
    const extra = detail.deliverables.find((d) => d.name === "Extra")!;
    const extraVersion = await media.createVersion(f.owner.actor, { deliverableId: extra.id });
    const extraFile = await upload(f.owner.actor, card.id, { name: "extra.png", type: "image/png", buffer: await png() }, "version", extraVersion.id, extra.id);
    await deliverables.setDeliverableArchived(f.owner.actor, { deliverableId: extra.id, archived: true });

    const reference = await upload(f.owner.actor, card.id, { name: "ref.png", type: "image/png", buffer: await png() }, "attachment");
    await media.archiveAttachment(f.owner.actor, { attachmentId: reference.id });
    const resource = await upload(f.owner.actor, card.id, { name: "mesh.png", type: "image/png", buffer: await png() }, "resource");
    await db.insert(robloxResources).values({ projectId: f.projectId, contentId: "rbxassetid://1", kind: "texture", attachmentId: resource.id });
    await media.archiveAttachment(f.owner.actor, { attachmentId: resource.id });

    const preview = await previewPurge(f.owner.actor, {
      targets: [
        { type: "deliverable", id: extra.id },
        { type: "attachment", id: reference.id },
        { type: "attachment", id: resource.id },
      ],
    });
    expect(preview.items.find((i) => i.id === resource.id)).toMatchObject({ eligible: false, reason: expect.stringContaining("Roblox resource") });
    const { results } = await purge(f.owner.actor, { targets: preview.items.map((i) => ({ type: i.type, id: i.id })) });
    expect(results.map((r) => r.status)).toEqual(["deleted", "deleted", "skipped"]);
    const left = (await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.cardId, card.id))).map((r) => r.id);
    expect(left).toContain(file.id); // the active deliverable's work
    expect(left).toContain(resource.id);
    expect(left).not.toContain(extraFile.id);
    expect(left).not.toContain(reference.id);
  });

  it("re-checks at execution: restored items and non-admins are skipped", async () => {
    const { card } = await cardWithFile("Changed mind", f.columns.ui);
    await cards.setCardArchived(f.owner.actor, { cardId: card.id, archived: true });
    await expect(previewPurge(f.owner.actor, { targets: [{ type: "card", id: card.id }] })).resolves.toMatchObject({ items: [{ eligible: true }] });
    await cards.setCardArchived(f.owner.actor, { cardId: card.id, archived: false }); // restored meanwhile
    expect((await purge(f.owner.actor, { targets: [{ type: "card", id: card.id }] })).results[0]).toMatchObject({ status: "skipped" });

    await cards.setCardArchived(f.owner.actor, { cardId: card.id, archived: true });
    for (const who of [f.manager, f.member, f.viewer]) {
      expect((await purge(who.actor, { targets: [{ type: "card", id: card.id }] })).results[0]).toMatchObject({ status: "skipped" });
    }
    // The bulk endpoint needs the typed confirmation (the API answers 400 without it).
    await expect(call("archive.purge", f.owner.actor, { targets: [{ type: "card", id: card.id }], confirm: "yes" })).rejects.toThrow(/DELETE/);
    expect(await db.select().from(cardsTable).where(eq(cardsTable.id, card.id))).toHaveLength(1);
  });

  it("keeps retrying storage cleanup until it succeeds", async () => {
    const { card, file } = await cardWithFile("Flaky storage", f.columns.ui);
    await cards.setCardArchived(f.owner.actor, { cardId: card.id, archived: true });
    const store = storage();
    const failing = vi.spyOn(store, "deletePrefix").mockRejectedValueOnce(new Error("storage unavailable"));
    await purge(f.owner.actor, { targets: [{ type: "card", id: card.id }] });
    const [unit] = storageUnits(file);
    await db.update(storageDeletions).set({ nextAttemptAt: new Date(0) }).where(eq(storageDeletions.prefix, unit!));
    expect(await processStorageDeletions()).toMatchObject({ failed: 1 });
    const [job] = await db.select().from(storageDeletions).where(eq(storageDeletions.prefix, unit!));
    expect(job).toMatchObject({ attempts: 1, lastError: expect.stringContaining("storage unavailable") });
    expect(await exists(file.storageKey)).toBe(true);
    failing.mockRestore();
    await db.update(storageDeletions).set({ nextAttemptAt: new Date(0) }).where(eq(storageDeletions.prefix, unit!));
    expect(await processStorageDeletions()).toMatchObject({ deleted: 1 });
    expect(await exists(file.storageKey)).toBe(false);
    expect(await db.select().from(storageDeletions).where(eq(storageDeletions.prefix, unit!))).toHaveLength(0);
  });

  it("only lets the owner include projects", async () => {
    const p = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Old ${Date.now()}`, template: "empty" });
    await projects.setProjectArchived(f.owner.actor, { projectId: p.id, archived: true });
    expect((await purge(f.admin.actor, { targets: [{ type: "project", id: p.id }] })).results[0]).toMatchObject({ status: "skipped" });
    await expectAppError(call("archive.projects", f.admin.actor, { studioId: f.studioId }), "FORBIDDEN");
    const listed = (await call("archive.projects", f.owner.actor, { studioId: f.studioId })) as Array<{ id: string }>;
    expect(listed.map((x) => x.id)).toContain(p.id);
    expect((await purge(f.owner.actor, { targets: [{ type: "project", id: p.id }] })).results[0]).toMatchObject({ status: "deleted" });
    await createUser("Bystander"); // nothing else in the studio changed
  });
});
