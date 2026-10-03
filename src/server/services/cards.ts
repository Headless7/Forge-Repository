import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { positionBetween, resolveInsertIndex, spacedPositions } from "@/lib/positions";
import type { CardDetailDTO, CardDisplayMode, CardLink, CardSummaryDTO, Priority } from "@/lib/types";
import {
  assertCard,
  assertProjectPermission,
  requireCard,
  requireProject,
  type CardRow,
  type ProjectAccess,
} from "../access";
import { now } from "../clock";
import { db, type Executor, type Tx } from "../db";
import {
  assetVersions,
  attachments,
  boardColumns,
  boards,
  cardAssignees,
  cardLabels,
  cardReviewers,
  cardViews,
  cardWatchers,
  cards,
  checklistItems,
  checklists,
  deliverableLinks,
  deliverables,
  labels,
  milestones,
  projects,
} from "../db/schema";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { storage } from "../storage";
import { audit, logActivity } from "./activity";
import { nextCardPosition } from "./board";
import { loadCardDetail, summarizeCards } from "./card-dto";
import type { Actor } from "./context";
import { createPrimaryDeliverable, recomputeCardRollup, recomputeDeliverableCover } from "./deliverables";
import { Effects } from "./effects";
import { filterProjectMembers } from "./members-query";
import { inboxAudience, notify, NotificationBatch } from "./notifications";
import { loadCardWork } from "./workflow";
import { purgeOne } from "./purge";
import { nextProductionPosition } from "./production";

async function summaryOf(card: CardRow, access: ProjectAccess): Promise<CardSummaryDTO> {
  const [summary] = await summarizeCards([card], access.userId, new Map([[card.projectId, access.project.key]]));
  return summary!;
}

async function nextCardNumber(tx: Executor, projectId: string): Promise<number> {
  const [row] = await tx
    .update(projects)
    .set({ cardCounter: sql`${projects.cardCounter} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ counter: projects.cardCounter });
  return row!.counter;
}

async function assertActiveColumn(tx: Executor, columnId: string, projectId: string) {
  const rows = await tx
    .select({ column: boardColumns, boardName: boards.name, boardArchivedAt: boards.archivedAt })
    .from(boardColumns)
    .innerJoin(boards, eq(boards.id, boardColumns.boardId))
    .where(and(eq(boardColumns.id, columnId), eq(boardColumns.projectId, projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Column");
  if (row.column.archivedAt) throw invalid("That column is archived. Restore it before adding cards.");
  if (row.boardArchivedAt) throw invalid(`The board “${row.boardName}” is archived. Restore it before adding cards.`);
  return { ...row.column, boardName: row.boardName };
}

export async function touchCard(tx: Executor, cardId: string, actorId: string, bumpRevision = true) {
  await tx
    .update(cards)
    .set({
      lastActivityAt: now(),
      lastActivityById: actorId,
      ...(bumpRevision ? { revision: sql`${cards.revision} + 1` } : {}),
    })
    .where(eq(cards.id, cardId));
}

export async function addWatchers(tx: Executor, cardId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  await tx
    .insert(cardWatchers)
    .values(userIds.map((userId) => ({ cardId, userId, createdAt: now() })))
    .onConflictDoNothing();
}

export async function watcherIds(tx: Executor, cardId: string): Promise<string[]> {
  const rows = await tx.select({ userId: cardWatchers.userId }).from(cardWatchers).where(eq(cardWatchers.cardId, cardId));
  return rows.map((r) => r.userId);
}

export function cardKey(access: ProjectAccess, card: Pick<CardRow, "number">) {
  return `${access.project.key}-${card.number}`;
}

export function cardNotificationData(access: ProjectAccess, card: Pick<CardRow, "number" | "title">) {
  return { cardKey: cardKey(access, card), cardTitle: card.title, projectName: access.project.name };
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateCardInput {
  projectId: string;
  columnId: string;
  title: string;
  where?: "top" | "bottom";
  description?: string;
  priority?: Priority;
  displayMode?: CardDisplayMode | null;
  startAt?: string | null;
  dueAt?: string | null;
  milestoneId?: string | null;
  assigneeIds?: string[];
  labelIds?: string[];
  /** Where the card lands in the production view's To-do stage. */
  productionWhere?: "top" | "bottom";
}

export async function createCard(actor: Actor, input: CreateCardInput): Promise<CardSummaryDTO> {
  const access = await requireProject(actor.userId, input.projectId, "card.create");
  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  const assigningOthers = assigneeIds.some((id) => id !== actor.userId);
  if (assigningOthers) assertProjectPermission(access, "card.assign");

  const fx = new Effects();
  const card = await db.transaction(async (tx) => {
    const column = await assertActiveColumn(tx, input.columnId, access.project.id);
    const number = await nextCardNumber(tx, access.project.id);
    const position = await nextCardPosition(column.id, tx, input.where ?? "bottom");
    const productionPosition = await nextProductionPosition(access.project.id, "TODO", tx, input.productionWhere ?? "bottom");
    if (input.milestoneId) await assertMilestone(tx, input.milestoneId, access.project.id);
    const createdAt = now();
    const [row] = await tx
      .insert(cards)
      .values({
        projectId: access.project.id,
        boardId: column.boardId,
        columnId: column.id,
        number,
        title: input.title.trim(),
        description: input.description ?? "",
        position,
        productionPosition,
        priority: input.priority ?? "NORMAL",
        displayMode: input.displayMode ?? null,
        startAt: input.startAt ? new Date(input.startAt) : null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        milestoneId: input.milestoneId ?? null,
        createdById: actor.userId,
        lastActivityAt: createdAt,
        lastActivityById: actor.userId,
        createdAt,
      })
      .returning();

    await createPrimaryDeliverable(tx, row!, actor.userId);

    const validAssignees = await filterProjectMembers(access.project, assigneeIds, tx);
    if (validAssignees.length) {
      await tx
        .insert(cardAssignees)
        .values(validAssignees.map((userId) => ({ cardId: row!.id, userId, assignedById: actor.userId, createdAt })));
    }
    const reviewers = await filterProjectMembers(access.project, access.project.settings.defaultReviewerIds ?? [], tx);
    if (reviewers.length) {
      await tx.insert(cardReviewers).values(reviewers.map((userId) => ({ cardId: row!.id, userId, createdAt })));
    }
    if (input.labelIds?.length) await replaceLabels(tx, row!.id, access.project.id, input.labelIds);
    await addWatchers(tx, row!.id, [actor.userId, ...validAssignees]);

    await logActivity(tx, {
      studioId: access.studioId,
      projectId: access.project.id,
      cardId: row!.id,
      actorId: actor.userId,
      type: "card.created",
      data: { columnId: column.id, columnName: column.name },
    });
    if (validAssignees.length) {
      fx.notify(
        await notify(tx, {
          recipientIds: validAssignees,
          actorId: actor.userId,
          type: "ASSIGNED",
          studioId: access.studioId,
          projectId: access.project.id,
          cardId: row!.id,
          data: cardNotificationData(access, row!),
        }),
      );
    }
    fx.card(access.project.id, row!.id);
    return row!;
  });
  fx.flush(actor.clientId);
  return summaryOf(card, access);
}

async function assertMilestone(tx: Executor, milestoneId: string, projectId: string) {
  const rows = await tx
    .select({ id: milestones.id })
    .from(milestones)
    .where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId)));
  if (!rows[0]) throw notFound("Milestone");
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function getCardDetail(actor: Actor, cardId: string): Promise<CardDetailDTO> {
  return loadCardDetail(await requireCard(actor.userId, cardId));
}

/** Resolves "UTD-42" style references inside a project. */
export async function findCardIdByNumber(actor: Actor, projectId: string, number: number): Promise<string> {
  await requireProject(actor.userId, projectId, "project.view");
  const rows = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
    .limit(1);
  if (!rows[0]) throw notFound("Card");
  return rows[0].id;
}

export async function markCardViewed(actor: Actor, cardId: string) {
  await requireCard(actor.userId, cardId);
  const viewedAt = now();
  await db
    .insert(cardViews)
    .values({ userId: actor.userId, cardId, lastViewedAt: viewedAt })
    .onConflictDoUpdate({ target: [cardViews.userId, cardViews.cardId], set: { lastViewedAt: viewedAt } });
  return { ok: true };
}

// ── Update ──────────────────────────────────────────────────────────────────

export interface UpdateCardInput {
  cardId: string;
  title?: string;
  description?: string;
  priority?: Priority;
  startAt?: string | null;
  dueAt?: string | null;
  milestoneId?: string | null;
  displayMode?: CardDisplayMode | null;
  estimateHours?: number | null;
  links?: CardLink[];
  /** Values the editor started from; a mismatch means someone else edited meanwhile. */
  base?: { title?: string; description?: string };
}

export async function updateCard(actor: Actor, input: UpdateCardInput): Promise<CardDetailDTO> {
  const { card, access, perms } = await requireCard(actor.userId, input.cardId);
  assertCard(perms, "canEdit");

  for (const field of ["title", "description"] as const) {
    const base = input.base?.[field];
    if (input[field] !== undefined && base !== undefined && base !== card[field] && input[field] !== card[field]) {
      throw conflict("This card was changed by another user. Review their latest version before saving yours.", {
        field,
        current: card[field],
        revision: card.revision,
      });
    }
  }

  const patch: Partial<typeof cards.$inferInsert> = {};
  const activities: Array<{ type: Parameters<typeof logActivity>[1]["type"]; data: Record<string, unknown> }> = [];
  let significant: string | null = null;

  if (input.title !== undefined && input.title.trim() !== card.title) {
    patch.title = input.title.trim();
    activities.push({ type: "card.renamed", data: { from: card.title, to: patch.title } });
  }
  if (input.description !== undefined && input.description !== card.description) {
    patch.description = input.description;
    activities.push({ type: "card.description_changed", data: {} });
  }
  if (input.priority !== undefined && input.priority !== card.priority) {
    patch.priority = input.priority;
    activities.push({ type: "card.priority_changed", data: { from: card.priority, to: input.priority } });
  }
  if (input.startAt !== undefined) {
    const next = input.startAt ? new Date(input.startAt) : null;
    if ((next?.getTime() ?? null) !== (card.startAt?.getTime() ?? null)) {
      patch.startAt = next;
      activities.push({ type: "card.start_changed", data: { from: card.startAt?.toISOString() ?? null, to: next?.toISOString() ?? null } });
    }
  }
  if (input.dueAt !== undefined) {
    const next = input.dueAt ? new Date(input.dueAt) : null;
    if ((next?.getTime() ?? null) !== (card.dueAt?.getTime() ?? null)) {
      patch.dueAt = next;
      patch.dueReminderSentAt = null;
      activities.push({ type: "card.due_changed", data: { from: card.dueAt?.toISOString() ?? null, to: next?.toISOString() ?? null } });
      significant = next ? "changed the due date" : "removed the due date";
    }
  }
  {
    const start = patch.startAt !== undefined ? patch.startAt : card.startAt;
    const due = patch.dueAt !== undefined ? patch.dueAt : card.dueAt;
    if (start && due && start.getTime() > due.getTime()) throw invalid("The start can't be after the deadline.");
  }
  if (input.milestoneId !== undefined && input.milestoneId !== card.milestoneId) {
    if (input.milestoneId) await assertMilestone(db, input.milestoneId, card.projectId);
    patch.milestoneId = input.milestoneId;
    const names = input.milestoneId
      ? await db.select({ name: milestones.name }).from(milestones).where(eq(milestones.id, input.milestoneId))
      : [];
    activities.push({ type: "card.milestone_changed", data: { to: names[0]?.name ?? null } });
  }
  if (input.displayMode !== undefined) patch.displayMode = input.displayMode;
  if (input.estimateHours !== undefined) patch.estimateHours = input.estimateHours;
  if (input.links !== undefined) patch.links = input.links;

  if (Object.keys(patch).length === 0) return loadCardDetail(await requireCard(actor.userId, card.id));

  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx
      .update(cards)
      .set({ ...patch, revision: sql`${cards.revision} + 1`, lastActivityAt: now(), lastActivityById: actor.userId })
      .where(eq(cards.id, card.id));
    if (patch.title) {
      // A simple card's only deliverable is named after the card; keep them together.
      const active = await tx
        .select({ id: deliverables.id, name: deliverables.name })
        .from(deliverables)
        .where(and(eq(deliverables.cardId, card.id), isNull(deliverables.archivedAt)));
      if (active.length === 1 && active[0]!.name === card.title) {
        await tx.update(deliverables).set({ name: patch.title }).where(eq(deliverables.id, active[0]!.id));
      }
    }
    for (const a of activities) {
      await logActivity(tx, {
        studioId: access.studioId,
        projectId: card.projectId,
        cardId: card.id,
        actorId: actor.userId,
        type: a.type,
        data: a.data,
      });
    }
    if (significant) {
      const batch = new NotificationBatch();
      const data = cardNotificationData(access, { ...card, ...patch });
      if (patch.dueAt !== undefined) {
        // Card assignees, and whoever works on deliverables that follow the card's deadline.
        const work = await loadCardWork(tx, card.id);
        const inheriting = work.deliverables.filter((d) => !d.archived && !d.dueAt && d.state !== "APPROVED").flatMap((d) => work.teams.get(d.id)?.ids ?? []);
        batch.add({
          recipientIds: [...work.assigneeIds, ...inheriting],
          actorId: actor.userId,
          type: "DUE_CHANGED",
          studioId: access.studioId,
          projectId: card.projectId,
          cardId: card.id,
          data: { ...data, dueAt: patch.dueAt?.toISOString() ?? null, previousDueAt: card.dueAt?.toISOString() ?? null },
        });
      }
      batch.add({ recipientIds: await watcherIds(tx, card.id), actorId: actor.userId, type: "WATCHED_CARD", studioId: access.studioId, projectId: card.projectId, cardId: card.id, data: { ...data, change: significant } });
      fx.notify(await batch.send(tx));
    }
    fx.card(card.projectId, card.id);
  });
  fx.flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, card.id));
}

// ── Move ────────────────────────────────────────────────────────────────────

export interface MoveCardInput {
  cardId: string;
  toColumnId: string;
  afterCardId?: string | null;
  beforeCardId?: string | null;
  index?: number | null;
}

async function columnCards(tx: Executor, columnId: string, excludeId: string) {
  return tx
    .select({ id: cards.id, position: cards.position })
    .from(cards)
    .where(and(eq(cards.columnId, columnId), isNull(cards.archivedAt), ne(cards.id, excludeId)))
    .orderBy(asc(cards.position), asc(cards.createdAt));
}

export async function moveCard(actor: Actor, input: MoveCardInput): Promise<{ id: string; columnId: string; position: number }> {
  const { card, access, perms } = await requireCard(actor.userId, input.cardId);
  assertCard(perms, "canMove", "You don't have permission to move this card.");
  const fx = new Effects();
  const result = await db.transaction(async (tx) => {
    const target = await assertActiveColumn(tx, input.toColumnId, card.projectId);
    // Moving to another board of the same project carries the card's whole history with it.
    const boardChanged = target.boardId !== card.boardId;
    let list = await columnCards(tx, target.id, card.id);
    const index = resolveInsertIndex(list, { afterId: input.afterCardId, beforeId: input.beforeCardId, index: input.index });
    let position = positionBetween(list[index - 1]?.position, list[index]?.position);
    if (position === null) {
      const spaced = spacedPositions(list.length);
      for (let i = 0; i < list.length; i++) {
        await tx.update(cards).set({ position: spaced[i]! }).where(eq(cards.id, list[i]!.id));
      }
      list = await columnCards(tx, target.id, card.id);
      position = positionBetween(list[index - 1]?.position, list[index]?.position)!;
    }
    const columnChanged = target.id !== card.columnId;
    await tx
      .update(cards)
      .set({
        columnId: target.id,
        boardId: target.boardId,
        position,
        revision: sql`${cards.revision} + 1`,
        ...(columnChanged ? { lastActivityAt: now(), lastActivityById: actor.userId } : {}),
      })
      .where(eq(cards.id, card.id));
    if (columnChanged) {
      const [from] = await tx.select({ name: boardColumns.name }).from(boardColumns).where(eq(boardColumns.id, card.columnId));
      await logActivity(tx, {
        studioId: access.studioId,
        projectId: card.projectId,
        cardId: card.id,
        actorId: actor.userId,
        type: "card.moved",
        data: {
          fromColumnId: card.columnId,
          fromName: from?.name ?? null,
          toColumnId: target.id,
          toName: target.name,
          ...(boardChanged ? { fromBoardId: card.boardId, toBoardId: target.boardId, toBoardName: target.boardName } : {}),
        },
      });
      fx.notify(
        await notify(tx, {
          recipientIds: await watcherIds(tx, card.id),
          actorId: actor.userId,
          type: "WATCHED_CARD",
          studioId: access.studioId,
          projectId: card.projectId,
          cardId: card.id,
          data: { ...cardNotificationData(access, card), change: boardChanged ? `moved it to ${target.name} on the ${target.boardName} board` : `moved it to ${target.name}` },
        }),
      );
    }
    fx.card(card.projectId, card.id);
    return { id: card.id, columnId: target.id, position };
  });
  fx.flush(actor.clientId);
  return result;
}

/** Moves a card to another board of the same project, at the top of that board's first column. */
export async function moveCardToBoard(actor: Actor, input: { cardId: string; boardId: string }) {
  const { card } = await requireCard(actor.userId, input.cardId);
  const [column] = await db
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .innerJoin(boards, eq(boards.id, boardColumns.boardId))
    .where(and(eq(boards.id, input.boardId), eq(boards.projectId, card.projectId), isNull(boards.archivedAt), isNull(boardColumns.archivedAt)))
    .orderBy(asc(boardColumns.position))
    .limit(1);
  if (!column) throw invalid("That board has no columns yet. Add a column to it first.");
  return moveCard(actor, { cardId: card.id, toColumnId: column.id, index: 0 });
}

// ── Archive / delete ────────────────────────────────────────────────────────

export async function setCardArchived(actor: Actor, input: { cardId: string; archived: boolean }): Promise<CardSummaryDTO> {
  const { card, access, perms } = await requireCard(actor.userId, input.cardId);
  if (!perms.canArchive) throw forbidden("You don't have permission to archive this card.");
  const fx = new Effects();
  const updated = await db.transaction(async (tx) => {
    const patch: Partial<typeof cards.$inferInsert> = input.archived
      ? { archivedAt: now(), archivedById: actor.userId }
      : { archivedAt: null, archivedById: null };
    if (!input.archived) {
      // Restore into its old column when possible, otherwise the first active column.
      const [column] = await tx.select().from(boardColumns).where(eq(boardColumns.id, card.columnId));
      if (!column || column.archivedAt) {
        const [first] = await tx
          .select()
          .from(boardColumns)
          .where(and(eq(boardColumns.boardId, card.boardId), isNull(boardColumns.archivedAt)))
          .orderBy(asc(boardColumns.position))
          .limit(1);
        if (!first) throw invalid("Create a column before restoring cards.");
        patch.columnId = first.id;
      }
      patch.position = await nextCardPosition(patch.columnId ?? card.columnId, tx);
    }
    const [row] = await tx
      .update(cards)
      .set({ ...patch, revision: sql`${cards.revision} + 1` })
      .where(eq(cards.id, card.id))
      .returning();
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: card.projectId,
      cardId: card.id,
      actorId: actor.userId,
      type: input.archived ? "card.archived" : "card.restored",
    });
    // Everyone working on the card or its deliverables.
    const work = await loadCardWork(tx, card.id);
    const people = [...work.assigneeIds, ...work.deliverables.filter((d) => !d.archived).flatMap((d) => work.teams.get(d.id)?.ids ?? [])];
    fx.notify(
      await notify(tx, {
        recipientIds: people,
        actorId: actor.userId,
        type: "WORK_ARCHIVED",
        studioId: access.studioId,
        projectId: card.projectId,
        cardId: card.id,
        data: { ...cardNotificationData(access, card), restored: !input.archived },
      }),
    );
    // The card's notifications (and its deliverables') leave or rejoin inboxes and unread counts now.
    fx.notify(await inboxAudience(tx, { cardId: card.id }));
    fx.card(card.projectId, card.id);
    return row!;
  });
  fx.flush(actor.clientId);
  return summaryOf(updated, access);
}

/**
 * Irreversible. Only archived cards can be deleted, and the caller must type the card key. Files
 * another card still uses (a duplicate) are kept; the rest are removed by the durable cleanup.
 */
export async function deleteCardPermanently(actor: Actor, input: { cardId: string; confirm: string }) {
  const { card, access, perms } = await requireCard(actor.userId, input.cardId);
  if (!perms.canDelete) throw forbidden("Only studio owners and admins can permanently delete cards.");
  if (!card.archivedAt) throw invalid("Archive the card before deleting it permanently.");
  const key = cardKey(access, card);
  if (input.confirm.trim().toUpperCase() !== key.toUpperCase()) {
    throw invalid(`Type ${key} to confirm permanent deletion.`);
  }
  return purgeOne(actor, { type: "card", id: card.id });
}

// ── Duplicate ───────────────────────────────────────────────────────────────

export interface DuplicateOptions {
  toColumnId?: string;
  position?: number;
  keepTitle?: boolean;
  include: { assignees: boolean; labels: boolean; checklists: boolean; attachments: boolean };
}

/** Copies a card's working content. Comments and review history are intentionally not copied. */
export async function duplicateCardInTx(
  tx: Tx,
  actor: Actor,
  access: ProjectAccess,
  source: CardRow,
  options: DuplicateOptions,
): Promise<CardRow> {
  const number = await nextCardNumber(tx, source.projectId);
  const columnId = options.toColumnId ?? source.columnId;
  const createdAt = now();
  let position = options.position;
  if (position === undefined) {
    const list = await columnCards(tx, columnId, source.id);
    const index = list.findIndex((c) => c.position > source.position);
    position =
      positionBetween(source.position, index >= 0 ? list[index]!.position : null) ?? (await nextCardPosition(columnId, tx));
  }
  const [copy] = await tx
    .insert(cards)
    .values({
      projectId: source.projectId,
      boardId: source.boardId,
      columnId,
      number,
      title: options.keepTitle ? source.title : `${source.title} (copy)`,
      description: source.description,
      position,
      productionPosition: await nextProductionPosition(source.projectId, "TODO", tx),
      state: "NOT_SUBMITTED",
      priority: source.priority,
      displayMode: source.displayMode,
      startAt: source.startAt,
      dueAt: source.dueAt,
      milestoneId: source.milestoneId,
      estimateHours: source.estimateHours,
      links: source.links,
      createdById: actor.userId,
      lastActivityAt: createdAt,
      lastActivityById: actor.userId,
      createdAt,
    })
    .returning();
  const copyId = copy!.id;

  if (options.include.assignees) {
    const rows = await tx.select().from(cardAssignees).where(eq(cardAssignees.cardId, source.id));
    if (rows.length) {
      await tx.insert(cardAssignees).values(rows.map((r) => ({ cardId: copyId, userId: r.userId, assignedById: actor.userId, createdAt })));
    }
  }
  const reviewers = await tx.select().from(cardReviewers).where(eq(cardReviewers.cardId, source.id));
  if (reviewers.length) await tx.insert(cardReviewers).values(reviewers.map((r) => ({ cardId: copyId, userId: r.userId, createdAt })));
  if (options.include.labels) {
    const rows = await tx.select().from(cardLabels).where(eq(cardLabels.cardId, source.id));
    if (rows.length) await tx.insert(cardLabels).values(rows.map((r) => ({ cardId: copyId, labelId: r.labelId })));
  }
  if (options.include.checklists) {
    const lists = await tx.select().from(checklists).where(eq(checklists.cardId, source.id));
    for (const list of lists) {
      const [newList] = await tx
        .insert(checklists)
        .values({ cardId: copyId, title: list.title, position: list.position })
        .returning();
      const items = await tx.select().from(checklistItems).where(eq(checklistItems.checklistId, list.id));
      if (items.length) {
        await tx.insert(checklistItems).values(
          items.map((i) => ({ checklistId: newList!.id, cardId: copyId, text: i.text, isDone: false, position: i.position })),
        );
      }
    }
  }
  // Deliverables: structure, layout and connections are copied; with attachments, each
  // deliverable's current files become V1 of its copy (storage objects are shared).
  const sourceDeliverables = await tx
    .select()
    .from(deliverables)
    .where(and(eq(deliverables.cardId, source.id), isNull(deliverables.archivedAt)))
    .orderBy(asc(deliverables.position));
  const idMap = new Map<string, string>();
  for (const d of sourceDeliverables) {
    const [nd] = await tx
      .insert(deliverables)
      .values({
        cardId: copyId,
        projectId: source.projectId,
        number: d.number,
        name: d.name === source.title ? copy!.title : d.name,
        description: d.description,
        assetType: d.assetType,
        required: d.required,
        ownerId: options.include.assignees ? d.ownerId : null,
        reviewerId: d.reviewerId,
        startAt: d.startAt,
        dueAt: d.dueAt,
        canvasX: d.canvasX,
        canvasY: d.canvasY,
        canvasW: d.canvasW,
        canvasH: d.canvasH,
        position: d.position,
        createdById: actor.userId,
        createdAt,
      })
      .returning();
    idMap.set(d.id, nd!.id);
    if (!options.include.attachments || !d.currentVersionId) continue;
    const media = await tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.versionId, d.currentVersionId),
          eq(attachments.purpose, "VERSION"),
          isNull(attachments.archivedAt),
          inArray(attachments.status, ["READY", "PROCESSING"]),
        ),
      );
    if (!media.length) continue;
    const [version] = await tx
      .insert(assetVersions)
      .values({ cardId: copyId, deliverableId: nd!.id, versionNumber: 1, notes: `Copied from ${access.project.key}-${source.number}`, createdById: actor.userId, createdAt })
      .returning();
    for (const a of media) {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = a;
      await tx.insert(attachments).values({ ...rest, cardId: copyId, versionId: version!.id, deliverableId: nd!.id, uploadedById: a.uploadedById, createdAt });
    }
    await tx.update(deliverables).set({ currentVersionId: version!.id, state: "IN_PROGRESS" }).where(eq(deliverables.id, nd!.id));
    await recomputeDeliverableCover(tx, nd!.id);
  }
  if (!sourceDeliverables.length) await createPrimaryDeliverable(tx, copy!, actor.userId);
  const sourceLinks = await tx.select().from(deliverableLinks).where(eq(deliverableLinks.cardId, source.id));
  for (const l of sourceLinks) {
    const fromId = idMap.get(l.fromId);
    const toId = idMap.get(l.toId);
    if (fromId && toId) await tx.insert(deliverableLinks).values({ cardId: copyId, fromId, toId, type: l.type, fromPoint: l.fromPoint, toPoint: l.toPoint, note: l.note, createdById: actor.userId });
  }
  if (options.include.attachments) {
    const loose = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.cardId, source.id), eq(attachments.purpose, "CARD"), isNull(attachments.archivedAt), eq(attachments.status, "READY")));
    for (const a of loose) {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = a;
      await tx.insert(attachments).values({ ...rest, cardId: copyId, deliverableId: a.deliverableId ? (idMap.get(a.deliverableId) ?? null) : null, createdAt });
    }
  }
  await recomputeCardRollup(tx, copyId);
  await addWatchers(tx, copyId, [actor.userId]);
  await logActivity(tx, {
    studioId: access.studioId,
    projectId: source.projectId,
    cardId: copyId,
    actorId: actor.userId,
    type: "card.duplicated",
    data: { sourceCardId: source.id, sourceKey: `${access.project.key}-${source.number}` },
  });
  return copy!;
}

export async function duplicateCard(
  actor: Actor,
  input: { cardId: string; include: DuplicateOptions["include"] },
): Promise<CardSummaryDTO> {
  const { card, access } = await requireCard(actor.userId, input.cardId);
  assertProjectPermission(access, "card.create");
  if (input.include.assignees) {
    const hasOthers = (await db.select().from(cardAssignees).where(eq(cardAssignees.cardId, card.id))).some(
      (a) => a.userId !== actor.userId,
    );
    if (hasOthers) assertProjectPermission(access, "card.assign");
  }
  const fx = new Effects();
  const copy = await db.transaction(async (tx) => {
    const row = await duplicateCardInTx(tx, actor, access, card, { include: input.include });
    fx.card(card.projectId, row.id);
    return row;
  });
  fx.flush(actor.clientId);
  return summaryOf(copy, access);
}

// ── People & labels ─────────────────────────────────────────────────────────

export async function setAssignees(actor: Actor, input: { cardId: string; add?: string[]; remove?: string[] }) {
  const { card, access, perms, assigneeIds } = await requireCard(actor.userId, input.cardId);
  const add = [...new Set(input.add ?? [])].filter((id) => !assigneeIds.includes(id));
  const remove = [...new Set(input.remove ?? [])].filter((id) => assigneeIds.includes(id));
  const touchesOthers = [...add, ...remove].some((id) => id !== actor.userId);
  if (touchesOthers) assertCard(perms, "canAssign", "Only managers can assign other people.");
  else assertCard(perms, "canSelfAssign");

  const fx = new Effects();
  await db.transaction(async (tx) => {
    const valid = await filterProjectMembers(access.project, add, tx);
    if (valid.length !== add.length) throw invalid("Some people can't be assigned because they don't have access to this project.");
    if (valid.length) {
      await tx.insert(cardAssignees).values(valid.map((userId) => ({ cardId: card.id, userId, assignedById: actor.userId, createdAt: now() })));
      await addWatchers(tx, card.id, valid);
    }
    if (remove.length) {
      await tx.delete(cardAssignees).where(and(eq(cardAssignees.cardId, card.id), inArray(cardAssignees.userId, remove)));
    }
    for (const userId of valid) {
      await logActivity(tx, { studioId: access.studioId, projectId: card.projectId, cardId: card.id, actorId: actor.userId, type: "card.assignee_added", data: { userId } });
    }
    for (const userId of remove) {
      await logActivity(tx, { studioId: access.studioId, projectId: card.projectId, cardId: card.id, actorId: actor.userId, type: "card.assignee_removed", data: { userId } });
    }
    await touchCard(tx, card.id, actor.userId);
    const where = { actorId: actor.userId, studioId: access.studioId, projectId: card.projectId, cardId: card.id };
    fx.notify(
      await new NotificationBatch()
        .add({ ...where, recipientIds: valid, type: "ASSIGNED", data: { ...cardNotificationData(access, card), role: "responsible" } })
        .add({ ...where, recipientIds: remove, type: "UNASSIGNED", data: cardNotificationData(access, card) })
        .send(tx),
    );
    fx.card(card.projectId, card.id);
  });
  fx.flush(actor.clientId);
  return getCardDetail(actor, card.id);
}

export async function setReviewers(actor: Actor, input: { cardId: string; add?: string[]; remove?: string[] }) {
  const { card, access, perms } = await requireCard(actor.userId, input.cardId);
  assertCard(perms, "canAssign", "Only managers can choose reviewers.");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const current = new Set((await tx.select({ userId: cardReviewers.userId }).from(cardReviewers).where(eq(cardReviewers.cardId, card.id))).map((r) => r.userId));
    const add = (await filterProjectMembers(access.project, input.add ?? [], tx)).filter((id) => !current.has(id));
    const removed = (input.remove ?? []).filter((id) => current.has(id));
    if (add.length) {
      await tx.insert(cardReviewers).values(add.map((userId) => ({ cardId: card.id, userId, createdAt: now() }))).onConflictDoNothing();
      await addWatchers(tx, card.id, add);
    }
    if (input.remove?.length) {
      await tx.delete(cardReviewers).where(and(eq(cardReviewers.cardId, card.id), inArray(cardReviewers.userId, input.remove)));
    }
    for (const userId of add) {
      await logActivity(tx, { studioId: access.studioId, projectId: card.projectId, cardId: card.id, actorId: actor.userId, type: "card.reviewer_added", data: { userId } });
    }
    for (const userId of removed) {
      await logActivity(tx, { studioId: access.studioId, projectId: card.projectId, cardId: card.id, actorId: actor.userId, type: "card.reviewer_removed", data: { userId } });
    }
    await touchCard(tx, card.id, actor.userId);
    const where = { actorId: actor.userId, studioId: access.studioId, projectId: card.projectId, cardId: card.id };
    const data = { ...cardNotificationData(access, card), role: "reviewer" };
    fx.notify(
      await new NotificationBatch()
        .add({ ...where, recipientIds: add, type: "REVIEWER_ASSIGNED", data })
        .add({ ...where, recipientIds: removed, type: "UNASSIGNED", data })
        .send(tx),
    );
    fx.card(card.projectId, card.id, false);
  });
  fx.flush(actor.clientId);
  return getCardDetail(actor, card.id);
}

export async function setWatching(actor: Actor, input: { cardId: string; watching: boolean }) {
  const { card } = await requireCard(actor.userId, input.cardId);
  if (input.watching) await addWatchers(db, card.id, [actor.userId]);
  else await db.delete(cardWatchers).where(and(eq(cardWatchers.cardId, card.id), eq(cardWatchers.userId, actor.userId)));
  new Effects().card(card.projectId, card.id, false).flush(actor.clientId);
  return { watching: input.watching };
}

async function replaceLabels(tx: Executor, cardId: string, projectId: string, labelIds: string[]) {
  const unique = [...new Set(labelIds)];
  if (unique.length) {
    const valid = await tx.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, projectId), inArray(labels.id, unique)));
    if (valid.length !== unique.length) throw notFound("Label");
  }
  await tx.delete(cardLabels).where(eq(cardLabels.cardId, cardId));
  if (unique.length) await tx.insert(cardLabels).values(unique.map((labelId) => ({ cardId, labelId })));
}

export async function setLabels(actor: Actor, input: { cardId: string; labelIds: string[] }) {
  const { card, access, perms } = await requireCard(actor.userId, input.cardId);
  assertCard(perms, "canEdit");
  await db.transaction(async (tx) => {
    await replaceLabels(tx, card.id, card.projectId, input.labelIds);
    await logActivity(tx, { studioId: access.studioId, projectId: card.projectId, cardId: card.id, actorId: actor.userId, type: "card.labels_changed", data: { labelIds: input.labelIds } });
    await touchCard(tx, card.id, actor.userId);
  });
  new Effects().card(card.projectId, card.id).flush(actor.clientId);
  return getCardDetail(actor, card.id);
}


