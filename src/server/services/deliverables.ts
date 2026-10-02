import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { rollupState, wouldCreateCycle } from "@/lib/deliverables";
import { positionBetween, POSITION_GAP } from "@/lib/positions";
import type { CardDetailDTO, DeliverableLinkType } from "@/lib/types";
import { assertCard, requireCard, requireDeliverable, type CardAccess, type CardRow } from "../access";
import { now } from "../clock";
import { db, type Executor, type Tx } from "../db";
import { attachments, cards, deliverableLinks, deliverables } from "../db/schema";
import { conflict, invalid, notFound } from "../errors";
import { logActivity } from "./activity";
import { loadCardDetail } from "./card-dto";
import { touchCard } from "./cards";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { filterProjectMembers } from "./members-query";

const VISUAL_KINDS = ["IMAGE", "VIDEO", "AUDIO", "ROBLOX"] as const;
/** What someone can choose (or upload) as a card's cover. */
export const COVER_KINDS = ["IMAGE", "VIDEO"] as const;

// ── Derived state ───────────────────────────────────────────────────────────

/** The file shown for a deliverable: first previewable file of its current revision, else its newest. */
export async function recomputeDeliverableCover(tx: Executor, deliverableId: string) {
  const [d] = await tx.select({ currentVersionId: deliverables.currentVersionId }).from(deliverables).where(eq(deliverables.id, deliverableId));
  if (!d) return;
  const base = and(
    eq(attachments.deliverableId, deliverableId),
    eq(attachments.purpose, "VERSION"),
    isNull(attachments.archivedAt),
    inArray(attachments.kind, [...VISUAL_KINDS]),
    inArray(attachments.status, ["READY", "PROCESSING"]),
  );
  let cover: { id: string } | undefined;
  if (d.currentVersionId) {
    [cover] = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(base, eq(attachments.versionId, d.currentVersionId)))
      .orderBy(sql`case when ${attachments.thumbnailKey} is null then 1 else 0 end`, asc(attachments.createdAt))
      .limit(1);
  }
  if (!cover) {
    [cover] = await tx.select({ id: attachments.id }).from(attachments).where(base).orderBy(desc(attachments.createdAt)).limit(1);
  }
  await tx.update(deliverables).set({ coverAttachmentId: cover?.id ?? null }).where(eq(deliverables.id, deliverableId));
}

/**
 * Re-derives the card's review roll-up and board cover from its deliverables.
 * Call after anything that changes a deliverable's state, files, requirement or existence.
 * The cover follows the card's coverMode: a chosen (MANUAL) cover is kept through new
 * revisions, processing and review changes, and only falls back to the automatic one while it
 * can't be shown (removed or failed); NONE shows no cover.
 */
export async function recomputeCardRollup(tx: Executor, cardId: string) {
  const rows = await tx
    .select({ state: deliverables.state, required: deliverables.required, archivedAt: deliverables.archivedAt, cover: deliverables.coverAttachmentId })
    .from(deliverables)
    .where(eq(deliverables.cardId, cardId))
    .orderBy(asc(deliverables.position), asc(deliverables.number));
  const state = rollupState(rows.map((r) => ({ state: r.state, required: r.required, archived: Boolean(r.archivedAt) })));
  let cover = rows.find((r) => !r.archivedAt && r.cover)?.cover ?? null;
  if (!cover) {
    const [loose] = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.cardId, cardId),
          eq(attachments.purpose, "CARD"),
          isNull(attachments.archivedAt),
          inArray(attachments.kind, ["IMAGE", "VIDEO"]),
          inArray(attachments.status, ["READY", "PROCESSING"]),
        ),
      )
      .orderBy(desc(attachments.createdAt))
      .limit(1);
    cover = loose?.id ?? null;
  }
  const [card] = await tx
    .select({ state: cards.state, cover: cards.coverAttachmentId, coverMode: cards.coverMode, coverPinnedId: cards.coverPinnedId })
    .from(cards)
    .where(eq(cards.id, cardId));
  if (!card) return state;
  if (card.coverMode === "NONE") cover = null;
  else if (card.coverMode === "MANUAL" && card.coverPinnedId) {
    // A chosen cover wins over the automatic one while it's usable (still on this card, not removed, not failed).
    const [pinned] = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.id, card.coverPinnedId),
          eq(attachments.cardId, cardId),
          isNull(attachments.archivedAt),
          inArray(attachments.kind, [...COVER_KINDS]),
          inArray(attachments.status, ["READY", "PROCESSING"]),
        ),
      );
    if (pinned) cover = pinned.id;
  }
  if (card.state === state && card.cover === cover) return state;
  await tx.update(cards).set({ state, coverAttachmentId: cover, revision: sql`${cards.revision} + 1` }).where(eq(cards.id, cardId));
  return state;
}

async function nextNumber(tx: Executor, cardId: string) {
  const [agg] = await tx.select({ value: max(deliverables.number) }).from(deliverables).where(eq(deliverables.cardId, cardId));
  return (agg?.value ?? 0) + 1;
}

/** Every card starts with one deliverable, named after the card. */
export async function createPrimaryDeliverable(tx: Tx, card: Pick<CardRow, "id" | "projectId" | "title" | "createdById">, actorId: string) {
  const [row] = await tx
    .insert(deliverables)
    .values({
      cardId: card.id,
      projectId: card.projectId,
      number: 1,
      name: card.title,
      position: POSITION_GAP,
      canvasX: 0,
      canvasY: 0,
      createdById: actorId ?? card.createdById,
      createdAt: now(),
    })
    .returning();
  return row!;
}

async function detail(actor: Actor, cardId: string): Promise<CardDetailDTO> {
  return loadCardDetail(await requireCard(actor.userId, cardId));
}

async function assertPeople(ctx: CardAccess, actorId: string, input: { ownerId?: string | null; reviewerId?: string | null }, ex: Executor) {
  for (const key of ["ownerId", "reviewerId"] as const) {
    const id = input[key];
    if (!id) continue;
    const valid = await filterProjectMembers(ctx.access.project, [id], ex);
    if (!valid.length) throw invalid("That person isn't a member of this project.");
    const selfAssign = key === "ownerId" && id === actorId && ctx.perms.canSelfAssign;
    if (!ctx.perms.canAssign && !selfAssign) throw invalid("You don't have permission to assign people.");
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export interface DeliverableInput {
  name?: string;
  description?: string;
  assetType?: string;
  required?: boolean;
  ownerId?: string | null;
  reviewerId?: string | null;
  dueAt?: string | null;
}

export async function createDeliverable(
  actor: Actor,
  input: DeliverableInput & { cardId: string; name: string; canvasX?: number; canvasY?: number; linkFrom?: { id: string; type: DeliverableLinkType } | null },
): Promise<CardDetailDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to add deliverables to this card.");
  const name = input.name.trim();
  if (!name) throw invalid("Give the deliverable a name.");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    await assertPeople(ctx, actor.userId, input, tx);
    const number = await nextNumber(tx, ctx.card.id);
    const [last] = await tx
      .select({ position: deliverables.position, x: deliverables.canvasX, y: deliverables.canvasY })
      .from(deliverables)
      .where(eq(deliverables.cardId, ctx.card.id))
      .orderBy(desc(deliverables.position))
      .limit(1);
    const [row] = await tx
      .insert(deliverables)
      .values({
        cardId: ctx.card.id,
        projectId: ctx.card.projectId,
        number,
        name,
        description: input.description?.trim() ?? "",
        assetType: input.assetType?.trim() ?? "",
        required: input.required ?? true,
        ownerId: input.ownerId ?? null,
        reviewerId: input.reviewerId ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        canvasX: input.canvasX ?? (last ? last.x + 300 : 0),
        canvasY: input.canvasY ?? (last ? last.y : 0),
        position: (last?.position ?? 0) + POSITION_GAP,
        createdById: actor.userId,
        createdAt: now(),
      })
      .returning();
    if (input.linkFrom) {
      const [source] = await tx
        .select({ id: deliverables.id })
        .from(deliverables)
        .where(and(eq(deliverables.id, input.linkFrom.id), eq(deliverables.cardId, ctx.card.id)));
      if (!source) throw notFound("Deliverable");
      await tx.insert(deliverableLinks).values({ cardId: ctx.card.id, fromId: source.id, toId: row!.id, type: input.linkFrom.type, createdById: actor.userId });
    }
    await recomputeCardRollup(tx, ctx.card.id);
    await touchCard(tx, ctx.card.id, actor.userId);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "deliverable.created",
      data: { deliverableId: row!.id, name, required: row!.required },
    });
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

export async function updateDeliverable(actor: Actor, input: DeliverableInput & { deliverableId: string }): Promise<CardDetailDTO> {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  const d = ctx.deliverable;
  if (d.archivedAt) throw conflict("This deliverable is archived. Restore it to make changes.");
  const onlyPeople = Object.keys(input).every((k) => k === "deliverableId" || k === "ownerId" || k === "reviewerId");
  if (!onlyPeople) assertCard(ctx.perms, "canEdit", "You don't have permission to edit this deliverable.");
  const patch: Partial<typeof deliverables.$inferInsert> = {};
  const changed: string[] = [];
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw invalid("Give the deliverable a name.");
    if (name !== d.name) {
      patch.name = name;
      changed.push("name");
    }
  }
  if (input.description !== undefined && input.description !== d.description) {
    patch.description = input.description;
    changed.push("description");
  }
  if (input.assetType !== undefined && input.assetType.trim() !== d.assetType) {
    patch.assetType = input.assetType.trim();
    changed.push("type");
  }
  if (input.required !== undefined && input.required !== d.required) {
    patch.required = input.required;
    changed.push(input.required ? "required" : "optional");
  }
  if (input.dueAt !== undefined && (input.dueAt ?? null) !== (d.dueAt?.toISOString() ?? null)) {
    patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
    changed.push("due date");
  }
  if (input.ownerId !== undefined && input.ownerId !== d.ownerId) {
    patch.ownerId = input.ownerId;
    changed.push("owner");
  }
  if (input.reviewerId !== undefined && input.reviewerId !== d.reviewerId) {
    patch.reviewerId = input.reviewerId;
    changed.push("reviewer");
  }
  if (!changed.length) return loadCardDetail(ctx);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    await assertPeople(ctx, actor.userId, { ownerId: patch.ownerId, reviewerId: patch.reviewerId }, tx);
    await tx.update(deliverables).set(patch).where(eq(deliverables.id, d.id));
    if (patch.required !== undefined) await recomputeCardRollup(tx, ctx.card.id);
    await touchCard(tx, ctx.card.id, actor.userId);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "deliverable.updated",
      data: { deliverableId: d.id, name: patch.name ?? d.name, changed, ownerId: patch.ownerId, reviewerId: patch.reviewerId },
    });
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

/** Archiving hides a deliverable from the card but keeps every revision, review and comment. */
export async function setDeliverableArchived(actor: Actor, input: { deliverableId: string; archived: boolean }): Promise<CardDetailDTO> {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to change this card's deliverables.");
  const d = ctx.deliverable;
  if (Boolean(d.archivedAt) === input.archived) return loadCardDetail(ctx);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    if (input.archived) {
      const [active] = await tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(deliverables)
        .where(and(eq(deliverables.cardId, ctx.card.id), isNull(deliverables.archivedAt), ne(deliverables.id, d.id)));
      if ((active?.n ?? 0) === 0) throw conflict("A card needs at least one deliverable. Archive the card instead.");
    }
    await tx
      .update(deliverables)
      .set(input.archived ? { archivedAt: now(), archivedById: actor.userId } : { archivedAt: null, archivedById: null })
      .where(eq(deliverables.id, d.id));
    await recomputeCardRollup(tx, ctx.card.id);
    await touchCard(tx, ctx.card.id, actor.userId);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: input.archived ? "deliverable.archived" : "deliverable.restored",
      data: { deliverableId: d.id, name: d.name },
    });
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

/** Persists canvas node positions (one call per drag, possibly several nodes). */
export async function layoutDeliverables(actor: Actor, input: { cardId: string; positions: Array<{ id: string; x: number; y: number }> }) {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to arrange this card's deliverables.");
  const ids = input.positions.map((p) => p.id);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: deliverables.id })
      .from(deliverables)
      .where(and(eq(deliverables.cardId, ctx.card.id), inArray(deliverables.id, ids)));
    if (owned.length !== new Set(ids).size) throw notFound("Deliverable");
    for (const p of input.positions) {
      await tx
        .update(deliverables)
        .set({ canvasX: Math.round(p.x * 10) / 10, canvasY: Math.round(p.y * 10) / 10 })
        .where(eq(deliverables.id, p.id));
    }
    fx.card(ctx.card.projectId, ctx.card.id, false);
  });
  fx.flush(actor.clientId);
  return { ok: true };
}

/** List-view ordering. */
export async function moveDeliverable(actor: Actor, input: { deliverableId: string; beforeId?: string | null; afterId?: string | null }) {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  assertCard(ctx.perms, "canEdit");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const siblings = await tx
      .select({ id: deliverables.id, position: deliverables.position })
      .from(deliverables)
      .where(and(eq(deliverables.cardId, ctx.card.id), ne(deliverables.id, ctx.deliverable.id)))
      .orderBy(asc(deliverables.position));
    const after = input.afterId ? siblings.find((s) => s.id === input.afterId) : undefined;
    const before = input.beforeId ? siblings.find((s) => s.id === input.beforeId) : undefined;
    if ((input.afterId && !after) || (input.beforeId && !before)) throw notFound("Deliverable");
    let position: number | null;
    if (after) position = positionBetween(after.position, siblings[siblings.indexOf(after) + 1]?.position ?? null);
    else if (before) position = positionBetween(siblings[siblings.indexOf(before) - 1]?.position ?? null, before.position);
    else position = (siblings.at(-1)?.position ?? 0) + POSITION_GAP;
    if (position === null) {
      // Out of room between neighbours: re-space everything, then retry once.
      const ordered = [...siblings];
      const index = after ? ordered.indexOf(after) + 1 : before ? ordered.indexOf(before) : ordered.length;
      ordered.splice(index, 0, { id: ctx.deliverable.id, position: 0 });
      for (const [i, s] of ordered.entries()) await tx.update(deliverables).set({ position: (i + 1) * POSITION_GAP }).where(eq(deliverables.id, s.id));
    } else {
      await tx.update(deliverables).set({ position }).where(eq(deliverables.id, ctx.deliverable.id));
    }
    fx.card(ctx.card.projectId, ctx.card.id, false);
  });
  fx.flush(actor.clientId);
  return { ok: true };
}

// ── Relationships ───────────────────────────────────────────────────────────

export async function linkDeliverables(
  actor: Actor,
  input: { cardId: string; fromId: string; toId: string; type: DeliverableLinkType; note?: string },
): Promise<CardDetailDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to connect this card's deliverables.");
  if (input.fromId === input.toId) throw invalid("A deliverable can't be connected to itself.");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const pair = await tx
      .select({ id: deliverables.id, name: deliverables.name, archivedAt: deliverables.archivedAt })
      .from(deliverables)
      .where(and(eq(deliverables.cardId, ctx.card.id), inArray(deliverables.id, [input.fromId, input.toId])));
    if (pair.length !== 2) throw notFound("Deliverable");
    if (pair.some((p) => p.archivedAt)) throw conflict("Archived deliverables can't be connected.");
    const existing = await tx.select().from(deliverableLinks).where(eq(deliverableLinks.cardId, ctx.card.id));
    const samePair = existing.filter(
      (l) => (l.fromId === input.fromId && l.toId === input.toId) || (l.fromId === input.toId && l.toId === input.fromId),
    );
    if (samePair.some((l) => l.type === input.type && (input.type === "ASSOCIATION" || l.fromId === input.fromId))) {
      throw conflict("These deliverables are already connected that way.");
    }
    if (input.type === "DEPENDENCY" && wouldCreateCycle(existing, input.fromId, input.toId)) {
      const from = pair.find((p) => p.id === input.fromId)!.name;
      const to = pair.find((p) => p.id === input.toId)!.name;
      throw conflict(`That would create a loop: ${from} already depends on ${to} (directly or through other deliverables).`);
    }
    await tx.insert(deliverableLinks).values({
      cardId: ctx.card.id,
      fromId: input.fromId,
      toId: input.toId,
      type: input.type,
      note: input.note?.trim() ?? "",
      createdById: actor.userId,
    });
    await touchCard(tx, ctx.card.id, actor.userId);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "deliverable.linked",
      data: {
        type: input.type,
        from: pair.find((p) => p.id === input.fromId)!.name,
        to: pair.find((p) => p.id === input.toId)!.name,
      },
    });
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

export async function updateLink(actor: Actor, input: { linkId: string; note?: string; reverse?: boolean }): Promise<CardDetailDTO> {
  const [link] = await db.select().from(deliverableLinks).where(eq(deliverableLinks.id, input.linkId));
  if (!link) throw notFound("Connection");
  const ctx = await requireCard(actor.userId, link.cardId).catch(() => {
    throw notFound("Connection");
  });
  assertCard(ctx.perms, "canEdit");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const patch: Partial<typeof deliverableLinks.$inferInsert> = {};
    if (input.note !== undefined) patch.note = input.note.trim();
    if (input.reverse) {
      if (link.type === "DEPENDENCY") {
        const others = (await tx.select().from(deliverableLinks).where(eq(deliverableLinks.cardId, link.cardId))).filter((l) => l.id !== link.id);
        if (wouldCreateCycle(others, link.toId, link.fromId)) throw conflict("Reversing this dependency would create a loop.");
      }
      patch.fromId = link.toId;
      patch.toId = link.fromId;
    }
    await tx.update(deliverableLinks).set(patch).where(eq(deliverableLinks.id, link.id));
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

/** Removing a connection never touches either deliverable's work or history. */
export async function unlinkDeliverables(actor: Actor, input: { linkId: string }): Promise<CardDetailDTO> {
  const [link] = await db.select().from(deliverableLinks).where(eq(deliverableLinks.id, input.linkId));
  if (!link) throw notFound("Connection");
  const ctx = await requireCard(actor.userId, link.cardId).catch(() => {
    throw notFound("Connection");
  });
  assertCard(ctx.perms, "canEdit");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const names = await tx.select({ id: deliverables.id, name: deliverables.name }).from(deliverables).where(inArray(deliverables.id, [link.fromId, link.toId]));
    await tx.delete(deliverableLinks).where(eq(deliverableLinks.id, link.id));
    await touchCard(tx, ctx.card.id, actor.userId);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "deliverable.unlinked",
      data: { type: link.type, from: names.find((n) => n.id === link.fromId)?.name, to: names.find((n) => n.id === link.toId)?.name },
    });
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}
