import { and, asc, eq, max, sql } from "drizzle-orm";
import { positionBetween, resolveInsertIndex } from "@/lib/positions";
import type { CardDetailDTO } from "@/lib/types";
import { assertCard, requireCard } from "../access";
import { now } from "../clock";
import { db } from "../db";
import { checklistItems, checklists } from "../db/schema";
import { invalid, notFound } from "../errors";
import { logActivity } from "./activity";
import { loadCardDetail } from "./card-dto";
import { touchCard } from "./cards";
import type { Actor } from "./context";
import { Effects } from "./effects";

async function editableCard(actor: Actor, cardId: string) {
  const ctx = await requireCard(actor.userId, cardId);
  assertCard(ctx.perms, "canEdit");
  return ctx;
}

async function finish(actor: Actor, ctx: Awaited<ReturnType<typeof editableCard>>): Promise<CardDetailDTO> {
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
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

export async function addChecklistItem(actor: Actor, input: { checklistId: string; text: string }) {
  const list = await loadList(input.checklistId);
  const ctx = await editableCard(actor, list.cardId);
  const text = input.text.trim();
  if (!text) throw invalid("Checklist items need some text.");
  const [agg] = await db.select({ value: max(checklistItems.position) }).from(checklistItems).where(eq(checklistItems.checklistId, list.id));
  await db.insert(checklistItems).values({ checklistId: list.id, cardId: list.cardId, text, position: positionBetween(agg?.value ?? null, null)! });
  return finish(actor, ctx);
}

export async function updateChecklistItem(
  actor: Actor,
  input: { itemId: string; text?: string; isDone?: boolean },
): Promise<CardDetailDTO> {
  const item = await loadItem(input.itemId);
  const ctx = await editableCard(actor, item.cardId);
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
    if (Object.keys(patch).length === 0) return;
    await tx.update(checklistItems).set(patch).where(eq(checklistItems.id, item.id));
    if (patch.isDone) {
      // Log only when a whole checklist is completed, to keep history readable.
      const [remaining] = await tx
        .select({ value: sql<number>`count(*) filter (where not ${checklistItems.isDone})`.mapWith(Number) })
        .from(checklistItems)
        .where(eq(checklistItems.checklistId, item.checklistId));
      if ((remaining?.value ?? 1) === 0) {
        const list = await loadList(item.checklistId);
        await logActivity(tx, {
          studioId: ctx.access.studioId,
          projectId: ctx.card.projectId,
          cardId: ctx.card.id,
          actorId: actor.userId,
          type: "checklist.completed",
          data: { checklistTitle: list.title },
        });
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
