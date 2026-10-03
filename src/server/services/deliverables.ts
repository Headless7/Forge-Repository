import { and, asc, desc, eq, inArray, isNull, max, ne, or, sql } from "drizzle-orm";
import { clampSize, DEFAULT_FROM_POINT, DEFAULT_TO_POINT, isValidPoint, NODE_DEFAULT, nodeSize, remapPoint } from "@/lib/canvas-points";
import { deliverableTeam, rollupState, wouldCreateCycle } from "@/lib/deliverables";
import { roleHas } from "@/lib/permissions";
import { positionBetween, POSITION_GAP } from "@/lib/positions";
import type { CardDetailDTO, DeliverableLinkType } from "@/lib/types";
import { assertCard, loadContributors, requireCard, requireDeliverable, type CardAccess, type CardRow } from "../access";
import { now } from "../clock";
import { db, type Executor, type Tx } from "../db";
import { attachments, cards, deliverableContributors, deliverableLinks, deliverables } from "../db/schema";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { logActivity } from "./activity";
import { loadCardDetail } from "./card-dto";
import { cardNotificationData, touchCard } from "./cards";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { listProjectMembers } from "./members-query";
import { inboxAudience, NotificationBatch } from "./notifications";
import { addDependencyNotifications, dependencyChanges, loadCardWork, type CardWork } from "./workflow";

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

interface People {
  ownerId: string | null;
  contributorIds: string[];
  reviewerId: string | null;
}

/**
 * Checks a change to who works on / reviews a deliverable. People who work on it must be able to
 * upload in this project (a viewer can't), a reviewer must be able to review, and nobody reviews
 * their own work unless the project allows it. Putting others on (or taking them off) needs the
 * assign permission; anyone who can create cards may put themselves on or take themselves off.
 */
async function assertPeople(ctx: CardAccess, actorId: string, before: People, next: People, ex: Executor) {
  const workersBefore = new Set([before.ownerId, ...before.contributorIds].filter(Boolean) as string[]);
  const workersNext = new Set([next.ownerId, ...next.contributorIds].filter(Boolean) as string[]);
  const added = [...workersNext].filter((id) => !workersBefore.has(id));
  const removed = [...workersBefore].filter((id) => !workersNext.has(id));
  const ownerChanged = before.ownerId !== next.ownerId;
  const reviewerChanged = before.reviewerId !== next.reviewerId;
  if (!added.length && !removed.length && !ownerChanged && !reviewerChanged) return;

  const team = new Map((await listProjectMembers(ctx.access.project, ex)).map((m) => [m.id, m]));
  for (const id of added) {
    const m = team.get(id);
    if (!m) throw invalid("That person isn't a member of this project.");
    if (!roleHas(m.role, "attachment.upload")) throw invalid(`${m.displayName} can only view this project, so they can't work on deliverables.`);
  }
  if (reviewerChanged && next.reviewerId) {
    const m = team.get(next.reviewerId);
    if (!m) throw invalid("That person isn't a member of this project.");
    if (!roleHas(m.role, "card.review")) throw invalid(`${m.displayName} can't review work in this project.`);
  }
  if (next.reviewerId && workersNext.has(next.reviewerId) && !ctx.access.project.settings.allowSelfApproval) {
    throw invalid("The reviewer can't also work on this deliverable: this project doesn't allow approving your own work.");
  }
  const othersTouched = [...added, ...removed].some((id) => id !== actorId) || (ownerChanged && [before.ownerId, next.ownerId].some((id) => id && id !== actorId));
  if ((othersTouched || reviewerChanged) && !ctx.perms.canAssign) throw forbidden("Only managers can assign other people.");
  if (!ctx.perms.canAssign && !ctx.perms.canSelfAssign) throw forbidden("You don't have permission to take on work in this project.");
}

/** Who to tell about a change to a deliverable's people, reviewer and deadline. */
function addPeopleNotifications(
  batch: NotificationBatch,
  before: People & { dueAt: Date | null },
  next: People & { dueAt: Date | null },
  base: { actorId: string; studioId: string; projectId: string; cardId: string; deliverableId: string; data: Record<string, unknown> },
  team: string[],
) {
  const { data, ...where } = base;
  const workersBefore = new Set([before.ownerId, ...before.contributorIds].filter(Boolean) as string[]);
  if (next.ownerId && next.ownerId !== before.ownerId) batch.add({ ...where, recipientIds: [next.ownerId], type: "ASSIGNED", data: { ...data, role: "responsible" } });
  const newContributors = next.contributorIds.filter((id) => !workersBefore.has(id) && id !== next.ownerId);
  if (newContributors.length) batch.add({ ...where, recipientIds: newContributors, type: "ASSIGNED", data: { ...data, role: "contributor" } });
  const stillOn = new Set([next.ownerId, ...next.contributorIds].filter(Boolean) as string[]);
  const takenOff = [...workersBefore].filter((id) => !stillOn.has(id));
  if (takenOff.length) batch.add({ ...where, recipientIds: takenOff, type: "UNASSIGNED", data });
  if (next.reviewerId && next.reviewerId !== before.reviewerId) batch.add({ ...where, recipientIds: [next.reviewerId], type: "REVIEWER_ASSIGNED", data: { ...data, role: "reviewer" } });
  if (before.reviewerId && before.reviewerId !== next.reviewerId) batch.add({ ...where, recipientIds: [before.reviewerId], type: "UNASSIGNED", data: { ...data, role: "reviewer" } });
  if ((before.dueAt?.getTime() ?? null) !== (next.dueAt?.getTime() ?? null)) {
    batch.add({ ...where, recipientIds: team, type: "DUE_CHANGED", data: { ...data, dueAt: next.dueAt?.toISOString() ?? null, previousDueAt: before.dueAt?.toISOString() ?? null } });
  }
}

/** Notifies the teams of deliverables a change made ready or made wait again. */
async function sendDependencyNotifications(tx: Executor, ctx: CardAccess, actorId: string, before: CardWork, ignore: string[] = []) {
  const after = await loadCardWork(tx, ctx.card.id);
  const changes = dependencyChanges(before, after, undefined, ignore);
  if (!changes.length) return [];
  const batch = new NotificationBatch();
  addDependencyNotifications(batch, after, changes, {
    actorId,
    studioId: ctx.access.studioId,
    projectId: ctx.card.projectId,
    cardId: ctx.card.id,
    cardData: cardNotificationData(ctx.access, ctx.card),
  });
  return batch.send(tx);
}

async function setContributors(tx: Executor, deliverableId: string, userIds: string[], actorId: string) {
  await tx.delete(deliverableContributors).where(eq(deliverableContributors.deliverableId, deliverableId));
  if (userIds.length) {
    await tx.insert(deliverableContributors).values(userIds.map((userId) => ({ deliverableId, userId, addedById: actorId, createdAt: now() }))).onConflictDoNothing();
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export interface DeliverableInput {
  name?: string;
  description?: string;
  assetType?: string;
  required?: boolean;
  ownerId?: string | null;
  /** Everyone working on it alongside the responsible person (replaces the current list). */
  contributorIds?: string[];
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
  const contributorIds = [...new Set(input.contributorIds ?? [])].filter((id) => id !== input.ownerId);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const none: People = { ownerId: null, contributorIds: [], reviewerId: null };
    const people: People = { ownerId: input.ownerId ?? null, contributorIds, reviewerId: input.reviewerId ?? null };
    await assertPeople(ctx, actor.userId, none, people, tx);
    const before = await loadCardWork(tx, ctx.card.id);
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
    await setContributors(tx, row!.id, contributorIds, actor.userId);
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
    const batch = new NotificationBatch();
    addPeopleNotifications(
      batch,
      { ...none, dueAt: row!.dueAt },
      { ...people, dueAt: row!.dueAt },
      { actorId: actor.userId, studioId: ctx.access.studioId, projectId: ctx.card.projectId, cardId: ctx.card.id, deliverableId: row!.id, data: { ...cardNotificationData(ctx.access, ctx.card), deliverable: name, deliverableNumber: number } },
      [],
    );
    fx.notify(await batch.send(tx));
    // A new deliverable only matters to dependants already on the card (it can't have any yet).
    fx.notify(await sendDependencyNotifications(tx, ctx, actor.userId, before, [row!.id]));
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

export async function updateDeliverable(actor: Actor, input: DeliverableInput & { deliverableId: string }): Promise<CardDetailDTO> {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  const d = ctx.deliverable;
  if (d.archivedAt) throw conflict("This deliverable is archived. Restore it to make changes.");
  const onlyPeople = Object.keys(input).every((k) => k === "deliverableId" || k === "ownerId" || k === "reviewerId" || k === "contributorIds");
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
  const nextOwner = patch.ownerId !== undefined ? patch.ownerId : d.ownerId;
  let contributorIds = ctx.contributorIds;
  if (input.contributorIds !== undefined) {
    const next = [...new Set(input.contributorIds)].filter((id) => id !== nextOwner);
    if (next.length !== ctx.contributorIds.length || next.some((id) => !ctx.contributorIds.includes(id))) {
      contributorIds = next;
      changed.push("contributors");
    }
  } else if (nextOwner && ctx.contributorIds.includes(nextOwner)) {
    // Becoming responsible replaces being a contributor.
    contributorIds = ctx.contributorIds.filter((id) => id !== nextOwner);
  }
  if (!changed.length) return loadCardDetail(ctx);
  const before: People & { dueAt: Date | null } = { ownerId: d.ownerId, contributorIds: ctx.contributorIds, reviewerId: d.reviewerId, dueAt: d.dueAt };
  const next: People & { dueAt: Date | null } = {
    ownerId: nextOwner ?? null,
    contributorIds,
    reviewerId: patch.reviewerId !== undefined ? (patch.reviewerId ?? null) : d.reviewerId,
    dueAt: patch.dueAt !== undefined ? (patch.dueAt ?? null) : d.dueAt,
  };
  const fx = new Effects();
  await db.transaction(async (tx) => {
    await assertPeople(ctx, actor.userId, before, next, tx);
    if (Object.keys(patch).length) await tx.update(deliverables).set(patch).where(eq(deliverables.id, d.id));
    if (contributorIds !== ctx.contributorIds) await setContributors(tx, d.id, contributorIds, actor.userId);
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
    const batch = new NotificationBatch();
    addPeopleNotifications(
      batch,
      before,
      next,
      {
        actorId: actor.userId,
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        deliverableId: d.id,
        data: { ...cardNotificationData(ctx.access, ctx.card), deliverable: patch.name ?? d.name, deliverableNumber: d.number },
      },
      deliverableTeam(next, ctx.assigneeIds).ids,
    );
    fx.notify(await batch.send(tx));
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
    const before = await loadCardWork(tx, ctx.card.id);
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
    const notified = await new NotificationBatch()
      .add({
        recipientIds: deliverableTeam({ ownerId: d.ownerId, contributorIds: ctx.contributorIds }, ctx.assigneeIds).ids,
        actorId: actor.userId,
        type: "WORK_ARCHIVED",
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        deliverableId: d.id,
        data: { ...cardNotificationData(ctx.access, ctx.card), deliverable: d.name, deliverableNumber: d.number, restored: !input.archived },
      })
      .send(tx);
    // Archiving an unfinished prerequisite frees what waits on it; restoring it blocks them again.
    fx.notify([...notified, ...(await sendDependencyNotifications(tx, ctx, actor.userId, before))]);
    // Only this deliverable's notifications leave or rejoin inboxes; the card's others stay.
    fx.notify(await inboxAudience(tx, { deliverableId: d.id }));
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

export interface NodeLayout {
  id: string;
  x?: number;
  y?: number;
  /** New size; null resets to the default. */
  w?: number | null;
  h?: number | null;
}

/**
 * Persists canvas layout (one call per drag or resize, possibly several nodes). Only the fields
 * sent are written, so two people arranging different nodes — or one moving a node while another
 * resizes it — never overwrite each other. When a node shrinks, arrows attached to a point it no
 * longer has move to the nearest point on the same side; the relationship itself never changes.
 */
export async function layoutDeliverables(actor: Actor, input: { cardId: string; positions: NodeLayout[] }) {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to arrange this card's deliverables.");
  const ids = input.positions.map((p) => p.id);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: deliverables.id, archivedAt: deliverables.archivedAt, canvasW: deliverables.canvasW, canvasH: deliverables.canvasH })
      .from(deliverables)
      .where(and(eq(deliverables.cardId, ctx.card.id), inArray(deliverables.id, ids)));
    if (owned.length !== new Set(ids).size) throw notFound("Deliverable");
    if (owned.some((d) => d.archivedAt)) throw conflict("Archived deliverables can't be moved or resized. Restore them first.");
    const resized: Array<{ id: string; size: { w: number; h: number } }> = [];
    for (const p of input.positions) {
      const patch: Partial<typeof deliverables.$inferInsert> = {};
      if (p.x !== undefined) patch.canvasX = Math.round(p.x * 10) / 10;
      if (p.y !== undefined) patch.canvasY = Math.round(p.y * 10) / 10;
      if (p.w !== undefined || p.h !== undefined) {
        const current = owned.find((d) => d.id === p.id)!;
        const w = p.w === undefined ? current.canvasW : p.w;
        const h = p.h === undefined ? current.canvasH : p.h;
        const size = clampSize(w ?? NODE_DEFAULT.w, h ?? NODE_DEFAULT.h);
        patch.canvasW = w === null ? null : size.w;
        patch.canvasH = h === null ? null : size.h;
        resized.push({ id: p.id, size: nodeSize({ canvasW: patch.canvasW, canvasH: patch.canvasH }) });
      }
      if (Object.keys(patch).length) await tx.update(deliverables).set(patch).where(eq(deliverables.id, p.id));
    }
    for (const { id, size } of resized) {
      const attached = await tx
        .select()
        .from(deliverableLinks)
        .where(and(eq(deliverableLinks.cardId, ctx.card.id), or(eq(deliverableLinks.fromId, id), eq(deliverableLinks.toId, id))));
      for (const l of attached) {
        const patch: Partial<typeof deliverableLinks.$inferInsert> = {};
        if (l.fromId === id && l.fromPoint) {
          const next = remapPoint(l.fromPoint, size, DEFAULT_FROM_POINT);
          if (next !== l.fromPoint) patch.fromPoint = next;
        }
        if (l.toId === id && l.toPoint) {
          const next = remapPoint(l.toPoint, size, DEFAULT_TO_POINT);
          if (next !== l.toPoint) patch.toPoint = next;
        }
        if (Object.keys(patch).length) await tx.update(deliverableLinks).set(patch).where(eq(deliverableLinks.id, l.id));
      }
    }
    fx.card(ctx.card.projectId, ctx.card.id, false);
  });
  fx.flush(actor.clientId);
  return { ok: true };
}

/** An arrow end's point, valid for the node's current size (null keeps the default side). */
async function pointFor(ex: Executor, deliverableId: string, point: string | null | undefined, fallback: string): Promise<string | null> {
  if (!point) return null;
  if (!isValidPoint(point)) throw invalid("Unknown connection point.");
  const [d] = await ex.select({ canvasW: deliverables.canvasW, canvasH: deliverables.canvasH }).from(deliverables).where(eq(deliverables.id, deliverableId));
  return d ? remapPoint(point, nodeSize(d), fallback) : null;
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
  input: { cardId: string; fromId: string; toId: string; type: DeliverableLinkType; note?: string; fromPoint?: string | null; toPoint?: string | null },
): Promise<CardDetailDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to connect this card's deliverables.");
  if (input.fromId === input.toId) throw invalid("A deliverable can't be connected to itself.");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const before = await loadCardWork(tx, ctx.card.id);
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
      fromPoint: await pointFor(tx, input.fromId, input.fromPoint, DEFAULT_FROM_POINT),
      toPoint: await pointFor(tx, input.toId, input.toPoint, DEFAULT_TO_POINT),
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
    fx.notify(await sendDependencyNotifications(tx, ctx, actor.userId, before));
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

/**
 * Edits a connection: its note, its direction (reverse), or where its arrow attaches. Moving the
 * ends to other points of the same two deliverables never changes what the connection means.
 */
export async function updateLink(
  actor: Actor,
  input: { linkId: string; note?: string; reverse?: boolean; fromPoint?: string | null; toPoint?: string | null },
): Promise<CardDetailDTO> {
  const [link] = await db.select().from(deliverableLinks).where(eq(deliverableLinks.id, input.linkId));
  if (!link) throw notFound("Connection");
  const ctx = await requireCard(actor.userId, link.cardId).catch(() => {
    throw notFound("Connection");
  });
  assertCard(ctx.perms, "canEdit");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const before = await loadCardWork(tx, ctx.card.id);
    const patch: Partial<typeof deliverableLinks.$inferInsert> = {};
    if (input.note !== undefined) patch.note = input.note.trim();
    if (input.fromPoint !== undefined) patch.fromPoint = await pointFor(tx, link.fromId, input.fromPoint, DEFAULT_FROM_POINT);
    if (input.toPoint !== undefined) patch.toPoint = await pointFor(tx, link.toId, input.toPoint, DEFAULT_TO_POINT);
    if (input.reverse) {
      if (link.type === "DEPENDENCY") {
        const others = (await tx.select().from(deliverableLinks).where(eq(deliverableLinks.cardId, link.cardId))).filter((l) => l.id !== link.id);
        if (wouldCreateCycle(others, link.toId, link.fromId)) throw conflict("Reversing this dependency would create a loop.");
      }
      patch.fromId = link.toId;
      patch.toId = link.fromId;
      // The arrow keeps its attachment spots on each deliverable.
      patch.fromPoint = link.toPoint;
      patch.toPoint = link.fromPoint;
    }
    if (!Object.keys(patch).length) return;
    await tx.update(deliverableLinks).set(patch).where(eq(deliverableLinks.id, link.id));
    if (input.reverse) fx.notify(await sendDependencyNotifications(tx, ctx, actor.userId, before));
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
    const before = await loadCardWork(tx, ctx.card.id);
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
    fx.notify(await sendDependencyNotifications(tx, ctx, actor.userId, before));
    fx.card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}
