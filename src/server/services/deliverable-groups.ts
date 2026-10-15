import { and, eq, inArray, isNull } from "drizzle-orm";
import { DEFAULT_FOLDER_NAME, FOLDER_NAME_MAX, folderContains, foldersById } from "@/lib/canvas-folders";
import { ACCENT_COLORS } from "@/lib/column-icons";
import type { CardDetailDTO } from "@/lib/types";
import { assertCard, requireCard, type CardAccess } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { deliverableGroups, deliverables } from "../db/schema";
import { conflict, invalid, notFound } from "../errors";
import { loadCardDetail } from "./card-dto";
import type { Actor } from "./context";
import { applyLayout, type NodeLayout } from "./deliverables";
import { Effects } from "./effects";

/**
 * Folders on a card's deliverable canvas (see lib/canvas-folders): named frames that nest, used
 * only to organise. Changing them is arranging the canvas, so it takes the same permission as
 * moving a node and leaves files, reviews and history untouched. Every folder keeps at least one
 * active deliverable (directly or in a sub-folder); one left empty is removed.
 */

const EDIT_MESSAGE = "You don't have permission to arrange this card's deliverables.";

type GroupRow = typeof deliverableGroups.$inferSelect;

function cleanName(name: string | undefined | null): string {
  const trimmed = (name ?? "").trim().slice(0, FOLDER_NAME_MAX);
  return trimmed || DEFAULT_FOLDER_NAME;
}

function cleanColor(color: string | null | undefined): string | null {
  if (!color) return null;
  if (!(ACCENT_COLORS as readonly string[]).includes(color)) throw invalid("Pick a colour from the palette.");
  return color;
}

const unique = (ids: readonly string[] | undefined) => [...new Set(ids ?? [])];

async function requireGroup(actor: Actor, groupId: string): Promise<{ ctx: CardAccess; group: GroupRow }> {
  const [group] = await db.select().from(deliverableGroups).where(eq(deliverableGroups.id, groupId));
  if (!group) throw notFound("Folder");
  const ctx = await requireCard(actor.userId, group.cardId).catch(() => {
    throw notFound("Folder");
  });
  return { ctx, group };
}

/** The deliverables and folders named must all be this card's, and the deliverables active. */
async function assertMembers(tx: Executor, cardId: string, deliverableIds: string[], groupIds: string[], groups: ReadonlyMap<string, GroupRow>) {
  if (deliverableIds.length) {
    const rows = await tx
      .select({ id: deliverables.id, archivedAt: deliverables.archivedAt })
      .from(deliverables)
      .where(and(eq(deliverables.cardId, cardId), inArray(deliverables.id, deliverableIds)));
    if (rows.length !== deliverableIds.length) throw notFound("Deliverable");
    if (rows.some((r) => r.archivedAt)) throw conflict("Archived deliverables can't be put in folders. Restore them first.");
  }
  for (const id of groupIds) if (!groups.has(id)) throw notFound("Folder");
}

/**
 * Removes folders with nothing active inside them (no active deliverable, no sub-folder), and
 * then any folder that became empty because of it. Archived deliverables still pointing at a
 * removed folder return to the top level (the database clears the reference).
 */
export async function removeEmptyGroups(tx: Executor, cardId: string): Promise<string[]> {
  const removed: string[] = [];
  const groups = await tx.select({ id: deliverableGroups.id, parentId: deliverableGroups.parentId }).from(deliverableGroups).where(eq(deliverableGroups.cardId, cardId));
  if (!groups.length) return removed;
  const active = await tx
    .select({ groupId: deliverables.groupId })
    .from(deliverables)
    .where(and(eq(deliverables.cardId, cardId), isNull(deliverables.archivedAt)));
  const used = new Set(active.map((d) => d.groupId).filter((id): id is string => Boolean(id)));
  const remaining = new Map(groups.map((g) => [g.id, g]));
  for (;;) {
    const parents = new Set([...remaining.values()].map((g) => g.parentId));
    const empty = [...remaining.values()].filter((g) => !used.has(g.id) && !parents.has(g.id));
    if (!empty.length) break;
    for (const g of empty) {
      remaining.delete(g.id);
      removed.push(g.id);
    }
  }
  if (removed.length) await tx.delete(deliverableGroups).where(inArray(deliverableGroups.id, removed));
  return removed;
}

async function finish(actor: Actor, ctx: CardAccess, fx: Effects): Promise<CardDetailDTO> {
  fx.card(ctx.card.projectId, ctx.card.id, false);
  fx.flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}

/**
 * Makes a folder around the deliverables (and folders) given, inside `parentId` (or at the top
 * level). Whatever they were in before loses them, and is removed if that left it empty. Any
 * positions sent are saved in the same step, so dropping one deliverable onto another lands
 * both where they're shown.
 */
export async function createGroup(
  actor: Actor,
  input: { cardId: string; name?: string | null; color?: string | null; parentId?: string | null; deliverableIds: string[]; groupIds?: string[]; positions?: NodeLayout[] },
): Promise<CardDetailDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", EDIT_MESSAGE);
  const deliverableIds = unique(input.deliverableIds);
  const groupIds = unique(input.groupIds);
  if (!deliverableIds.length && !groupIds.length) throw invalid("Pick at least one deliverable to put in the folder.");
  const color = cleanColor(input.color);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const groups = foldersById(await tx.select().from(deliverableGroups).where(eq(deliverableGroups.cardId, ctx.card.id)));
    const parentId = input.parentId ?? null;
    if (parentId && !groups.has(parentId)) throw notFound("Folder");
    await assertMembers(tx, ctx.card.id, deliverableIds, groupIds, groups);
    for (const id of groupIds) if (folderContains(groups, id, parentId)) throw conflict("A folder can't be moved inside itself.");
    const [group] = await tx
      .insert(deliverableGroups)
      .values({ cardId: ctx.card.id, parentId, name: cleanName(input.name), color, createdById: actor.userId, createdAt: now() })
      .returning();
    if (deliverableIds.length) await tx.update(deliverables).set({ groupId: group!.id }).where(inArray(deliverables.id, deliverableIds));
    if (groupIds.length) await tx.update(deliverableGroups).set({ parentId: group!.id, updatedAt: now() }).where(inArray(deliverableGroups.id, groupIds));
    if (input.positions?.length) await applyLayout(tx, ctx.card.id, input.positions);
    await removeEmptyGroups(tx, ctx.card.id);
  });
  return finish(actor, ctx, fx);
}

export async function updateGroup(actor: Actor, input: { groupId: string; name?: string; color?: string | null; collapsed?: boolean }): Promise<CardDetailDTO> {
  const { ctx, group } = await requireGroup(actor, input.groupId);
  assertCard(ctx.perms, "canEdit", EDIT_MESSAGE);
  const patch: Partial<typeof deliverableGroups.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw invalid("Give the folder a name.");
    if (name.length > FOLDER_NAME_MAX) throw invalid(`Folder names are up to ${FOLDER_NAME_MAX} characters.`);
    patch.name = name;
  }
  if (input.color !== undefined) patch.color = cleanColor(input.color);
  if (input.collapsed !== undefined) patch.collapsed = input.collapsed;
  const fx = new Effects();
  if (Object.keys(patch).length) {
    await db.update(deliverableGroups).set({ ...patch, updatedAt: now() }).where(eq(deliverableGroups.id, group.id));
  }
  return finish(actor, ctx, fx);
}

/** Dissolves a folder: what's inside moves up to the folder it was in, and the folder goes. */
export async function ungroup(actor: Actor, input: { groupId: string }): Promise<CardDetailDTO> {
  const { ctx, group } = await requireGroup(actor, input.groupId);
  assertCard(ctx.perms, "canEdit", EDIT_MESSAGE);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx.update(deliverables).set({ groupId: group.parentId }).where(eq(deliverables.groupId, group.id));
    await tx.update(deliverableGroups).set({ parentId: group.parentId, updatedAt: now() }).where(eq(deliverableGroups.parentId, group.id));
    await tx.delete(deliverableGroups).where(eq(deliverableGroups.id, group.id));
    await removeEmptyGroups(tx, ctx.card.id);
  });
  return finish(actor, ctx, fx);
}

/**
 * Moves deliverables and folders into a folder (or to the top level with `targetGroupId` null).
 * A folder never ends up inside itself. Folders left empty are removed.
 */
export async function moveToGroup(
  actor: Actor,
  input: { cardId: string; deliverableIds?: string[]; groupIds?: string[]; targetGroupId: string | null; positions?: NodeLayout[] },
): Promise<CardDetailDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", EDIT_MESSAGE);
  const deliverableIds = unique(input.deliverableIds);
  const groupIds = unique(input.groupIds);
  if (!deliverableIds.length && !groupIds.length) throw invalid("Nothing to move.");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const groups = foldersById(await tx.select().from(deliverableGroups).where(eq(deliverableGroups.cardId, ctx.card.id)));
    const target = input.targetGroupId ?? null;
    if (target && !groups.has(target)) throw notFound("Folder");
    await assertMembers(tx, ctx.card.id, deliverableIds, groupIds, groups);
    for (const id of groupIds) if (folderContains(groups, id, target)) throw conflict("A folder can't be moved inside itself.");
    if (deliverableIds.length) await tx.update(deliverables).set({ groupId: target }).where(inArray(deliverables.id, deliverableIds));
    if (groupIds.length) await tx.update(deliverableGroups).set({ parentId: target, updatedAt: now() }).where(inArray(deliverableGroups.id, groupIds));
    if (input.positions?.length) await applyLayout(tx, ctx.card.id, input.positions);
    await removeEmptyGroups(tx, ctx.card.id);
  });
  return finish(actor, ctx, fx);
}
