import { and, asc, eq, max, sql } from "drizzle-orm";
import { canTakeChecklistItems, canTickChecklistItem } from "@/lib/checklist";
import { positionBetween, resolveInsertIndex } from "@/lib/positions";
import type { CardDetailDTO, MemberDTO } from "@/lib/types";
import { assertCard, requireCard, type CardAccess, type ProjectRow } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { checklistItems, checklists } from "../db/schema";
import { forbidden, invalid, notFound } from "../errors";
import { logActivity } from "./activity";
import { loadCardDetail } from "./card-dto";
import { touchCard } from "./cards";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { listProjectMembers } from "./members-query";

async function editableCard(actor: Actor, cardId: string) {
  const ctx = await requireCard(actor.userId, cardId);
  assertCard(ctx.perms, "canEdit");
  return ctx;
}

async function finish(actor: Actor, ctx: CardAccess): Promise<CardDetailDTO> {
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}

/** People a checklist item can be given to: project members who can work on cards (not Viewers). */
export async function checklistAssignees(project: ProjectRow, ex: Executor = db): Promise<MemberDTO[]> {
  return (await listProjectMembers(project, ex)).filter((m) => canTakeChecklistItems(m.role));
}

async function assertAssignee(ctx: CardAccess, userId: string | null | undefined, ex: Executor = db) {
  if (!userId) return;
  if (!(await checklistAssignees(ctx.access.project, ex)).some((m) => m.id === userId)) {
    throw invalid("Items can be given only to project members who can work on cards.");
  }
}

/** A due day as "YYYY-MM-DD" (a real calendar date), or null to clear it. */
export function normalizeDueOn(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!d || d.toISOString().slice(0, 10) !== value || Number(match![1]) < 2000 || Number(match![1]) > 2100) throw invalid("Choose a valid due date.");
  return value;
}

/** Whether this person may tick an item: anyone who can edit the card, or the item's own assignee (who can work on the card). */
export function canTickItem(ctx: Pick<CardAccess, "perms">, item: { assigneeId: string | null }, userId: string) {
  return canTickChecklistItem(ctx.perms, item, userId);
}

export async function createChecklist(actor: Actor, input: { cardId: string; title: string; items?: string[] }) {
  const ctx = await editableCard(actor, input.cardId);
  await db.transaction(async (tx) => {
    const [agg] = await tx.select({ value: max(checklists.position) }).from(checklists).where(eq(checklists.cardId, ctx.card.id));
    const [list] = await tx
      .insert(checklists)
      .values({ cardId: ctx.card.id, title: input.title.trim() || "Checklist", position: positionBetween(agg?.value ?? null, null)! })
      .returning();
    const items = (input.items ?? []).map((t) => t.trim()).filter(Boolean);
    if (items.length) {
      await tx.insert(checklistItems).values(items.map((text, i) => ({ checklistId: list!.id, cardId: ctx.card.id, text, position: (i + 1) * 1024 })));
    }
    await touchCard(tx, ctx.card.id, actor.userId, false);
  });
  return finish(actor, ctx);
}

async function loadList(checklistId: string) {
  const [list] = await db.select().from(checklists).where(eq(checklists.id, checklistId));
  if (!list) throw notFound("Checklist");
  return list;
}

async function loadItem(itemId: string) {
  const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) throw notFound("Checklist item");
  return item;
}

export async function renameChecklist(actor: Actor, input: { checklistId: string; title: string }) {
  const list = await loadList(input.checklistId);
  const ctx = await editableCard(actor, list.cardId);
  await db.update(checklists).set({ title: input.title.trim() || "Checklist" }).where(eq(checklists.id, list.id));
  return finish(actor, ctx);
}

export async function deleteChecklist(actor: Actor, input: { checklistId: string }) {
  const list = await loadList(input.checklistId);
  const ctx = await editableCard(actor, list.cardId);
  await db.delete(checklists).where(eq(checklists.id, list.id));
  return finish(actor, ctx);
}

/**
 * Adds items to a checklist of a card — the given one, else the card's first, else a new
 * "Checklist" — optionally all for one person and due on one day. Used by the card and by Discord.
 */
export async function addChecklistItems(
  actor: Actor,
  input: { cardId: string; checklistId?: string | null; texts: string[]; assigneeId?: string | null; dueOn?: string | null },
): Promise<{ ctx: CardAccess; checklist: { id: string; title: string }; added: number }> {
  const ctx = await editableCard(actor, input.cardId);
  const texts = input.texts.map((t) => t.trim().slice(0, 500)).filter(Boolean);
  if (!texts.length) throw invalid("Checklist items need some text.");
  if (texts.length > 50) throw invalid("Add at most 50 items at once.");
  const dueOn = normalizeDueOn(input.dueOn);
  await assertAssignee(ctx, input.assigneeId);
  const checklist = await db.transaction(async (tx) => {
    let list: { id: string; title: string } | undefined;
    if (input.checklistId) {
      [list] = await tx.select({ id: checklists.id, title: checklists.title }).from(checklists).where(and(eq(checklists.id, input.checklistId), eq(checklists.cardId, ctx.card.id)));
      if (!list) throw notFound("Checklist");
    } else {
      [list] = await tx.select({ id: checklists.id, title: checklists.title }).from(checklists).where(eq(checklists.cardId, ctx.card.id)).orderBy(asc(checklists.position)).limit(1);
      if (!list) [list] = await tx.insert(checklists).values({ cardId: ctx.card.id, title: "Checklist", position: 1024 }).returning({ id: checklists.id, title: checklists.title });
    }
    const [agg] = await tx.select({ value: max(checklistItems.position) }).from(checklistItems).where(eq(checklistItems.checklistId, list!.id));
    let position = agg?.value ?? null;
    for (const text of texts) {
      position = positionBetween(position, null)!;
      await tx.insert(checklistItems).values({ checklistId: list!.id, cardId: ctx.card.id, text, position, assigneeId: input.assigneeId ?? null, dueOn });
      const base = { studioId: ctx.access.studioId, projectId: ctx.card.projectId, cardId: ctx.card.id, actorId: actor.userId };
      if (input.assigneeId) await logActivity(tx, { ...base, type: "checklist.item_assigned", data: { item: text, userId: input.assigneeId } });
      if (dueOn) await logActivity(tx, { ...base, type: "checklist.item_due", data: { item: text, to: dueOn } });
    }
    await touchCard(tx, ctx.card.id, actor.userId, false);
    return list!;
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return { ctx, checklist, added: texts.length };
}

export async function addChecklistItem(actor: Actor, input: { checklistId: string; text: string; assigneeId?: string | null; dueOn?: string | null }) {
  const list = await loadList(input.checklistId);
  const { ctx } = await addChecklistItems(actor, { cardId: list.cardId, checklistId: list.id, texts: [input.text], assigneeId: input.assigneeId, dueOn: input.dueOn });
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}

/**
 * Changes an item. Its text, person and due day need card edit rights; ticking it off also works
 * for the person it's given to.
 */
export async function updateChecklistItem(
  actor: Actor,
  input: { itemId: string; text?: string; isDone?: boolean; assigneeId?: string | null; dueOn?: string | null },
): Promise<CardDetailDTO> {
  const item = await loadItem(input.itemId);
  const ctx = await requireCard(actor.userId, item.cardId);
  const edits = input.text !== undefined || input.assigneeId !== undefined || input.dueOn !== undefined;
  if (edits) assertCard(ctx.perms, "canEdit");
  else if (input.isDone !== undefined && !canTickItem(ctx, item, actor.userId)) throw forbidden("You can tick off only items given to you, unless you can edit this card.");
  if (input.assigneeId !== undefined) await assertAssignee(ctx, input.assigneeId);
  const dueOn = input.dueOn !== undefined ? normalizeDueOn(input.dueOn) : undefined;
  await db.transaction(async (tx) => {
    const patch: Partial<typeof checklistItems.$inferInsert> = {};
    if (input.text !== undefined) {
      if (!input.text.trim()) throw invalid("Checklist items need some text.");
      patch.text = input.text.trim();
    }
    if (input.isDone !== undefined && input.isDone !== item.isDone) {
      patch.isDone = input.isDone;
      patch.doneAt = input.isDone ? now() : null;
      patch.doneById = input.isDone ? actor.userId : null;
    }
    if (input.assigneeId !== undefined && input.assigneeId !== item.assigneeId) patch.assigneeId = input.assigneeId;
    if (dueOn !== undefined && dueOn !== item.dueOn) patch.dueOn = dueOn;
    if (Object.keys(patch).length === 0) return;
    await tx.update(checklistItems).set(patch).where(eq(checklistItems.id, item.id));
    const base = { studioId: ctx.access.studioId, projectId: ctx.card.projectId, cardId: ctx.card.id, actorId: actor.userId };
    const label = patch.text ?? item.text;
    if (patch.assigneeId !== undefined) await logActivity(tx, { ...base, type: "checklist.item_assigned", data: { item: label, userId: patch.assigneeId } });
    if (patch.dueOn !== undefined) await logActivity(tx, { ...base, type: "checklist.item_due", data: { item: label, to: patch.dueOn } });
    // Ticking someone's item off is worth recording; other ticks only when a whole list is done.
    if (patch.isDone && item.assigneeId) await logActivity(tx, { ...base, type: "checklist.item_done", data: { item: label, userId: item.assigneeId } });
    if (patch.isDone) {
      const [remaining] = await tx
        .select({ value: sql<number>`count(*) filter (where not ${checklistItems.isDone})`.mapWith(Number) })
        .from(checklistItems)
        .where(eq(checklistItems.checklistId, item.checklistId));
      if ((remaining?.value ?? 1) === 0) {
        const list = await loadList(item.checklistId);
        await logActivity(tx, { ...base, type: "checklist.completed", data: { checklistTitle: list.title } });
      }
    }
    await touchCard(tx, ctx.card.id, actor.userId, false);
  });
  return finish(actor, ctx);
}

export async function moveChecklistItem(actor: Actor, input: { itemId: string; index: number }) {
  const item = await loadItem(input.itemId);
  const ctx = await editableCard(actor, item.cardId);
  const siblings = (
    await db.select().from(checklistItems).where(eq(checklistItems.checklistId, item.checklistId)).orderBy(asc(checklistItems.position))
  ).filter((i) => i.id !== item.id);
  const index = resolveInsertIndex(siblings, { index: input.index });
  let position = positionBetween(siblings[index - 1]?.position, siblings[index]?.position);
  if (position === null) {
    for (let i = 0; i < siblings.length; i++) {
      await db.update(checklistItems).set({ position: (i + 1) * 1024 }).where(eq(checklistItems.id, siblings[i]!.id));
    }
    position = index * 1024 + 512;
  }
  await db.update(checklistItems).set({ position }).where(eq(checklistItems.id, item.id));
  return finish(actor, ctx);
}

export async function deleteChecklistItem(actor: Actor, input: { itemId: string }) {
  const item = await loadItem(input.itemId);
  const ctx = await editableCard(actor, item.cardId);
  await db.delete(checklistItems).where(and(eq(checklistItems.id, item.id)));
  return finish(actor, ctx);
}
