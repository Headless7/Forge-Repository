import { and, asc, desc, eq, isNotNull, isNull, max } from "drizzle-orm";
import { permissionsFor } from "@/lib/permissions";
import { positionBetween, resolveInsertIndex, spacedPositions } from "@/lib/positions";
import type { BoardDTO, CardDisplayMode, ColumnDTO, LabelDTO, MilestoneDTO, ProjectDTO } from "@/lib/types";
import { assertProjectPermission, getProjectAccessBySlug, requireProject, type ProjectAccess, type ProjectRow } from "../access";
import { db, type Executor } from "../db";
import { boardColumns, boards, cards, labels, milestones, userBoardPrefs } from "../db/schema";
import { invalid, notFound } from "../errors";
import { now } from "../clock";
import { logActivity } from "./activity";
import { summarizeCards } from "./card-dto";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { listProjectMembers } from "./members-query";

export type ColumnRow = typeof boardColumns.$inferSelect;

export function projectToDTO(p: ProjectRow): ProjectDTO {
  return {
    id: p.id,
    studioId: p.studioId,
    name: p.name,
    slug: p.slug,
    key: p.key,
    description: p.description,
    icon: p.icon,
    color: p.color,
    background: p.background,
    visibility: p.visibility,
    defaultCardMode: p.defaultCardMode,
    settings: p.settings,
    archived: Boolean(p.archivedAt),
  };
}

export function columnToDTO(c: ColumnRow): ColumnDTO {
  return {
    id: c.id,
    name: c.name,
    icon: c.icon,
    color: c.color,
    position: c.position,
    defaultCardMode: c.defaultCardMode,
  };
}

export function milestoneToDTO(m: typeof milestones.$inferSelect): MilestoneDTO {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    dueAt: m.dueAt?.toISOString() ?? null,
    releasedAt: m.releasedAt?.toISOString() ?? null,
    archived: Boolean(m.archivedAt),
  };
}

export async function defaultBoardId(projectId: string, ex: Executor = db): Promise<string> {
  const rows = await ex
    .select({ id: boards.id })
    .from(boards)
    .where(and(eq(boards.projectId, projectId), isNull(boards.archivedAt)))
    .orderBy(asc(boards.createdAt))
    .limit(1);
  if (!rows[0]) throw notFound("Board");
  return rows[0].id;
}

async function buildBoard(access: ProjectAccess): Promise<BoardDTO> {
  const project = access.project;
  const boardId = await defaultBoardId(project.id);
  const [columnRows, cardRows, labelRows, milestoneRows, members, prefRows] = await Promise.all([
    db
      .select()
      .from(boardColumns)
      .where(and(eq(boardColumns.boardId, boardId), isNull(boardColumns.archivedAt)))
      .orderBy(asc(boardColumns.position)),
    db
      .select({ card: cards })
      .from(cards)
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .where(and(eq(cards.boardId, boardId), isNull(cards.archivedAt), isNull(boardColumns.archivedAt)))
      .orderBy(asc(cards.position)),
    db.select().from(labels).where(eq(labels.projectId, project.id)).orderBy(asc(labels.name)),
    db
      .select()
      .from(milestones)
      .where(eq(milestones.projectId, project.id))
      .orderBy(asc(milestones.position), asc(milestones.createdAt)),
    listProjectMembers(project),
    db
      .select()
      .from(userBoardPrefs)
      .where(and(eq(userBoardPrefs.userId, access.userId), eq(userBoardPrefs.boardId, boardId))),
  ]);

  const summaries = await summarizeCards(
    cardRows.map((r) => r.card),
    access.userId,
    new Map([[project.id, project.key]]),
  );

  return {
    project: projectToDTO(project),
    boardId,
    columns: columnRows.map(columnToDTO),
    cards: summaries,
    members,
    labels: labelRows.map((l): LabelDTO => ({ id: l.id, name: l.name, color: l.color })),
    milestones: milestoneRows.map(milestoneToDTO),
    viewer: { userId: access.userId, role: access.role, permissions: permissionsFor(access.role) },
    prefs: { collapsedColumnIds: prefRows[0]?.collapsedColumnIds ?? [], view: prefRows[0]?.view ?? "CATEGORY" },
  };
}

export async function getBoard(actor: Actor, projectId: string): Promise<BoardDTO> {
  const access = await requireProject(actor.userId, projectId, "project.view");
  return buildBoard(access);
}

export async function getBoardBySlug(actor: Actor, studioSlug: string, projectSlug: string): Promise<BoardDTO | null> {
  const access = await getProjectAccessBySlug(actor.userId, studioSlug, projectSlug);
  if (!access) return null;
  return buildBoard(access);
}

async function loadColumn(actor: Actor, columnId: string, ex: Executor = db) {
  const rows = await ex.select().from(boardColumns).where(eq(boardColumns.id, columnId)).limit(1);
  const column = rows[0];
  if (!column) throw notFound("Column");
  const access = await requireProject(actor.userId, column.projectId, undefined, ex);
  return { column, access };
}

async function activeColumns(boardId: string, ex: Executor, excludeId?: string) {
  const rows = await ex
    .select({ id: boardColumns.id, position: boardColumns.position })
    .from(boardColumns)
    .where(and(eq(boardColumns.boardId, boardId), isNull(boardColumns.archivedAt)))
    .orderBy(asc(boardColumns.position));
  return excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
}

/** Computes a position at `index`, rebalancing the list when floating-point gaps run out. */
async function columnPositionAt(
  boardId: string,
  ex: Executor,
  hints: { afterId?: string | null; beforeId?: string | null; index?: number | null },
  excludeId?: string,
): Promise<number> {
  let list = await activeColumns(boardId, ex, excludeId);
  const index = resolveInsertIndex(list, hints);
  let position = positionBetween(list[index - 1]?.position, list[index]?.position);
  if (position === null) {
    const spaced = spacedPositions(list.length);
    for (let i = 0; i < list.length; i++) {
      await ex.update(boardColumns).set({ position: spaced[i]! }).where(eq(boardColumns.id, list[i]!.id));
    }
    list = await activeColumns(boardId, ex, excludeId);
    position = positionBetween(list[index - 1]?.position, list[index]?.position)!;
  }
  return position;
}

export async function createColumn(
  actor: Actor,
  input: {
    projectId: string;
    name: string;
    icon?: string | null;
    color?: string | null;
    defaultCardMode?: CardDisplayMode | null;
    afterColumnId?: string | null;
    index?: number | null;
  },
): Promise<ColumnDTO> {
  const access = await requireProject(actor.userId, input.projectId, "column.manage");
  const fx = new Effects();
  const column = await db.transaction(async (tx) => {
    const boardId = await defaultBoardId(access.project.id, tx);
    const position = await columnPositionAt(boardId, tx, { afterId: input.afterColumnId, index: input.index });
    const [row] = await tx
      .insert(boardColumns)
      .values({
        boardId,
        projectId: access.project.id,
        name: input.name.trim(),
        icon: input.icon ?? null,
        color: input.color ?? null,
        defaultCardMode: input.defaultCardMode ?? null,
        position,
        createdById: actor.userId,
      })
      .returning();
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: access.project.id,
      actorId: actor.userId,
      type: "column.created",
      data: { columnId: row!.id, columnName: row!.name },
    });
    fx.project(access.project.id);
    return row!;
  });
  fx.flush(actor.clientId);
  return columnToDTO(column);
}

export async function updateColumn(
  actor: Actor,
  input: {
    columnId: string;
    name?: string;
    icon?: string | null;
    color?: string | null;
    defaultCardMode?: CardDisplayMode | null;
  },
): Promise<ColumnDTO> {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "column.manage");
  const patch: Partial<ColumnRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.color !== undefined) patch.color = input.color;
  if (input.defaultCardMode !== undefined) patch.defaultCardMode = input.defaultCardMode;
  const fx = new Effects();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(boardColumns).set(patch).where(eq(boardColumns.id, column.id)).returning();
    if (patch.name && patch.name !== column.name) {
      await logActivity(tx, {
        studioId: access.studioId,
        projectId: access.project.id,
        actorId: actor.userId,
        type: "column.renamed",
        data: { columnId: column.id, from: column.name, to: patch.name },
      });
    }
    return row!;
  });
  fx.project(access.project.id).flush(actor.clientId);
  return columnToDTO(updated);
}

export async function moveColumn(
  actor: Actor,
  input: { columnId: string; afterColumnId?: string | null; beforeColumnId?: string | null; index?: number | null },
): Promise<ColumnDTO> {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "column.manage");
  const updated = await db.transaction(async (tx) => {
    const position = await columnPositionAt(
      column.boardId,
      tx,
      { afterId: input.afterColumnId, beforeId: input.beforeColumnId, index: input.index },
      column.id,
    );
    const [row] = await tx.update(boardColumns).set({ position }).where(eq(boardColumns.id, column.id)).returning();
    return row!;
  });
  new Effects().project(access.project.id).flush(actor.clientId);
  return columnToDTO(updated);
}

export async function setColumnArchived(actor: Actor, input: { columnId: string; archived: boolean }) {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "column.manage");
  await db.transaction(async (tx) => {
    const patch = input.archived
      ? { archivedAt: now() }
      : { archivedAt: null, position: await columnPositionAt(column.boardId, tx, {}, column.id) };
    await tx.update(boardColumns).set(patch).where(eq(boardColumns.id, column.id));
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: access.project.id,
      actorId: actor.userId,
      type: input.archived ? "column.archived" : "column.restored",
      data: { columnId: column.id, columnName: column.name },
    });
  });
  new Effects().project(access.project.id).flush(actor.clientId);
  return { ok: true };
}

/** Permanently removes an empty column (columns holding cards must be archived instead). */
export async function deleteColumn(actor: Actor, input: { columnId: string }) {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "project.update");
  const remaining = await db.select({ id: cards.id }).from(cards).where(eq(cards.columnId, column.id)).limit(1);
  if (remaining.length) throw invalid("Only empty columns can be deleted. Archive the column instead, or move its cards first.");
  await db.delete(boardColumns).where(eq(boardColumns.id, column.id));
  new Effects().project(access.project.id).flush(actor.clientId);
  return { ok: true };
}

export async function duplicateColumn(actor: Actor, input: { columnId: string; withCards: boolean }): Promise<ColumnDTO> {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "column.manage");
  const { duplicateCardInTx } = await import("./cards");
  const fx = new Effects();
  const copy = await db.transaction(async (tx) => {
    const position = await columnPositionAt(column.boardId, tx, { afterId: column.id });
    const [row] = await tx
      .insert(boardColumns)
      .values({
        boardId: column.boardId,
        projectId: column.projectId,
        name: `${column.name} (copy)`,
        icon: column.icon,
        color: column.color,
        defaultCardMode: column.defaultCardMode,
        position,
        createdById: actor.userId,
      })
      .returning();
    if (input.withCards) {
      const sourceCards = await tx
        .select()
        .from(cards)
        .where(and(eq(cards.columnId, column.id), isNull(cards.archivedAt)))
        .orderBy(asc(cards.position));
      for (const source of sourceCards) {
        await duplicateCardInTx(tx, actor, access, source, {
          toColumnId: row!.id,
          position: source.position,
          keepTitle: true,
          include: { assignees: true, labels: true, checklists: true, attachments: true },
        });
      }
    }
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: access.project.id,
      actorId: actor.userId,
      type: "column.duplicated",
      data: { columnId: row!.id, sourceColumnId: column.id, columnName: row!.name },
    });
    return row!;
  });
  fx.project(access.project.id).flush(actor.clientId);
  return columnToDTO(copy);
}

export async function setColumnCollapsed(actor: Actor, input: { columnId: string; collapsed: boolean }) {
  const { column } = await loadColumn(actor, input.columnId);
  const existing = await db
    .select()
    .from(userBoardPrefs)
    .where(and(eq(userBoardPrefs.userId, actor.userId), eq(userBoardPrefs.boardId, column.boardId)));
  const set = new Set(existing[0]?.collapsedColumnIds ?? []);
  if (input.collapsed) set.add(column.id);
  else set.delete(column.id);
  const collapsedColumnIds = [...set];
  await db
    .insert(userBoardPrefs)
    .values({ userId: actor.userId, boardId: column.boardId, collapsedColumnIds })
    .onConflictDoUpdate({ target: [userBoardPrefs.userId, userBoardPrefs.boardId], set: { collapsedColumnIds } });
  return { collapsedColumnIds };
}

/** Remembers whether this person looks at the board by category or by production stage. */
export async function setBoardView(actor: Actor, input: { projectId: string; view: "CATEGORY" | "PRODUCTION" }) {
  const access = await requireProject(actor.userId, input.projectId, "project.view");
  const boardId = await defaultBoardId(access.project.id);
  await db
    .insert(userBoardPrefs)
    .values({ userId: actor.userId, boardId, view: input.view })
    .onConflictDoUpdate({ target: [userBoardPrefs.userId, userBoardPrefs.boardId], set: { view: input.view } });
  return { view: input.view };
}

export async function listArchived(actor: Actor, projectId: string) {
  const access = await requireProject(actor.userId, projectId, "project.view");
  const boardId = await defaultBoardId(projectId);
  const [columnRows, cardRows] = await Promise.all([
    db
      .select()
      .from(boardColumns)
      .where(and(eq(boardColumns.boardId, boardId), isNotNull(boardColumns.archivedAt)))
      .orderBy(desc(boardColumns.archivedAt)),
    db
      .select()
      .from(cards)
      .where(and(eq(cards.projectId, projectId), isNotNull(cards.archivedAt)))
      .orderBy(desc(cards.archivedAt))
      .limit(500),
  ]);
  return {
    columns: columnRows.map((c) => ({ ...columnToDTO(c), archivedAt: c.archivedAt!.toISOString() })),
    cards: await summarizeCards(cardRows, actor.userId, new Map([[projectId, access.project.key]])),
  };
}

export async function nextCardPosition(columnId: string, ex: Executor, where: "top" | "bottom" = "bottom") {
  if (where === "bottom") {
    const rows = await ex.select({ value: max(cards.position) }).from(cards).where(eq(cards.columnId, columnId));
    return positionBetween(rows[0]?.value ?? null, null)!;
  }
  const rows = await ex
    .select({ position: cards.position })
    .from(cards)
    .where(and(eq(cards.columnId, columnId), isNull(cards.archivedAt)))
    .orderBy(asc(cards.position))
    .limit(1);
  return positionBetween(null, rows[0]?.position ?? null)!;
}
